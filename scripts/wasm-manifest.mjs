#!/usr/bin/env node
// Records one CI-built wasm variant: emcc version, raw/gzip-9/brotli-11 bytes and
// sha256 for the glue and the module, written to build/wasm-<variant>.json (it
// travels in the wasm-<variant> artifact) and to the job summary.
//
// Byte ceilings are REPORT-ONLY here (a ::warning::, never a failure); W4 (T4.5)
// makes them hard gates once two no-change CI rebuilds show whether the raw size
// moves. Origin of every ceiling: PicoVoxel close-out lane D §3.3, measured
// 2026-09-27 with Node 24.10 zlib on the committed/local builds at 3db6a0c. Raw
// allows +0.5% (the link is not byte-reproducible); compressed figures carry
// +0.5% for compressor-version spread.
//
// Usage: EMCC_VERSION="$(emcc --version | head -n1)" node scripts/wasm-manifest.mjs <serial|multi>

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CEILINGS = {
  // 6,062,222 / 1,278,117 / 540,335 measured (local build 2026-07-31, after 3db6a0c).
  serial: { raw: 6_092_534, gzip: 1_284_508, brotli: 543_037 },
  // 6,128,010 / 1,317,005 / 568,110 measured (committed at 3db6a0c, sha256 987da3b8d16a…).
  multi: { raw: 6_158_651, gzip: 1_323_591, brotli: 570_951 },
};

/** Byte counts and digest for one file. */
const measure = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  }).length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

/** The measurements over a ceiling, as human-readable strings. */
const overCeilings = (variant, wasm) =>
  Object.entries(CEILINGS[variant])
    .filter(([kind, limit]) => wasm[kind] > limit)
    .map(([kind, limit]) => `${kind} ${wasm[kind]} > ${limit}`);

const variant = process.argv[2];
if (!(variant in CEILINGS)) throw new Error('usage: wasm-manifest.mjs <serial|multi>');
const base = variant === 'multi' ? 'pico-multi' : 'pico';
const files = Object.fromEntries(
  [`${base}.mjs`, `${base}.wasm`].map((name) => [name, measure(readFileSync(join(ROOT, 'src', name)))]),
);
const manifest = { variant, emcc: process.env.EMCC_VERSION ?? null, files };
mkdirSync(join(ROOT, 'build'), { recursive: true });
writeFileSync(join(ROOT, 'build', `wasm-${variant}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

const rows = Object.entries(files).map(
  ([name, { raw, gzip, brotli, sha256 }]) => `| ${name} | ${raw} | ${gzip} | ${brotli} | \`${sha256}\` |`,
);
const summary = [
  `### wasm (${variant})`,
  '',
  `${manifest.emcc ?? 'emcc version not recorded'}`,
  '',
  '| File | Raw | gzip-9 | brotli-11 | sha256 |',
  '| --- | ---: | ---: | ---: | --- |',
  ...rows,
  '',
].join('\n');
process.stdout.write(`${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
for (const breach of overCeilings(variant, files[`${base}.wasm`])) {
  process.stdout.write(`::warning title=wasm byte ceiling (report-only until W4)::${base}.wasm ${breach}\n`);
}
