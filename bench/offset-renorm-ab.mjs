// SK-0.8 — paired A/B over the offset family's renormalization settings, with the
// accuracy metrics the L1 (GPU-tolerant) lane will inherit.
//
// Usage: node bench/offset-renorm-ab.mjs [--repeats N] [--allow-loaded]
//        writes bench/results/webgpu-v2/sk-0.8-ab.json
//
// WHY PAIRED AND INTERLEAVED. Every setting is measured against the DEFAULT setting
// in the same process, alternating which arm goes first (collectPairedSamples), and
// reported as a bootstrap CI on the median log-ratio (summarizePairedSamples). A
// machine that drifts mid-run — thermal, battery, a background process — moves both
// arms of each pair together, so the ratio survives what the absolute numbers do not.
//
// WHY THE DEFAULT ARM USES THE UNTUNED EXPORTS. Voxels_Offset/DoubleOffset/
// TripleOffset, not Voxels_OffsetTuned with default settings. The A/B then measures
// the shipped path against the opt-in path, and any per-call overhead the new TU adds
// lands in the tuned arm where it belongs.
//
// WHY THE LADDER INCLUDES normCount=0. LevelSetTracker::track() is dilate + normalize
// + prune (LevelSetTracker.h:302-315) and normalize() loops getNormCount() times
// (LevelSetTracker.h:542). normCount=0 runs the offset with NO renormalization at all:
// not a shippable setting, but the measured CEILING on what tuning renormalization can
// ever buy. The renorm share of the offset wall is 1 - t(count=0)/t(default) —
// measured, not assumed.
//
// Everything the accuracy table needs comes off the raw ABI on bare handles, so no
// facade wrapper has to be conjured for a grid the sweep produced.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPico } from '../src/index.ts';
import { bindPicoRaw } from '../src/raw.generated.ts';
import { collectPairedSamples, summarizePairedSamples, summarizeSamples } from './stats.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const REPEATS = Number(args[args.indexOf('--repeats') + 1]) || 12;
const ALLOW_LOADED = args.includes('--allow-loaded');

const cores = cpus().length;
const startLoad = loadavg()[0];
if (!ALLOW_LOADED && startLoad > cores / 2) {
  console.error(`REFUSED: loadavg ${startLoad.toFixed(2)} > cores/2 (${(cores / 2).toFixed(2)}).`);
  process.exit(1);
}

// ── settings ladder ──
// scheme = openvdb::math::BiasedGradientScheme (FiniteDifference.h:164-171).
const [FIRST, SECOND, THIRD, WENO5, HJWENO5] = [0, 1, 2, 3, 4];
const DEFAULT_SETTING = { name: 'default (HJWENO5, 3)', scheme: HJWENO5, count: 3 };
const SETTINGS = [
  // Scheme ladder at the DEFAULT sweep count — the accuracy-preserving axis.
  { name: 'FIRST, 3', scheme: FIRST, count: 3 },
  { name: 'SECOND, 3', scheme: SECOND, count: 3 },
  { name: 'THIRD, 3', scheme: THIRD, count: 3 },
  { name: 'WENO5, 3', scheme: WENO5, count: 3 },
  // Sweep-count ladder — the axis that costs the Eikonal property.
  { name: 'FIRST, 2', scheme: FIRST, count: 2 },
  { name: 'FIRST, 1', scheme: FIRST, count: 1 },
  { name: 'HJWENO5, 1', scheme: HJWENO5, count: 1 },
  // Not shippable: no renormalization at all. The attribution ceiling.
  { name: 'FIRST, 0', scheme: FIRST, count: 0, ceiling: true },
];

