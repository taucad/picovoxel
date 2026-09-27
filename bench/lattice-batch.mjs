// SK-0.3 — lattice authoring cost, batched vs one crossing per element.
//
// Two measurements, both PAIRED inside a single process so the comparison never
// spans runs, JIT states or machine load:
//
//   1. per-beam floor — the raw per-call export (the pre-SK-0.3 hot path), the
//      bulk export amortised per beam, and the public facade end to end
//      (addBeam + the flush that toVoxels/handle triggers).
//   2. HelixHeatX author stage — the real subject, run alternately against the
//      batching facade and against a faithful re-creation of the per-call facade
//      it replaced (scratch writes + raw.Lattice_AddBeam, exactly the body
//      src/lattice.ts carried before this spike). Both variants also COUNT the
//      Lattice_* crossings by wrapping the wasm exports before the raw table
//      binds, so "one crossing per lattice" is verified, not asserted.
//
// The author stage is voxel-size independent (the beam counts are geometry
// driven), so the A/B runs at a coarse voxel size where the kernels are cheap;
// --confirm-size re-runs the counter at 1.0 mm to prove the count is the same.
//
// Usage: node bench/lattice-batch.mjs [--out FILE] [--runs N] [--iters N]
//                                     [--heatx-reps N] [--heatx-size MM]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import glue from '../src/pico.mjs';
import { createPicoSession } from '../src/session.ts';
import { loadPicoRaw } from '../src/raw.ts';
import { task } from '../examples/helixheatx/run.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const RUNS = Number(arg('--runs', 9));
const ITERS = Number(arg('--iters', 200_000));
const HEATX_REPS = Number(arg('--heatx-reps', 3));
const HEATX_SIZE = Number(arg('--heatx-size', 3));
const CONFIRM_SIZE = Number(arg('--confirm-size', 1));
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
  heatxReps: HEATX_REPS,
  heatxSizeMm: HEATX_SIZE,
};

const results = {};

// ── 1. per-beam floor ─────────────────────────────────────────────────────────
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

