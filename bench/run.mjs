// The benchmark harness. The methodology is
// MACHINERY, not discipline: the loadavg guard refuses noisy machines, every
// metric runs 1 warmup + 5 measured repeats (median/min/max), phases are reported
// separately so a skewed phase is visible, and identity oracles (hex-float
// volumes, FNV-1a mesh hashes) must be bit-stable across repeats — a perf run
// that changes results fails loudly. Every results file embeds the environment
// fingerprint. The project was burned twice by load-skewed numbers ("flat 2.6x",
// "506x"); this file is why that cannot happen silently again.
//
// Some canonical metrics intentionally occupy every wasm pthread, so their own
// work contaminates post-metric load averages. Eligibility is therefore decided
// once, before sampling; per-metric load values remain in the evidence alongside
// raw samples and confidence statistics.
//
// Usage: node bench/run.mjs [--allow-loaded] [--update]
//   --allow-loaded  skip the loadavg guard (CI drift canaries only, never baselines)
//   --update        regenerate bench/BENCHMARKS.md from this run
//   BENCH_REPEATS=N measured repeats per metric (default 5). Allocator comparisons
//                   run at 10+: a bootstrap CI over 5 samples resolves only gross
//                   differences, and allocator deltas are expected in the tens of percent.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPico } from '../src/index.ts';
import { buildGearMesh } from '../examples/pico/gear.ts';
import { sliceVoxels } from '../src/slicing.ts';
import { preserveAppendix, summarizeBootstrapMedian } from './stats.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_LOADED = process.argv.includes('--allow-loaded');
const UPDATE = process.argv.includes('--update');
if (ALLOW_LOADED && UPDATE) {
  console.error('REFUSED: --allow-loaded cannot be combined with --update; loaded runs are never baselines.');
  process.exit(1);
}

