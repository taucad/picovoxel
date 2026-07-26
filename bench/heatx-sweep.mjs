// R11 (real-world-subjects blueprint) — the HelixHeatX voxel-size sweep against
// LEAP71's published table (README table.png: "on a MacBook Air", timing the
// whole Task INCLUDING viewer previews/screenshots + STL write; we time the
// headless equivalent — geometry gen + voxel pipeline + meshing + STL bytes —
// so the previews delta runs in the published numbers' favour).
//
// Separate from run.mjs because the fine cells are minutes each: ONE run per
// (size, build), with single↔multi cross-build identity (volume hex + STL
// FNV-1a + byte count) as the integrity check instead of repeat-stability.
//
// Usage: node bench/heatx-sweep.mjs [--sizes 1.0,0.5] [--builds single,multi]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPico as createSingle } from '../src/index.ts';
import { createPico as createMulti } from '../src/multi.ts';
import { task } from '../examples/helixheatx/run.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = () => performance.now();

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sizes = (argValue('--sizes') ?? '1.0,0.9,0.8,0.7,0.6,0.5').split(',').map(Number);
const builds = (argValue('--builds') ?? 'single,multi').split(',');

/** The published cells we can quote from context (the full table is pixels in upstream's README). */
const PUBLISHED = {
  1: { seconds: 34, stlMB: 94 },
  0.5: { seconds: 98, stlMB: 502 },
};

const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};
const fnv1a = (typedArray) => {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

const git = (...args) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
const wasmBytes = readFileSync(join(HERE, 'src/pico.wasm'));
const fingerprint = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  ramGiB: Math.round(totalmem() / 2 ** 30),
  os: `${platform()} ${release()}`,
  node: process.version,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
  gitSha: git('rev-parse', '--short', 'HEAD'),
  date: new Date().toISOString(),
  startLoad: loadavg()[0],
};

console.log(
  `HelixHeatX sweep on ${fingerprint.cpu} (${fingerprint.cores} cores), load ${fingerprint.startLoad.toFixed(2)}`,
);
console.log(
  'size(mm)  build   task(s)  author(ms)  mesh(s)  stl(s)  stl(MB)  heap(GiB) volumeHex        published(s/MB)',
);

const rows = [];
for (const voxelSize of sizes) {
  const identities = {};
  for (const build of builds) {
    const make = build === 'multi' ? createMulti : createSingle;
    const session = await make({ voxelSize });
    const t0 = now();
    const { voxels, authorMs, constructMs, kernelTimings, unattributedMs } = task(session);
    const taskMs = now() - t0;
    const t1 = now();
    const mesh = voxels.toMesh();
    const meshMs = now() - t1;
    const t2 = now();
    const stl = mesh.toStl();
    const stlMs = now() - t2;
    const row = {
      voxelSize,
      build,
      threads: (session.module.PThread?.runningWorkers.length ?? 0) + 1,
      taskMs,
      constructMs,
      authorMs,
      kernelTimings,
      unattributedMs,
      meshMs,
      stlMs,
      stlBytes: stl.length,
      // B6 (SK-0.1): wasm linear memory never shrinks, so its size here IS the
      // run's peak. The allocator changes effective capacity (mimalloc's segment
      // caching holds freed spans), which moves the 4 GB wasm32 OOM boundary.
      peakHeapBytes: session.module.HEAPU32.buffer.byteLength,
      volumeHex: hexFloat(voxels.volume),
      stlFnv: fnv1a(stl),
      triangles: mesh.triangleCount,
    };
    session.dispose();
    rows.push(row);
    identities[build] = { volumeHex: row.volumeHex, stlFnv: row.stlFnv, stlBytes: row.stlBytes };
    const published = PUBLISHED[String(voxelSize)];
    console.log(
      `${voxelSize.toFixed(1).padEnd(9)} ${build.padEnd(7)} ${(taskMs / 1000).toFixed(1).padEnd(8)} ` +
        `${authorMs.toFixed(0).padEnd(11)} ${(meshMs / 1000).toFixed(1).padEnd(8)} ${(stlMs / 1000).toFixed(1).padEnd(7)} ` +
        `${(row.stlBytes / 1e6).toFixed(1).padEnd(8)} ${(row.peakHeapBytes / 2 ** 30).toFixed(2).padEnd(7)} ` +
        `${row.volumeHex.padEnd(16)} ` +
        (published ? `${published.seconds}s / ${published.stlMB}MB` : '—'),
    );
  }
  if (identities.single && identities.multi) {
    const same = JSON.stringify(identities.single) === JSON.stringify(identities.multi);
    if (!same) {
      console.error(
        `IDENTITY DRIFT at ${voxelSize}mm: single ${JSON.stringify(identities.single)} vs multi ${JSON.stringify(identities.multi)}`,
      );
      process.exit(1);
    }
    console.log(`          identity single≡multi OK`);
  }
}

const resultsDir = join(HERE, 'bench/results');
mkdirSync(resultsDir, { recursive: true });
const fileName = `heatx-sweep-${fingerprint.date.slice(0, 10)}-${fingerprint.gitSha}.json`;
writeFileSync(join(resultsDir, fileName), JSON.stringify({ fingerprint, rows }, null, 2) + '\n');
console.log(`\nwrote bench/results/${fileName}`);