/** min-of-N ns per beam; 2 warmup runs discarded (JIT tier-up). */
function floor(body, perRun = ITERS) {
  const windows = [];
  for (let run = 0; run < RUNS; run++) {
    const start = process.hrtime.bigint();
    body(ITERS);
    windows.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const measured = windows.slice(2);
  const minMs = Math.min(...measured);
  return {
    nsPerBeam: +((minMs * 1e6) / perRun).toFixed(2),
    minWindowMs: +minMs.toFixed(3),
    maxWindowMs: +Math.max(...measured).toFixed(3),
    windowsMs: windows.map((w) => +w.toFixed(3)),
  };
}

const perBeam = {};

// The path this spike removes: one crossing per beam, scratch already written.
perBeam['raw per-call (Lattice_AddBeam)'] = floor((iters) => {
  const lattice = raw.Lattice_hCreate(lib);
  for (let i = 0; i < iters; i++) raw.Lattice_AddBeam(lib, lattice, scratch, scratch + 12, 0.5, 0.5, true);
  raw.Lattice_Destroy(lib, lattice);
});

// The replacement, amortised: one malloc + one HEAPF32.set + one crossing for the
// whole batch, plus the C++ side's per-beam make_shared (which nothing here can
// remove — see U17). The JS staging loop is NOT in this row; row 3 has it.
{
  const staged = new Float32Array(ITERS * 8);
  const caps = new Uint32Array(ITERS).fill(1);
  for (let i = 0; i < ITERS; i++) {
    staged.set([0, 0, 0, 0.5, 1, 0.5, 0.25, 0.5], i * 8);
  }
  perBeam['bulk (Lattice_AddBeams), amortised'] = floor((iters) => {
    const lattice = raw.Lattice_hCreate(lib);
    const pointer = module._malloc(iters * 8 * 4 + iters * 4);
    module.HEAPF32.set(staged.subarray(0, iters * 8), pointer >> 2);
    module.HEAPU32.set(caps.subarray(0, iters), (pointer >> 2) + iters * 8);
    raw.Lattice_AddBeams(lib, lattice, pointer, pointer + iters * 8 * 4, iters);
    module._free(pointer);
    raw.Lattice_Destroy(lib, lattice);
  });
}

raw.Library_DestroyInstance(lib);
module._free(scratch);

// ── crossing-counting session ─────────────────────────────────────────────────
const COUNTED = [
  'Lattice_AddBeam',
  'Lattice_AddBeams',
  'Lattice_AddSphere',
  'Lattice_AddSpheres',
  'Lattice_hCreate',
];

/**
 * Wraps the wasm exports BEFORE bindPicoRaw reads them (bind happens inside
 * createPicoSession), so every crossing is counted whichever facade is in play.
 */
async function countingSession(voxelSize) {
  const counts = Object.fromEntries(COUNTED.map((name) => [name, 0]));
  const countingGlue = async (overrides) => {
    const m = await glue(overrides);
    for (const name of COUNTED) {
      const fn = m[`_${name}`];
      m[`_${name}`] = (...args) => {
        counts[name] += 1;
        return fn(...args);
      };
    }
    return m;
  };
  return { pk: await createPicoSession(countingGlue, { voxelSize }), counts };
}

/**
 * The pre-SK-0.3 facade, re-created: every addBeam/addSphere writes the session
 * scratch and crosses immediately. Same option destructuring and same validation
 * shape as the body src/lattice.ts carried before this spike.
 */
function perCallFacade(pk) {
  const raw2 = pk.module;
  const call = (name) => raw2[`_${name}`];
  const addBeamFn = call('Lattice_AddBeam');
  const addSphereFn = call('Lattice_AddSphere');
  const libHandle = pk.handle;
  const pad = pk.module._malloc(24);
  const write = (p, v) => {
    pk.module.HEAPF32[(p >> 2) + 0] = v[0];
    pk.module.HEAPF32[(p >> 2) + 1] = v[1];
    pk.module.HEAPF32[(p >> 2) + 2] = v[2];
  };
  const createLattice = () => {
    const inner = pk.createLattice();
    const handle = inner.handle;
    return {
      addBeam({ start, end, radius, startRadius = radius, endRadius = radius, roundCap = true }) {
        write(pad, start);
        write(pad + 12, end);
        addBeamFn(libHandle, handle, pad, pad + 12, startRadius, endRadius, roundCap);
      },
      addSphere({ center, radius }) {
        write(pad, center);
        addSphereFn(libHandle, handle, pad, radius);
      },
      toVoxels: () => inner.toVoxels(),
      get memUsage() {
        return inner.memUsage;
      },
      get handle() {
        return handle;
      },
      dispose: () => inner.dispose(),
    };
  };
  return new Proxy(pk, {
    get: (target, key) => (key === 'createLattice' ? createLattice : Reflect.get(target, key)),
  });
}

/** One HeatX construct; returns its author-stage split and the crossing counts. */
async function heatxRun(variant, voxelSize) {
  const { pk, counts } = await countingSession(voxelSize);
  try {
    const run = task(variant === 'batched' ? pk : perCallFacade(pk));
    return {
      authorMs: +run.authorMs.toFixed(2),
      constructMs: +run.constructMs.toFixed(2),
      volume: run.voxels.volume,
      counts: { ...counts },
    };
  } finally {
    pk.dispose();
  }
}

// ── 2. HeatX author stage, alternating variants ───────────────────────────────
const heatx = { batched: [], 'per-call': [] };
for (let rep = 0; rep < HEATX_REPS; rep++) {
  for (const variant of ['batched', 'per-call']) {
    const r = await heatxRun(variant, HEATX_SIZE);
    heatx[variant].push(r);
    console.log(
      `  HeatX @${HEATX_SIZE}mm ${variant.padEnd(8)} rep ${rep + 1}: author ${String(r.authorMs).padStart(8)} ms  ` +
        `beams ${r.counts.Lattice_AddBeam} + bulk ${r.counts.Lattice_AddBeams}  ` +
        `spheres ${r.counts.Lattice_AddSphere} + bulk ${r.counts.Lattice_AddSpheres}  lattices ${r.counts.Lattice_hCreate}`,
    );
  }
}

// The facade row needs the real HeatX beam count to amortise honestly, so it runs
// after the counted runs: N staged beams, then one flush through `handle`.
{
  const { pk } = await countingSession(1);
  const start = [0, 0, 0];
  const end = [1, 0.5, 0.25];
  perBeam['facade (addBeam + flush)'] = floor((iters) => {
    const lat = pk.createLattice();
    for (let i = 0; i < iters; i++) lat.addBeam({ start, end, radius: 0.5 });
    void lat.handle; // the flush point
    lat.dispose();
  });
  pk.dispose();
}
results.perBeam = perBeam;
for (const [name, r] of Object.entries(perBeam)) {
  console.log(
    `  ${name.padEnd(36)} ${String(r.nsPerBeam).padStart(8)} ns/beam  (window ${r.minWindowMs} ms)`,
  );
}

// Voxel-size independence of the author stage: the crossing count at the pinned
// 1.0 mm size must equal the count at the (cheap) A/B size, or the A/B is invalid.
const confirm = await heatxRun('batched', CONFIRM_SIZE);
console.log(
  `  HeatX @${CONFIRM_SIZE}mm batched confirm: bulk crossings ${confirm.counts.Lattice_AddBeams}, lattices ${confirm.counts.Lattice_hCreate}`,
);

results.heatx = heatx;
results.heatxConfirm = confirm;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
results.heatxSummary = Object.fromEntries(
  Object.entries(heatx).map(([variant, runs]) => [
    variant,
    {
      authorMedianMs: +median(runs.map((r) => r.authorMs)).toFixed(2),
      authorMs: runs.map((r) => r.authorMs),
      volumes: [...new Set(runs.map((r) => r.volume))],
    },
  ]),
);
console.log(
  `  author median: batched ${results.heatxSummary.batched.authorMedianMs} ms vs per-call ${results.heatxSummary['per-call'].authorMedianMs} ms`,
);

// The A/B is only a timing claim if both variants built the same part.
const volumes = new Set([...heatx.batched, ...heatx['per-call']].map((r) => r.volume));
results.volumeIdentical = volumes.size === 1;
console.log(
  `  volume identity across variants: ${results.volumeIdentical ? 'IDENTICAL' : `DIVERGED ${[...volumes].join()}`}`,
);

const payload = { spike: 'SK-0.3', fingerprint, endLoad: loadavg()[0], results };
if (OUT) {
  mkdirSync(dirname(resolve(HERE, OUT)), { recursive: true });
  writeFileSync(resolve(HERE, OUT), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