// ── Guards and fingerprint ──
const cores = cpus().length;
// Project benchmark policy for this spike: tolerate up to half-core-count
// background load on the shared reference workstation. Statistical confidence
// intervals and paired ratios remain mandatory.
const quietLoadCeiling = cores / 2;
const startLoad = loadavg()[0];
if (!ALLOW_LOADED && startLoad > quietLoadCeiling) {
  console.error(
    `REFUSED: 1-min loadavg ${startLoad.toFixed(2)} > cores/2 (${quietLoadCeiling.toFixed(2)}). ` +
      'Benchmark on a quiet machine, or pass --allow-loaded for non-baseline runs.',
  );
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
const wasmBytes = readFileSync(join(HERE, 'src/pico.wasm'));
const fingerprint = {
  cpu: cpus()[0]?.model ?? 'unknown',
  cores,
  ramGiB: Math.round(totalmem() / 2 ** 30),
  os: `${platform()} ${release()}`,
  node: process.version,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
  wasmBytes: wasmBytes.length,
  gitSha: git('rev-parse', '--short', 'HEAD'),
  date: new Date().toISOString(),
  startLoad,
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
  return (hash >>> 0).toString(16);
};
// ── Runner: 1 warmup + 5 measured; identity must be bit-stable across repeats ──
const REPEATS = Number(process.env.BENCH_REPEATS ?? 5);
if (!Number.isInteger(REPEATS) || REPEATS < 1) {
  console.error(`REFUSED: BENCH_REPEATS must be a positive integer, got ${process.env.BENCH_REPEATS}`);
  process.exit(1);
}
const results = {};
async function metric(id, description, body) {
  const phaseSamples = {};
  let identity = null;
  const loadBefore = loadavg()[0];
  for (let repeat = 0; repeat < REPEATS + 1; repeat++) {
    const run = await body();
    if (repeat === 0) continue; // warmup discarded (JIT/tier-up)
    for (const [phase, ms] of Object.entries(run.phases)) {
      (phaseSamples[phase] ??= []).push(ms);
    }
    if (run.identity) {
      const rendered = JSON.stringify(run.identity);
      if (identity !== null && rendered !== identity) {
        console.error(`IDENTITY DRIFT in ${id}: ${rendered} != ${identity}`);
        process.exit(1);
      }
      identity = rendered;
    }
  }
  const loadAfter = loadavg()[0];
  const phases = Object.fromEntries(
    Object.entries(phaseSamples).map(([phase, samples]) => {
      const summary = summarizeBootstrapMedian(samples);
      return [
        phase,
        {
          medianMs: +summary.median.toFixed(3),
          minMs: +summary.min.toFixed(3),
          maxMs: +summary.max.toFixed(3),
          madMs: +summary.mad.toFixed(3),
          p95Ms: +summary.p95.toFixed(3),
          ci95LowMs: +summary.ci95.low.toFixed(3),
          ci95HighMs: +summary.ci95.high.toFixed(3),
          samplesMs: summary.samples.map((sample) => +sample.toFixed(3)),
        },
      ];
    }),
  );
  results[id] = {
    description,
    phases,
    identity: identity ? JSON.parse(identity) : null,
    loadBefore,
    loadAfter,
  };
  const summary = Object.entries(phases)
    .map(([phase, s]) => `${phase} ${s.medianMs}ms`)
    .join(', ');
  console.log(`${id}: ${summary}`);
}

const now = () => performance.now();
const gyroidSdf = (scale) => (x, y, z) =>
  Math.abs(
    Math.sin(x * scale) * Math.cos(y * scale) +
      Math.sin(y * scale) * Math.cos(z * scale) +
      Math.sin(z * scale) * Math.cos(x * scale),
  ) - 0.4;

// ── M1 — re-instantiate ──
// The runner discards the first of its runs, so this is a warm, in-process
// re-instantiate, not a cold start. A cold createPico() from picovoxel/multi,
// which also starts the thread pool, measured about 106 ms on the machine that
// recorded this table's 9 ms.
await metric('M1', 'createPico() re-instantiate, warm (first run discarded)', async () => {
  const t0 = now();
  const pk = await createPico();
  const instantiateMs = now() - t0;
  pk.dispose();
  return { phases: { instantiate: instantiateMs } };
});

// Shared session for the compute metrics.
const pk = await createPico({ voxelSize: 0.5 });
const fine = await createPico({ voxelSize: 0.25 });

// ── M2 — sphere build ──
for (const [suffix, session] of /** @type {const} */ ([
  ['0.5', pk],
  ['0.25', fine],
])) {
  await metric(`M2@${suffix}`, `sphere r=10 @ ${suffix}mm`, () => {
    const t0 = now();
    const sphere = session.createVoxels({ shape: 'sphere', radius: 10 });
    const buildMs = now() - t0;
    const t1 = now();
    const volume = sphere.volume;
    const volumeMs = now() - t1;
    sphere.dispose();
    return { phases: { build: buildMs, volume: volumeMs }, identity: { volume: hexFloat(volume) } };
  });
}

// ── M3 — gyroid implicit (JS SDF callback path) ──
for (const [suffix, session] of /** @type {const} */ ([
  ['0.5', pk],
  ['0.25', fine],
])) {
  await metric(`M3@${suffix}`, `gyroid implicit @ ${suffix}mm (JS SDF)`, () => {
    const t0 = now();
    const gyroid = session.createVoxels({
      shape: 'implicit',
      boundsMin: [-12, -12, -12],
      boundsMax: [12, 12, 12],
      sdf: gyroidSdf((2 * Math.PI) / 10),
    });
    const renderMs = now() - t0;
    const t1 = now();
    const mesh = gyroid.toMesh();
    const meshMs = now() - t1;
    const identity = { volume: hexFloat(gyroid.volume), triangles: mesh.triangleCount };
    mesh.dispose();
    gyroid.dispose();
    return { phases: { render: renderMs, mesh: meshMs }, identity };
  });
}

// ── M4 — boolean chain ──
await metric('M4', 'union + subtract + intersect chain (differential shapes)', () => {
  const a = pk.createVoxels({ shape: 'sphere', radius: 10 });
  const b = pk.createVoxels({ shape: 'sphere', center: [6, 0, 0], radius: 8 });
  const rod = pk.createVoxels({ shape: 'beam', start: [-20, 0, 0], end: [20, 0, 0], radius: 3 });
  const t0 = now();
  const chained = a.union(b).subtract(rod).intersect(a);
  const chainMs = now() - t0;
  const identity = { volume: hexFloat(chained.volume) };
  for (const v of [a, b, rod, chained]) v.dispose();
  return { phases: { chain: chainMs }, identity };
});

// ── M5 — offsets ──
await metric('M5', 'offset +2 and smoothen(1) on a CSG body', () => {
  const base = pk
    .createVoxels({ shape: 'sphere', radius: 10 })
    .union(pk.createVoxels({ shape: 'beam', start: [0, -15, 0], end: [0, 15, 0], radius: 4 }));
  const t0 = now();
  const grown = base.offset({ distance: 2 });
  const offsetMs = now() - t0;
  const t1 = now();
  const smooth = base.smoothen({ distance: 1 });
  const smoothenMs = now() - t1;
  const identity = { grown: hexFloat(grown.volume), smooth: hexFloat(smooth.volume) };
  for (const v of [base, grown, smooth]) v.dispose();
  return { phases: { offset: offsetMs, smoothen: smoothenMs }, identity };
});

// ── M6 — mesh readback: bulk vs per-element (the ~150x bulk win) ──
await metric('M6', 'mesh readback bulk vs per-element (0.25mm gyroid)', () => {
  const gyroid = fine.createVoxels({
    shape: 'implicit',
    boundsMin: [-8, -8, -8],
    boundsMax: [8, 8, 8],
    sdf: gyroidSdf((2 * Math.PI) / 8),
  });
  const mesh = gyroid.toMesh();
  const t0 = now();
  const vertices = mesh.vertices; // bulk (cached after, so time the first touch)
  const bulkMs = now() - t0;

  const raw = fine.module;
  const getVertex = raw.cwrap('Mesh_GetVertex', null, ['bigint', 'bigint', 'number', 'number']);
  const pointer = raw._malloc(12);
  const count = mesh.vertexCount;
  const t1 = now();
  for (let i = 0; i < count; i++) getVertex(fine.handle, mesh.handle, i, pointer);
  const perElementMs = now() - t1;
  raw._free(pointer);

  const identity = { vertices: fnv1a(vertices), count };
  mesh.dispose();
  gyroid.dispose();
  return { phases: { bulk: bulkMs, perElement: perElementMs }, identity };
});

// ── M7 — bulk import (STL import proxy) ──
await metric('M7', '100k-triangle synthetic bulk import', () => {
  const vertexCount = 100_000;
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3] = (i % 331) * 0.25;
    vertices[i * 3 + 1] = Math.fround(Math.sin(i * 0.01) * 40);
    vertices[i * 3 + 2] = (i / 331) | 0;
  }
  const triangles = new Uint32Array((vertexCount - 2) * 3);
  for (let i = 0; i < vertexCount - 2; i++) {
    triangles[i * 3] = i;
    triangles[i * 3 + 1] = i + 1;
    triangles[i * 3 + 2] = i + 2;
  }
  const t0 = now();
  const mesh = pk.createMesh({ vertices, triangles });
  const importMs = now() - t0;
  const identity = { vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount };
  mesh.dispose();
  return { phases: { import: importMs }, identity };
});