// ── fixtures ──
// M5 reproduces bench/run.mjs's M5 body and distances exactly (voxelSize 0.5), so the
// default arm is directly comparable to sk-0.1-baseline-dlmalloc.json's M5 phases.
// parity reproduces bench/pico-parity.cpp's body + Offset(1.5f) at its default voxel.
const FIXTURES = [
  {
    name: 'M5 offset +2 (sphere10 + beam, 0.5mm)',
    voxelSize: 0.5,
    body: (pk) => pk.createVoxels({ shape: 'sphere', radius: 10 })
      .union(pk.createVoxels({ shape: 'beam', start: [0, -15, 0], end: [0, 15, 0], radius: 4 })),
    distances: [2],
  },
  {
    // Analytic oracle: offsetting a sphere by d is a sphere of r+d. Neither arm is
    // ground truth here, so the table reports BOTH arms' error against the closed form
    // — a tuned setting that lands closer to analytic than the default is not "less
    // accurate", it is differently wrong, and the gate must be able to say so.
    name: 'analytic sphere10 offset +2 (0.5mm)',
    voxelSize: 0.5,
    body: (pk) => pk.createVoxels({ shape: 'sphere', radius: 10 }),
    distances: [2],
    analyticVolume: (4 / 3) * Math.PI * 12 ** 3,
    analyticArea: 4 * Math.PI * 12 ** 2,
  },
  {
    name: 'M5 smoothen 1 (sphere10 + beam, 0.5mm)',
    voxelSize: 0.5,
    body: (pk) => pk.createVoxels({ shape: 'sphere', radius: 10 })
      .union(pk.createVoxels({ shape: 'beam', start: [0, -15, 0], end: [0, 15, 0], radius: 4 })),
    distances: [1, -2, 1], // == TripleOffset(1)
  },
  {
    name: 'parity offset +1.5 (sphere20 + capsule - hole, 0.5mm)',
    voxelSize: 0.5,
    body: (pk) => pk.createVoxels({ shape: 'sphere', radius: 20 })
      .union(pk.createVoxels({ shape: 'capsule', start: [-25, 0, 0], end: [25, 0, 0], startRadius: 6, endRadius: 6 }))
      .subtract(pk.createVoxels({ shape: 'sphere', radius: 9, center: [0, 0, 12] })),
    distances: [1.5],
  },
];

// Distance ladder: verifies the CFL step-count model (ceil(|d| / 0.5·voxelSize) steps
// per offset call) empirically — wall must be linear in |d| at a fixed setting.
const DISTANCE_LADDER = [1, 2, 4, 8];

const results = { fixtures: [], distanceLadder: [] };

