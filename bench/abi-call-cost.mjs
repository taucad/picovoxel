// SK-0.2 — per-call ABI crossing cost, three ways, in ONE process.
//
//   ccall  — emscripten's slow path (module.cwrap with a bigint in argTypes falls
//            back to ccall: string-keyed getCFunc + per-call arg loop + stack save).
//   direct — module._Name, the raw WebAssembly export function.
//   bound  — whatever scripts/generate-raw.mjs currently emits.
//
// Measuring all three back-to-back makes the attribution paired: `bound` sits on
// `ccall` before the SK-0.2 repair and on `direct` after, and the ccall−direct gap
// is measured on the same machine, same load, same JIT state, not across runs.
// Kept as a regression canary — a future generator change that reintroduces
// marshalling shows up as `bound` drifting off `direct`.
//
// Method: min-of-N over RUNS runs of ITERS iterations (min is the right estimator
// for a floor measurement — noise only ever adds). Every window is >= 5 ms.
//
// Usage: node bench/abi-call-cost.mjs [--out FILE] [--runs N] [--iters N]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPico } from '../src/index.ts';
import { loadPicoRaw } from '../src/raw.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const RUNS = Number(arg('--runs', 9));
const ITERS = Number(arg('--iters', 200_000));
const OUT = arg('--out', null);

const wasmBytes = readFileSync(join(HERE, 'src/pico.wasm'));
const fingerprint = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  ramGiB: Math.round(totalmem() / 2 ** 30),
  os: `${platform()} ${release()}`,
  node: process.version,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
  wasmBytes: wasmBytes.length,
  date: new Date().toISOString(),
  startLoad: loadavg()[0],
  runs: RUNS,
  iters: ITERS,
};

const { module, raw } = await loadPicoRaw();
const lib = raw.Library_hCreateInstance(0.5);
const scratch = module._malloc(64);
const writeVec3 = (p, x, y, z) => {
  module.HEAPF32[(p >> 2) + 0] = x;
  module.HEAPF32[(p >> 2) + 1] = y;
  module.HEAPF32[(p >> 2) + 2] = z;
};
writeVec3(scratch, 0, 0, 0);
writeVec3(scratch + 12, 1, 0.5, 0.25);

/** Runs `body(iters)` RUNS times; returns ns/call at the minimum, plus the window. */
function floor(body) {
  const windows = [];
  for (let run = 0; run < RUNS; run++) {
    const start = process.hrtime.bigint();
    body(ITERS);
    windows.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const measured = windows.slice(2); // 2 warmup runs discarded (JIT tier-up)
  const minMs = Math.min(...measured);
  return {
    nsPerCall: +((minMs * 1e6) / ITERS).toFixed(2),
    minWindowMs: +minMs.toFixed(3),
    maxWindowMs: +Math.max(...measured).toFixed(3),
    windowsMs: windows.map((w) => +w.toFixed(3)),
  };
}

const results = {};
const record = (name, variants) => {
  results[name] = variants;
  for (const [variant, r] of Object.entries(variants)) {
    console.log(
      `  ${name.padEnd(28)} ${variant.padEnd(8)} ${String(r.nsPerCall).padStart(8)} ns/call  (window ${r.minWindowMs} ms)`,
    );
  }
};

// ── Lattice_AddBeam — the headline hot site (~10^5 crossings per HeatX) ──
// A fresh lattice per run: the beam vector must not carry growth across runs.
const addBeamVariants = {};
for (const [variant, fn] of [
  [
    'ccall',
    module.cwrap('Lattice_AddBeam', null, [
      'bigint',
      'bigint',
      'number',
      'number',
      'number',
      'number',
      'boolean',
    ]),
  ],
  ['direct', module._Lattice_AddBeam],
  // oxlint-disable-next-line typescript/unbound-method -- raw bindings are free functions that never read this; a wrapper would add a call to the measured path
  ['bound', raw.Lattice_AddBeam],
]) {
  let lattice = 0n;
  addBeamVariants[variant] = floor((iters) => {
    lattice = raw.Lattice_hCreate(lib);
    for (let i = 0; i < iters; i++) fn(lib, lattice, scratch, scratch + 12, 0.5, 0.5, true);
    raw.Lattice_Destroy(lib, lattice);
  });
}
record('Lattice_AddBeam', addBeamVariants);

// ── Lattice_bIsValid — the boolean-return path (the one shape that still needs a
// JS wrapper after the repair: wasm returns i32, the API promises boolean). ──
const lattice = raw.Lattice_hCreate(lib);
record(
  'Lattice_bIsValid',
  Object.fromEntries(
    [
      ['ccall', module.cwrap('Lattice_bIsValid', 'boolean', ['bigint', 'bigint'])],
      ['direct', module._Lattice_bIsValid],
      // oxlint-disable-next-line typescript/unbound-method -- raw bindings are free functions that never read this; a wrapper would add a call to the measured path
      ['bound', raw.Lattice_bIsValid],
    ].map(([variant, fn]) => [
      variant,
      floor((iters) => {
        for (let i = 0; i < iters; i++) fn(lib, lattice);
      }),
    ]),
  ),
);

// ── Voxels_bIsEmpty on an empty-ish field — near-zero C++ work, so this row is
// the pure-crossing floor the AddBeam number decomposes against. ──
const voxels = raw.Voxels_hCreate(lib);
record(
  'Voxels_bIsEmpty',
  Object.fromEntries(
    [
      ['ccall', module.cwrap('Voxels_bIsEmpty', 'boolean', ['bigint', 'bigint'])],
      ['direct', module._Voxels_bIsEmpty],
      // oxlint-disable-next-line typescript/unbound-method -- raw bindings are free functions that never read this; a wrapper would add a call to the measured path
      ['bound', raw.Voxels_bIsEmpty],
    ].map(([variant, fn]) => [
      variant,
      floor((iters) => {
        for (let i = 0; i < iters; i++) fn(lib, voxels);
      }),
    ]),
  ),
);

raw.Voxels_Destroy(lib, voxels);
raw.Lattice_Destroy(lib, lattice);

// ── The facade site callers actually pay: session.createLattice().addBeam(...).
// Same crossing plus the wrapper's option destructuring, scratch writes and the
// per-call `guard` closure — the honest number for HeatX-shaped authoring code. ──
const pico = await createPico({ voxelSize: 0.5 });
const start = [0, 0, 0];
const end = [1, 0.5, 0.25];
const facade = floor((iters) => {
  const lat = pico.createLattice();
  for (let i = 0; i < iters; i++) lat.addBeam({ start, end, radius: 0.5 });
  lat.dispose();
});
record('lattice.addBeam (facade)', { bound: facade });
pico.dispose();

raw.Library_DestroyInstance(lib);
module._free(scratch);

const payload = { spike: 'SK-0.2', fingerprint, endLoad: loadavg()[0], results };
if (OUT) {
  mkdirSync(dirname(resolve(HERE, OUT)), { recursive: true });
  writeFileSync(resolve(HERE, OUT), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