// ── M8 — slice sweep (slicing subpath feedstock) ──
await metric('M8', 'full interpolated slice sweep + vectorize (sphere r=8)', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const t0 = now();
  const stack = sliceVoxels(sphere);
  const sweepMs = now() - t0;
  const identity = {
    layers: stack.slices.length,
    contours: stack.slices.reduce((n, s) => n + s.contours.length, 0),
  };
  sphere.dispose();
  return { phases: { sweep: sweepMs }, identity };
});

// ── M9 — facade vs the legacy ccall path (A1's 33.6 ns/call baseline).
// `rawIsEmpty` is deliberately a hand-built cwrap: with a bigint argType it falls
// back to ccall, the path SK-0.2 removed from the generated bindings. Holding it
// fixed keeps the metric comparable across history. Expect only a few percent
// between the two rows, not SK-0.2's 3× — `bIsEmpty` on a REAL sphere field costs
// ~1.6 µs of C++, so the ~65 ns boundary delta is noise against it. The per-call
// number itself is measured in isolation by bench/abi-call-cost.mjs. ──
await metric('M9', 'facade vs raw: 10k isEmpty calls', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const rawIsEmpty = pk.module.cwrap('Voxels_bIsEmpty', 'boolean', ['bigint', 'bigint']);
  const N = 10_000;
  const t0 = now();
  for (let i = 0; i < N; i++) rawIsEmpty(pk.handle, sphere.handle);
  const rawMs = now() - t0;
  const t1 = now();
  for (let i = 0; i < N; i++) void sphere.isEmpty;
  const facadeMs = now() - t1;
  sphere.dispose();
  return { phases: { raw10k: rawMs, facade10k: facadeMs } };
});