for (const fixture of FIXTURES) {
  console.log(`\n== ${fixture.name} ==`);
  const pk = await createPico({ voxelSize: fixture.voxelSize });
  const raw = bindPicoRaw(pk.module);
  const { module } = pk;
  const lib = pk.handle;

  // Scratch: 8 distances, then 24 B of bbox, 8 B of volume/area, 6 int32 dims, 256 B string.
  const dp = module._malloc(32);
  const props = module._malloc(32);
  const dims = module._malloc(24);
  const str = module._malloc(256);
  const setD = (ds) => { for (let i = 0; i < ds.length; i++) module.HEAPF32[(dp >> 2) + i] = ds[i]; };

  const base = fixture.body(pk);

  // One timed run: copy + offset — exactly the two calls the facade's derive() makes.
  // Destroy sits outside the timer (the facade defers it to dispose/GC).
  const runTuned = (setting, distances = fixture.distances) => {
    setD(distances);
    const t0 = performance.now();
    const copy = raw.Voxels_hCreateCopy(lib, base.handle);
    raw.Voxels_OffsetTuned(lib, copy, dp, distances.length, setting.scheme, setting.count);
    const ms = performance.now() - t0;
    raw.Voxels_Destroy(lib, copy);
    return ms;
  };
  const offsetDefault = (distances) => {
    const copy = raw.Voxels_hCreateCopy(lib, base.handle);
    if (distances.length === 1) raw.Voxels_Offset(lib, copy, distances[0]);
    else if (distances.length === 2) raw.Voxels_DoubleOffset(lib, copy, distances[0], distances[1]);
    else raw.Voxels_TripleOffset(lib, copy, distances[0]);
    return copy;
  };
  const runDefault = (distances = fixture.distances) => {
    const t0 = performance.now();
    const copy = offsetDefault(distances);
    const ms = performance.now() - t0;
    raw.Voxels_Destroy(lib, copy);
    return ms;
  };
  const materialise = (setting) => {
    setD(fixture.distances);
    const copy = raw.Voxels_hCreateCopy(lib, base.handle);
    raw.Voxels_OffsetTuned(lib, copy, dp, fixture.distances.length, setting.scheme, setting.count);
    return copy;
  };

  // ── accuracy metrics, straight off the raw ABI ──
  const readDims = (h) => {
    raw.Voxels_GetVoxelDimensions(lib, h, dims, dims + 4, dims + 8, dims + 12, dims + 16, dims + 20);
    const i = (o) => module.HEAP32[(dims + o) >> 2];
    return { origin: [i(0), i(4), i(8)], size: [i(12), i(16), i(20)] };
  };
  const readProps = (h) => {
    raw.Voxels_GetProperties(lib, h, props, props + 4, props + 8);
    const f = (o) => module.HEAPF32[(props + o) >> 2];
    return {
      volume: f(0),
      area: f(4),
      boundsMin: [f(8), f(12), f(16)],
      boundsMax: [f(20), f(24), f(28)],
    };
  };
  const diagnose = (h) => { raw.Voxels_bDiagnose(lib, h, str); return module.UTF8ToString(str); };
  const meshValid = (h) => {
    const mesh = raw.Mesh_hCreateFromVoxels(lib, h);
    try { return raw.Mesh_bIsValid(lib, mesh); } finally { raw.Mesh_Destroy(lib, mesh); }
  };

  /**
   * Narrow-band SDF difference between two grids, in mm. Compared over the
   * INTERSECTION of the two active-voxel boxes, at voxels where BOTH grids are
   * strictly inside their narrow band (|v| < background) — outside the band a grid
   * stores the background constant, so those voxels would measure topology extent,
   * not distance error. Voxels the two grids disagree about the band-membership of
   * are counted separately (bandMismatch) rather than silently dropped.
   */
  const sdfDelta = (a, b) => {
    const da = readDims(a);
    const db = readDims(b);
    const lo = [0, 1, 2].map((i) => Math.max(da.origin[i], db.origin[i]));
    const hi = [0, 1, 2].map((i) => Math.min(da.origin[i] + da.size[i], db.origin[i] + db.size[i]));
    if (hi.some((h, i) => h <= lo[i])) return { maxAbsMM: Infinity, meanAbsMM: Infinity, voxels: 0, bandMismatch: -1 };

    const bufA = module._malloc(da.size[0] * da.size[1] * 4);
    const bufB = module._malloc(db.size[0] * db.size[1] * 4);
    const bgA = module._malloc(4);
    const bgB = module._malloc(4);
    let maxAbs = 0;
    let sumAbs = 0;
    let n = 0;
    let mismatch = 0;
    try {
      for (let z = lo[2]; z < hi[2]; z++) {
        raw.Voxels_GetZSlice(lib, a, z - da.origin[2], bufA, bgA);
        raw.Voxels_GetZSlice(lib, b, z - db.origin[2], bufB, bgB);
        const backgroundA = module.HEAPF32[bgA >> 2];
        const backgroundB = module.HEAPF32[bgB >> 2];
        for (let y = lo[1]; y < hi[1]; y++) {
          const rowA = (bufA >> 2) + (y - da.origin[1]) * da.size[0] - da.origin[0];
          const rowB = (bufB >> 2) + (y - db.origin[1]) * db.size[0] - db.origin[0];
          for (let x = lo[0]; x < hi[0]; x++) {
            const va = module.HEAPF32[rowA + x];
            const vb = module.HEAPF32[rowB + x];
            const inA = Math.abs(va) < backgroundA;
            const inB = Math.abs(vb) < backgroundB;
            if (!inA || !inB) { if (inA !== inB) mismatch++; continue; }
            const d = Math.abs(va - vb);
            if (d > maxAbs) maxAbs = d;
            sumAbs += d;
            n++;
          }
        }
      }
    } finally {
      for (const p of [bufA, bufB, bgA, bgB]) module._free(p);
    }
    return { maxAbsMM: maxAbs, meanAbsMM: n === 0 ? Infinity : sumAbs / n, voxels: n, bandMismatch: mismatch };
  };

  const accuracy = (referenceHandle, candidateHandle) => {
    const pr = readProps(referenceHandle);
    const pc = readProps(candidateHandle);
    const boundsMaxDeltaMM = Math.max(
      ...[0, 1, 2].flatMap((i) => [
        Math.abs(pc.boundsMin[i] - pr.boundsMin[i]),
        Math.abs(pc.boundsMax[i] - pr.boundsMax[i]),
      ]),
    );
    return {
      volumeRelDelta: Math.abs(pc.volume - pr.volume) / pr.volume,
      areaRelDelta: Math.abs(pc.area - pr.area) / pr.area,
      boundsMaxDeltaMM,
      sdf: sdfDelta(referenceHandle, candidateHandle),
      levelSetDiagnosis: diagnose(candidateHandle),
      meshValid: meshValid(candidateHandle),
      referenceVolume: pr.volume,
      candidateVolume: pc.volume,
      referenceArea: pr.area,
      candidateArea: pc.area,
      ...(fixture.analyticVolume === undefined ? {} : {
        analytic: {
          referenceVolumeRelError: Math.abs(pr.volume - fixture.analyticVolume) / fixture.analyticVolume,
          candidateVolumeRelError: Math.abs(pc.volume - fixture.analyticVolume) / fixture.analyticVolume,
          referenceAreaRelError: Math.abs(pr.area - fixture.analyticArea) / fixture.analyticArea,
          candidateAreaRelError: Math.abs(pc.area - fixture.analyticArea) / fixture.analyticArea,
        },
      }),
    };
  };

  const referenceHandle = offsetDefault(fixture.distances);
  const entry = {
    name: fixture.name,
    voxelSize: fixture.voxelSize,
    distances: fixture.distances,
    referenceDiagnosis: diagnose(referenceHandle),
    referenceMeshValid: meshValid(referenceHandle),
    settings: [],
  };

  for (const setting of SETTINGS) {
    const paired = await collectPairedSamples({
      repeats: REPEATS,
      warmups: 1,
      slow: () => runDefault(),
      fast: () => runTuned(setting),
    });
    const stats = summarizePairedSamples({ slowMs: paired.slowMs, fastMs: paired.fastMs });
    const candidateHandle = materialise(setting);
    const acc = accuracy(referenceHandle, candidateHandle);
    raw.Voxels_Destroy(lib, candidateHandle);
    entry.settings.push({
      ...setting,
      speedup: stats.medianRatio,
      ci95: stats.ci95,
      defaultMs: stats.slow,
      tunedMs: stats.fast,
      order: paired.order,
      accuracy: acc,
      loadAfter: loadavg()[0],
    });
    console.log(
      `  ${setting.name}: ${stats.medianRatio.toFixed(2)}x [${stats.ci95.low.toFixed(2)}, ${stats.ci95.high.toFixed(2)}]` +
        ` (${stats.slow.median.toFixed(1)} -> ${stats.fast.median.toFixed(1)} ms)` +
        ` volΔ ${(acc.volumeRelDelta * 100).toFixed(3)}% areaΔ ${(acc.areaRelDelta * 100).toFixed(3)}%` +
        ` sdfMax ${acc.sdf.maxAbsMM.toFixed(4)} sdfMean ${acc.sdf.meanAbsMM.toFixed(5)} bandMiss ${acc.sdf.bandMismatch}` +
        ` boundsΔ ${acc.boundsMaxDeltaMM.toFixed(3)}mm mesh=${acc.meshValid} ls="${acc.levelSetDiagnosis.trim()}"` +
        (acc.analytic ? ` | analytic vol err ref ${(acc.analytic.referenceVolumeRelError * 100).toFixed(3)}% vs cand ${(acc.analytic.candidateVolumeRelError * 100).toFixed(3)}%` : ''),
    );
  }

  // Absolute default numbers for the record (comparable to the M5 baseline phases).
  entry.defaultAbsoluteMs = summarizeSamples(Array.from({ length: REPEATS }, () => runDefault()));
  results.fixtures.push(entry);

  if (fixture.name.startsWith('M5 offset')) {
    for (const d of DISTANCE_LADDER) {
      const def = summarizeSamples(Array.from({ length: 7 }, () => runDefault([d])));
      // 'fast' is the CERTIFIED setting (FIRST_BIAS, upstream's sweep count); 'noRenorm'
      // is the non-shippable ceiling.
      const fast = summarizeSamples(Array.from({ length: 7 }, () => runTuned({ scheme: FIRST, count: -1 }, [d])));
      const none = summarizeSamples(Array.from({ length: 7 }, () => runTuned({ scheme: FIRST, count: 0 }, [d])));
      const row = {
        distanceMM: d,
        cflSteps: Math.ceil(d / (0.5 * fixture.voxelSize)),
        defaultMs: def.median,
        fastMs: fast.median,
        noRenormMs: none.median,
      };
      results.distanceLadder.push(row);
      console.log(`  ladder d=${d}mm steps=${row.cflSteps}: default ${def.median.toFixed(1)} fast ${fast.median.toFixed(1)} noRenorm ${none.median.toFixed(1)} ms`);
    }
  }

  raw.Voxels_Destroy(lib, referenceHandle);
  base.dispose();
  for (const p of [dp, props, dims, str]) module._free(p);
  pk.dispose();
}

const wasmBytes = readFileSync(join(HERE, 'src/pico.wasm'));
const out = {
  fingerprint: {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
    node: process.version,
    wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
    gitSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim(),
    date: new Date().toISOString(),
    startLoad,
    endLoad: loadavg()[0],
    powerSource: (() => {
      try { return execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return 'unknown'; }
    })(),
    repeats: REPEATS,
  },
  defaultSetting: DEFAULT_SETTING,
  ...results,
};
const dir = join(HERE, 'bench/results/webgpu-v2');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = join(dir, 'sk-0.8-ab.json');
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nwrote ${file}`);
