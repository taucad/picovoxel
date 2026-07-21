// Manual A/B harness for TP6 (MPR-style interval pruning in the tape fill).
//
// Usage: node bench/tape-prune-ab.mjs <moduleDir> <label>
//   moduleDir holds a pico.mjs/.wasm + pico-multi.mjs/.wasm pair — src/
//   for the current build, a preserved pre-change copy for the baseline.
//
// Ratios are only meaningful for back-to-back runs under the same machine
// load; this script records loadavg per block and deliberately does NOT touch
// bench/BENCHMARKS.md (that baseline only moves on a quiet machine via
// bench/run.mjs --update). Identity oracles: hex-float volume must be
// bit-stable across repeats AND across module dirs — pruning that changes a
// single voxel fails here before it fails a test.
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPicoSession } from '../src/session.ts';

const moduleDir = resolve(process.argv[2] ?? 'src');
const label = process.argv[3] ?? moduleDir;

const f64hex = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ── fixtures ──

const GYROID_SCALE = (2 * Math.PI) / 10;
const gyroid = ['-', ['abs', ['+',
  ['*', ['sin', ['*', 'x', GYROID_SCALE]], ['cos', ['*', 'y', GYROID_SCALE]]],
  ['*', ['sin', ['*', 'y', GYROID_SCALE]], ['cos', ['*', 'z', GYROID_SCALE]]],
  ['*', ['sin', ['*', 'z', GYROID_SCALE]], ['cos', ['*', 'x', GYROID_SCALE]]]]], 0.4];

// Solid sphere — interior/exterior blocks dominate: the pure block-pruning case.
const sphere = ['-', ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]], 10.5];

// 64-sphere union (4×4×4 lattice, r 1.6, pitch 6): a min-fold 63 deep — the
// tape-shortening case; per-block tapes should collapse to the nearby spheres.
const spheres = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
  const [cx, cy, cz] = [i, j, k].map((v) => -9 + 6 * v);
  spheres.push(['-', ['sqrt', ['+',
    ['pow', ['-', 'x', cx], 2], ['pow', ['-', 'y', cy], 2], ['pow', ['-', 'z', cz], 2]]], 1.6]);
}
const union64 = ['min', ...spheres];

const BOUNDS = { boundsMin: [-12, -12, -12], boundsMax: [12, 12, 12] };
const FIXTURES = [
  { name: 'gyroid @0.1mm', voxelSize: 0.1, sdf: gyroid },
  { name: 'sphere @0.1mm', voxelSize: 0.1, sdf: sphere },
  { name: 'union64 @0.25mm', voxelSize: 0.25, sdf: union64 },
];

// ── run ──

const glue = async (file) => (await import(pathToFileURL(resolve(moduleDir, file)).href)).default;
const VARIANTS = [
  { name: 'single', file: 'pico.mjs' },
  { name: 'multi', file: 'pico-multi.mjs' },
];

console.log(`# tape-prune A/B — ${label}`);
console.log(`modules: ${moduleDir}`);
for (const variant of VARIANTS) {
  const factory = await glue(variant.file);
  console.log(`\n## ${variant.name}  (loadavg ${loadavg().map((v) => v.toFixed(2)).join(' ')})`);
  for (const fixture of FIXTURES) {
    const pk = await createPicoSession(factory, { voxelSize: fixture.voxelSize });
    try {
      if (variant.name === 'multi') {
        // Mirror src/multi.ts createPico: oneTBB launches workers on the
        // first parallel region and completes the handshake only while the
        // main thread is off the wasm stack — without this, TBB serializes
        // silently and multi measures identical to single.
        const warm = pk.createVoxels({ shape: 'sphere', radius: 2 });
        warm.offset({ distance: 0.5 });
        warm.dispose();
        await new Promise((resume) => setTimeout(resume, 100));
      }
      const times = [];
      let volumeHex;
      let meshNote = '';
      for (let rep = 0; rep < 6; rep++) {
        const t0 = performance.now();
        const voxels = pk.createVoxels({ shape: 'implicit', ...BOUNDS, sdf: fixture.sdf });
        const ms = performance.now() - t0;
        const hex = f64hex(voxels.volume);
        if (rep === 5) {
          const mesh = voxels.toMesh();
          meshNote = ` tris=${mesh.triangleCount}`;
          mesh.dispose();
        }
        voxels.dispose();
        if (rep === 0) continue; // warmup
        times.push(ms);
        volumeHex ??= hex;
        if (volumeHex !== hex) throw new Error(`volume drift within run: ${fixture.name} ${volumeHex} != ${hex}`);
      }
      const spread = `${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)}`;
      console.log(
        `${fixture.name.padEnd(16)} median ${median(times).toFixed(0).padStart(6)}ms  (min–max ${spread})  vol=0x${volumeHex}${meshNote}`,
      );
    } finally {
      pk.dispose();
    }
  }
}
console.log(`\nend loadavg ${loadavg().map((v) => v.toFixed(2)).join(' ')}`);