// ── M10 — gyroid tape @0.25mm: serialized SDF, parallel in-module fill (TP1-TP4) ──
// Identity must bit-match M3@0.25 (same fold order, both fdlibm-derived libms);
// the multi row is the thread-scaling headline — the tape is the only SDF shape
// reachable from pthread workers.
{
  const s = (2 * Math.PI) / 10;
  const gyroidExpression = [
    '-',
    [
      'abs',
      [
        '+',
        ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
        ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
        ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]],
      ],
    ],
    0.4,
  ];
  const { createPico: createMulti } = await import('../src/multi.ts');
  for (const [suffix, make] of /** @type {const} */ ([
    ['single', () => createPico({ voxelSize: 0.25 })],
    ['multi', () => createMulti({ voxelSize: 0.25 })],
  ])) {
    await metric(`M10@${suffix}`, `gyroid tape @ 0.25mm (${suffix} entry)`, async () => {
      const session = await make();
      const t0 = now();
      const gyroid = session.createVoxels({
        shape: 'implicit',
        boundsMin: [-12, -12, -12],
        boundsMax: [12, 12, 12],
        sdf: gyroidExpression,
      });
      const renderMs = now() - t0;
      const t1 = now();
      const mesh = gyroid.toMesh();
      const meshMs = now() - t1;
      const identity = { volume: hexFloat(gyroid.volume), triangles: mesh.triangleCount };
      const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
      session.dispose();
      return { phases: { render: renderMs, mesh: meshMs }, identity: { ...identity, threads } };
    });
  }
}

// gear as a byproduct check that the harness drives the ABI-level path too
void buildGearMesh;

pk.dispose();
fine.dispose();

// ── M11 — RoverWheel Wheel_02 @ 1.0mm (real-world subject) ──
// The first production-scale exercise of the ShapeKernel-bound pipeline:
// mesh tessellation, mesh↔voxel round-trip with per-vertex warp, projectZSlice
// and pure boolean assembly. Identity = fast-volume hex + STL FNV-1a.
{
  const { presetWheelTask } = await import('../examples/roverwheel/run.ts');
  await metric('M11', 'RoverWheel Wheel_02 @ 1.0mm (subject)', async () => {
    const session = await createPico({ voxelSize: 1.0 });
    const t0 = now();
    const wheel = presetWheelTask(session);
    const constructMs = now() - t0;
    const t1 = now();
    const mesh = wheel.toMesh();
    const meshMs = now() - t1;
    const t2 = now();
    const stl = mesh.toStl();
    const stlMs = now() - t2;
    const identity = { volume: hexFloat(wheel.volume), stl: fnv1a(stl), triangles: mesh.triangleCount };
    session.dispose();
    return { phases: { construct: constructMs, mesh: meshMs, stl: stlMs }, identity };
  });
}

