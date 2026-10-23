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
// its SIZE does not move between builds of one tree: it held across twelve CI
// builds from the first two (runs 36306325041 at fe37d8f and 36311419247 at
// c8c6d0f) through main 5b45035, and across the three since the PruneFill fix.
// The compressed figures are what this host's zlib and brotli make of those
// bytes and they do move with the bytes (brotli-11 over one raw size: serial
// 540,207 to 540,950), so each ceiling is the largest CI measurement plus 0.5%,
// as in NanoRaster's check-wasm-size.mjs.
//
// Usage: EMCC_VERSION="$(emcc --version | head -n1)" node scripts/wasm-manifest.mjs <serial|multi>

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CEILINGS = {
  // emcc 5.0.1, local build of this tree (the same toolchain gave the CI figure
  // exactly before): 6,276,985 raw, +205,757 over 6,071,228. Measured causes:
  // the tape hoisting, the 3-D mask footprint, one-measure properties and the
  // heap-view glue +11,927; the OpenVDB exact adaptive merge (patches/openvdb/0002)
  // +15,242; adaptive meshing (0006), the runtime patches 0007-0009, the
  // fast-sweeping offset engine and the sub-voxel raycast the remaining
  // +178,588. gzip-9 1,311,196 and brotli-11 559,000; the compressed ceilings
  // are those plus 0.5%. Then 6,287,200 raw (+10,215, CI and a local build
  // agree): the fast-sweeping engine's moving-side re-sweep (ForgetMovingSide,
  // KeepLowerBounds) and its containment guard, which instantiates OpenVDB's
  // csgUnion and csgIntersection in src/pico-offset.cpp; gzip-9 1,315,332 and
  // brotli-11 559,928, plus 0.5%.
  serial: { raw: 6_287_200, gzip: 1_321_909, brotli: 562_728 },
  // emcc 5.0.1, the same local build: 6,335,092 raw (+198,128); gzip-9 1,355,263
  // and brotli-11 589,958, plus 0.5% for the compressed ceilings. Then 6,345,219
  // raw (+10,127, same cause as serial); gzip-9 1,357,291 and brotli-11 591,620,
  // plus 0.5%.
  multi: { raw: 6_345_219, gzip: 1_364_077, brotli: 594_578 },
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
