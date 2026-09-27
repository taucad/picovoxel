#!/usr/bin/env node
// Records one CI-built wasm variant: emcc version, raw/gzip-9/brotli-11 bytes and
// sha256 for the glue and the module, written to build/wasm-<variant>.json (it
// travels in the wasm-<variant> artifact) and to the job summary. Then gates the
// module against its byte ceilings (create-repo §5.1): a breach fails the wasm
// job. Admission is a ceiling edit in the pull request that causes the growth,
// with the new measurement and its cause beside it.
//
// Raw is the artifact itself and has no allowance: the link is not
// byte-reproducible (the sha256 moves on a rebuild with no source change), but
// its SIZE has not moved across eleven CI builds, from the first two (runs
// 36306325041 at fe37d8f and 36311419247 at c8c6d0f) through main 7040437 (run
// 36344828928). The compressed figures are what this host's zlib and brotli make
// of those bytes and they do move with the bytes (brotli-11 over the same raw
// size: serial 540,148 or 540,302, multi 568,588 or 568,874), so each ceiling is
// the largest CI measurement plus 0.5%, as in NanoRaster's check-wasm-size.mjs.
//
// Usage: EMCC_VERSION="$(emcc --version | head -n1)" node scripts/wasm-manifest.mjs <serial|multi>

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CEILINGS = {
  // emcc 5.0.1, CI: 6,061,993 raw in every build; gzip-9 1,277,937 and
  // brotli-11 540,302 at most, each +0.5%. Local builds at 3db6a0c measured
  // 6,062,222 raw (another host's link).
  serial: { raw: 6_061_993, gzip: 1_284_327, brotli: 543_004 },
  // emcc 5.0.1, CI: 6,127,793 raw in every build; gzip-9 1,317,019 and
  // brotli-11 568,874 at most, each +0.5%. The binary committed at 3db6a0c
  // until #11 measured 6,128,010 raw (a local link, with builder paths).
  multi: { raw: 6_127_793, gzip: 1_323_605, brotli: 571_719 },
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

/**
 * The measurements over a ceiling, as human-readable strings.
 * @param {keyof typeof CEILINGS} variant
 * @param {{ raw: number, gzip: number, brotli: number }} wasm
 */
export const overCeilings = (variant, wasm) =>
  Object.entries(CEILINGS[variant])
    .filter(([kind, limit]) => wasm[kind] > limit)
    .map(([kind, limit]) => `${kind} ${wasm[kind]} > ${limit}`);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
  const breaches = overCeilings(variant, files[`${base}.wasm`]);
  for (const breach of breaches) {
    process.stdout.write(
      `::error title=wasm byte ceiling::${base}.wasm ${breach}; raise the ceiling in scripts/wasm-manifest.mjs with the measured cause\n`,
    );
  }
  if (breaches.length > 0) process.exitCode = 1;
}