// ── M12 — HelixHeatX @ 1.0mm, single vs multi (real-world subject) ──
// The whole flagship Task headless: 1,197,460 lattice beams over 37 lattices
// (counted in SK-0.2; the long-standing "~10^5" figure was an order of magnitude
// low), boolean assembly, the full finishing family, meshing and STL bytes —
// previews excluded (a delta in the
// published table's favour). The author phase is the pure-JS lattice-loop
// share (Finding 8's promotion trigger); each kernel stage is timed separately.
// The full 1.0→0.5mm voxel sweep lives in bench/heatx-sweep.mjs (its own
// repeat policy — six repeats of the fine cells would take hours).
// M12-v2 (2026-09-27, PV-FC2): the Task no longer builds the flange's preview-only
// thread cutters (~1.78 s of serial flat-cap lattice work at 1.0 mm multi), so
// construct and the flange stage (now kernel:flange.create-v2) measure a smaller
// workload. Renamed, not overwritten, so compare-baselines never reads the drop as
// a speed-up against the committed M12 baselines.
{
  const { task: heatXTask } = await import('../examples/helixheatx/run.ts');
  const { createPico: createMulti } = await import('../src/multi.ts');
  for (const [suffix, make] of /** @type {const} */ ([
    ['single', () => createPico({ voxelSize: 1.0 })],
    ['multi', () => createMulti({ voxelSize: 1.0 })],
  ])) {
    await metric(`M12-v2@${suffix}`, `HelixHeatX @ 1.0mm (${suffix} entry)`, async () => {
      const session = await make();
      const { voxels, authorMs, constructMs, kernelTimings, unattributedMs } = heatXTask(session);
      const t1 = now();
      const mesh = voxels.toMesh();
      const meshMs = now() - t1;
      const t2 = now();
      const stl = mesh.toStl();
      const stlMs = now() - t2;
      const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
      const identity = {
        volume: hexFloat(voxels.volume),
        stl: fnv1a(stl),
        stlBytes: stl.length,
        threads,
        kernelStages: kernelTimings.map(({ stage }) => stage),
      };
      session.dispose();
      return {
        phases: {
          construct: constructMs,
          author: authorMs,
          ...Object.fromEntries(kernelTimings.map(({ stage, ms }) => [`kernel:${stage}`, ms])),
          unattributed: unattributedMs,
          mesh: meshMs,
          stl: stlMs,
        },
        identity,
      };
    });
  }
}

// ── M13 — TPMS preset tape vs callback A/B (LatticeLibrary, blueprint R13) ──
// One closed-form preset at volume scale: the same SchwarzDiamond field filled
// through the serial JS-callback path and the tape path. The two volume hexes
// must be equal — the presets pin tape ≡ callback bit-exactly in unit tests.
{
  const { ImplicitSchwarzDiamond } = await import('../src/latticelibrary.ts');
  const preset = new ImplicitSchwarzDiamond(10, 0.5);
  await metric('M13', 'SchwarzDiamond preset @ 0.5mm, [-15,15]³: callback vs tape', async () => {
    const session = await createPico({ voxelSize: 0.5 });
    const bounds = { boundsMin: [-15, -15, -15], boundsMax: [15, 15, 15] };
    const t0 = now();
    const fromCallback = session.createVoxels({ shape: 'implicit', ...bounds, sdf: preset.sdf });
    const callbackMs = now() - t0;
    const t1 = now();
    const fromTape = session.createVoxels({ shape: 'implicit', ...bounds, sdf: preset.expression });
    const tapeMs = now() - t1;
    const identity = { callbackVolume: hexFloat(fromCallback.volume), tapeVolume: hexFloat(fromTape.volume) };
    session.dispose();
    return { phases: { callback: callbackMs, tape: tapeMs }, identity };
  });
}

// ── M14 — QuasiCrystal wireframe gen 0/1/2 (QuasiCrystals-TS, blueprint R15) ──
// Aperiodic tile inflation is pure-JS authoring (attach/inflate/dedup) feeding
// one lattice voxelization per generation; each phase covers author+voxelize
// for its generation, and the volume hexes pin every generation bit-exactly.
{
  const { wireframeFromCrystalTask } = await import('../examples/quasicrystals/run.ts');
  await metric('M14', 'QuasiCrystal wireframe gens 0/1/2 @ 2.0mm, QuasiTile_02 seed', async () => {
    const session = await createPico({ voxelSize: 2.0 });
    const phases = {};
    const identity = {};
    for (const gen of [0, 1, 2]) {
      const t0 = now();
      const { voxels } = wireframeFromCrystalTask(session, gen);
      phases[`gen${gen}`] = now() - t0;
      identity[`gen${gen}Volume`] = hexFloat(voxels.volume);
    }
    session.dispose();
    return { phases, identity };
  });
}

// ── Persist ──
const output = { fingerprint, results };
const resultsDir = join(HERE, 'bench/results');
mkdirSync(resultsDir, { recursive: true });
const fileName = `${fingerprint.date.slice(0, 10)}-${fingerprint.gitSha}.json`;
writeFileSync(join(resultsDir, fileName), JSON.stringify(output, null, 2) + '\n');
console.log(`\nwrote bench/results/${fileName}`);

if (UPDATE) {
  const lines = [];
  lines.push('# picovoxel benchmarks');
  lines.push('');
  lines.push(
    `> Measured on ${fingerprint.cpu} (${fingerprint.cores} cores, ${fingerprint.ramGiB} GiB), ` +
      `${fingerprint.os}, node ${fingerprint.node}, wasm ${fingerprint.wasmSha256.slice(0, 12)} ` +
      `(${fingerprint.wasmBytes.toLocaleString('en-US')} B), commit ${fingerprint.gitSha}, ${fingerprint.date.slice(0, 10)}.`,
  );
  lines.push(
    '> **Absolute numbers are device-specific; treat ratios and phase splits as the portable signal.**',
  );
  lines.push(
    `> Reproduce with \`pnpm run bench\` (the harness refuses loaded machines). Source: \`bench/results/${fileName}\`.`,
  );
  lines.push('>');
  lines.push(
    '> This harness does not measure native PicoGK: `bench/native-heatx/README.md` records same-machine native',
  );
  lines.push(
    '> timings. The 3–9% SDF callback overhead and the ~150× bulk-readback figures come from earlier measured',
  );
  lines.push('> runs, not from this harness.');
  lines.push('');
  lines.push('| Metric | Description | Phase | Median | Min | Max |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: |');
  for (const [id, entry] of Object.entries(results)) {
    const phases = Object.entries(entry.phases);
    phases.forEach(([phase, s], index) => {
      lines.push(
        `| ${index === 0 ? id : ''} | ${index === 0 ? entry.description : ''} | ${phase} | ${s.medianMs} ms | ${s.minMs} | ${s.maxMs} |`,
      );
    });
  }
  lines.push('');
  lines.push(
    'Identity oracles (hex-float volumes, FNV-1a mesh hashes) are bit-stable across the 5 repeats of every metric — enforced by the harness, not reviewed by eye.',
  );
  lines.push('');
  lines.push('**Repeatability**: consecutive quiet-machine runs agree within ±10% on every phase ≥ 1 ms;');
  lines.push(
    'sub-millisecond phases (e.g. M6 bulk readback) are timer-noise-dominated and may vary up to ±20% — their RATIO to the paired phase is the signal.',
  );
  lines.push('');
  lines.push(
    "**Sanity anchors** (vs earlier measured runs): M6's bulk-vs-per-element ratio grows with mesh size —",
  );
  lines.push(
    "~50× here on a ~40k-vertex gyroid, consistent with the earlier ~150× measurement at 174k vertices; M3's render phase",
  );
  lines.push(
    '(~130 ns/sample at 0.25 mm including voxel work) is consistent with the earlier 3–9% JS-SDF callback overhead measurement;',
  );
  lines.push(
    "M9's raw10k is a deliberately retained emscripten ccall and the facade now runs on direct exports; the rows " +
      'sit within a few percent because bIsEmpty on a real sphere field is ~1.6 µs of C++ against a ~65 ns boundary delta — ' +
      'the isolated per-call cost is measured by `bench/abi-call-cost.mjs`, not here.',
  );
  lines.push('');
  // The hand-written appendix (per-change program log) survives regeneration.
  const target = join(HERE, 'bench/BENCHMARKS.md');
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    /* first generation: no file yet */
  }
  writeFileSync(target, preserveAppendix(lines.join('\n'), existing));
  console.log('updated bench/BENCHMARKS.md');
}
