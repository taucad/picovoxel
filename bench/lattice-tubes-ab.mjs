// SK-0.4 — the lattice lane A/B: openvdb's parallel tube complex against PicoGK's
// serial dense-accessor fill.
//
// Three passes, run as separate processes so nothing contaminates anything else:
//
//   --equivalence  geometry, serial lane as the reference. The SK-0.8 gate shape verbatim
//                  (bench/results/webgpu-v2/SK-0.8.md §4): corrected volume and area
//                  relative delta, iso-surface bounds max component delta, narrow-band SDF
//                  max/mean |Δ| over the intersection of the two active boxes, band
//                  mismatch reported not gated, tools::checkLevelSet must be EMPTY, mesh
//                  valid. Plus the analytic column wherever a closed form exists, because
//                  "differs from the reference" and "less accurate" are not the same claim.
//   --timing       paired, order-alternated arms on the SAME lattice handle, so neither arm
//                  can win by getting a differently-authored input. Bootstrap CI on the
//                  median log ratio (bench/stats.mjs).
//   --determinism  the same fixture rendered N times through the tube lane, hashed. Run it
//                  on both glues and the two hashes must agree: that is the single==multi
//                  identity property the L0 fine-cell gate enforces, measured directly on
//                  the lane instead of through a whole HeatX build.
//   --memory       wasm linear-memory high-water across ONE render, one lane per process.
//                  Memory in wasm only grows, so the delta over a single first render is
//                  the peak that render needed. Run on the serial glue and on the pthread
//                  glue to price the per-thread trees.
//
// FIXTURES. The synthetic cases are one element each and exist to fill in the beam-case
// mapping table: each is a case openvdb's per-vertex-radii dispatch treats differently
// (LevelSetTubesImpl.h:1183-1207). The real fixtures are EXTRACTED from the examples
// rather than re-authored here — a Proxy over the session captures the Lattice the
// example's own code builds, so the fixture is the real beam set, at the real coordinates,
// with the real cap flags. `heatx:thread-cutter` is the flat-capped control: the tube complex
// has no conical-frustum form, so that fixture takes the serial fallback end to end and
// its ratio should sit at ~1.0x.
//
// Usage:
//   npx tsx bench/lattice-tubes-ab.mjs --equivalence [--voxel 0.5] [--out FILE]
//   npx tsx bench/lattice-tubes-ab.mjs --timing [--repeats 12] [--multi] [--out FILE]
//   npx tsx bench/lattice-tubes-ab.mjs --determinism [--runs 3] [--multi] [--out FILE]
//   npx tsx bench/lattice-tubes-ab.mjs --memory --lane serial|tubes [--multi] [--fixture helical-void|beams-1e5]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindPicoRaw } from '../src/raw.ts';
import { collectPairedSamples, summarizePairedSamples } from './stats.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

const VOXEL = Number(arg('--voxel', 0.5));
const REPEATS = Number(arg('--repeats', 12));
const RUNS = Number(arg('--runs', 3));
const MULTI = has('--multi');
const OUT = arg('--out', null);
const LANE = arg('--lane', 'tubes');
const FIXTURE = arg('--fixture', 'helical-void');

// ── session ───────────────────────────────────────────────────────────────────
// ONE facade session for everything: the extracted fixtures need the facade anyway, and
// bindPicoRaw over its module gives the raw arms. No second module, no rebinding.
const variant = MULTI ? 'pico-multi' : 'pico';
const wasmBytes = readFileSync(join(HERE, 'src', `${variant}.wasm`));
const { createPico } = MULTI ? await import('../src/multi.ts') : await import('../src/index.ts');
const pk = await createPico({ voxelSize: VOXEL });
const module = pk.module;
const raw = bindPicoRaw(module);
const lib = pk.handle;

const battery = () => {
  try {
    return (
      execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' }).split('\n')[1]?.trim() ?? 'unknown'
    );
  } catch {
    return 'unavailable';
  }
};

const fingerprint = {
  spike: 'SK-0.4',
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  ramGiB: Math.round(totalmem() / 2 ** 30),
  os: `${platform()} ${release()}`,
  node: process.version,
  variant,
  threads: MULTI ? (module.PThread?.runningWorkers?.length ?? null) : 0,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
  wasmBytes: wasmBytes.length,
  voxelSizeMm: VOXEL,
  repeats: REPEATS,
  date: new Date().toISOString(),
  startLoad: loadavg()[0],
  startPower: battery(),
};

// ── scratch ───────────────────────────────────────────────────────────────────
const VEC3 = 12;
const scratch = module._malloc(256);
const dims = module._malloc(24);
const props = module._malloc(32);
const str = module._malloc(4096);
const vec = (at, x, y, z) => {
  module.HEAPF32[(at >> 2) + 0] = x;
  module.HEAPF32[(at >> 2) + 1] = y;
  module.HEAPF32[(at >> 2) + 2] = z;
};
/** Byte view over wasm linear memory. The HEAPU8 runtime method is not exported by this
 *  build (scripts/build-pico-module.sh RUNTIME_METHODS), so take a view off HEAPF32's
 *  buffer — and take it FRESH each time, because growth swaps the underlying buffer. */
const bytesAt = (pointer, length) => new Uint8Array(module.HEAPF32.buffer, pointer, length);
const heapBytes = () => module.HEAPF32.buffer.byteLength;
const hexFloat = (value) => Buffer.from(Float64Array.of(value).buffer).toString('hex');

// ── accuracy metrics (SK-0.8 §4, verbatim shape) ──────────────────────────────
const readDims = (h) => {
  raw.Voxels_GetVoxelDimensions(lib, h, dims, dims + 4, dims + 8, dims + 12, dims + 16, dims + 20);
  const i = (o) => module.HEAP32[(dims + o) >> 2];
  return { origin: [i(0), i(4), i(8)], size: [i(12), i(16), i(20)] };
};
const readProps = (h) => {
  raw.Voxels_GetProperties(lib, h, props, props + 4, props + 8);
  const f = (o) => module.HEAPF32[(props + o) >> 2];
  return { volume: f(0), area: f(4), boundsMin: [f(8), f(12), f(16)], boundsMax: [f(20), f(24), f(28)] };
};
const diagnose = (h) => {
  raw.Voxels_bDiagnose(lib, h, str);
  return module.UTF8ToString(str);
};
const withMesh = (h, body) => {
  const mesh = raw.Mesh_hCreateFromVoxels(lib, h);
  try {
    return body(mesh);
  } finally {
    raw.Mesh_Destroy(lib, mesh);
  }
};

/** Narrow-band SDF difference in mm — the SK-0.8 definition, band membership and all. */
const sdfDelta = (a, b) => {
  const da = readDims(a);
  const db = readDims(b);
  const lo = [0, 1, 2].map((i) => Math.max(da.origin[i], db.origin[i]));
  const hi = [0, 1, 2].map((i) => Math.min(da.origin[i] + da.size[i], db.origin[i] + db.size[i]));
  if (hi.some((h, i) => h <= lo[i]))
    return { maxAbsMM: Infinity, meanAbsMM: Infinity, voxels: 0, bandMismatch: -1 };

  const bufA = module._malloc(da.size[0] * da.size[1] * 4);
  const bufB = module._malloc(db.size[0] * db.size[1] * 4);
  const bgA = module._malloc(4);
  const bgB = module._malloc(4);
  let maxAbs = 0;
  let sumAbs = 0;
  let n = 0;
  let mismatch = 0;
  let bitExact = 0;
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
          if (!inA || !inB) {
            if (inA !== inB) mismatch++;
            continue;
          }
          const d = Math.abs(va - vb);
          if (d === 0) bitExact++;
          if (d > maxAbs) maxAbs = d;
          sumAbs += d;
          n++;
        }
      }
    }
  } finally {
    for (const p of [bufA, bufB, bgA, bgB]) module._free(p);
  }
  return {
    maxAbsMM: maxAbs,
    meanAbsMM: n === 0 ? Infinity : sumAbs / n,
    voxels: n,
    bitExactVoxels: bitExact,
    bitExactFraction: n === 0 ? null : bitExact / n,
    bandMismatch: mismatch,
  };
};

const accuracy = (reference, candidate, analyticVolume) => {
  const pr = readProps(reference);
  const pc = readProps(candidate);
  return {
    volumeRelDelta: Math.abs(pc.volume - pr.volume) / pr.volume,
    areaRelDelta: Math.abs(pc.area - pr.area) / pr.area,
    boundsMaxDeltaMM: Math.max(
      ...[0, 1, 2].flatMap((i) => [
        Math.abs(pc.boundsMin[i] - pr.boundsMin[i]),
        Math.abs(pc.boundsMax[i] - pr.boundsMax[i]),
      ]),
    ),
    sdf: sdfDelta(reference, candidate),
    levelSetDiagnosis: diagnose(candidate),
    referenceDiagnosis: diagnose(reference),
    meshValid: withMesh(candidate, (m) => raw.Mesh_bIsValid(lib, m)),
    referenceMeshValid: withMesh(reference, (m) => raw.Mesh_bIsValid(lib, m)),
    referenceVolume: pr.volume,
    candidateVolume: pc.volume,
    referenceArea: pr.area,
    candidateArea: pc.area,
    referenceTriangles: withMesh(reference, (m) => raw.Mesh_nTriangleCount(lib, m)),
    candidateTriangles: withMesh(candidate, (m) => raw.Mesh_nTriangleCount(lib, m)),
    signIdentical: raw.Voxels_bIsEqual(lib, reference, candidate),
    ...(analyticVolume === undefined
      ? {}
      : {
          analytic: {
            volume: analyticVolume,
            referenceRelError: Math.abs(pr.volume - analyticVolume) / analyticVolume,
            candidateRelError: Math.abs(pc.volume - analyticVolume) / analyticVolume,
          },
        }),
  };
};

// ── synthetic fixtures: one per dispatch branch ───────────────────────────────
const beamAt = (lattice, y, r0, r1, round) => {
  vec(scratch, -10, y, 0);
  vec(scratch + VEC3, 10, y, 0);
  raw.Lattice_AddBeam(lib, lattice, scratch, scratch + VEC3, r0, r1, round);
};
const capsuleVolume = (r, l) => Math.PI * r * r * l + (4 / 3) * Math.PI * r ** 3;

const SYNTHETIC = {
  'case:capsule r=2 L=20': { build: (l) => beamAt(l, 0, 2, 2, true), analyticVolume: capsuleVolume(2, 20) },
  'case:tapered r 3->1 L=20': { build: (l) => beamAt(l, 0, 3, 1, true) },
  'case:tapered thin r 2->0.1 L=20': { build: (l) => beamAt(l, 0, 2, 0.1, true) },
  'case:near-equal radii r 2->2.0004 L=20': { build: (l) => beamAt(l, 0, 2, 2.0004, true) },
  'case:nested end spheres r 6->1 L=2': {
    build: (l) => {
      vec(scratch, -1, 0, 0);
      vec(scratch + VEC3, 1, 0, 0);
      raw.Lattice_AddBeam(lib, l, scratch, scratch + VEC3, 6, 1, true);
    },
    analyticVolume: (4 / 3) * Math.PI * 6 ** 3,
  },
  'case:sphere r=3': {
    build: (l) => {
      vec(scratch, 0, 0, 0);
      raw.Lattice_AddSphere(lib, l, scratch, 3);
    },
    analyticVolume: (4 / 3) * Math.PI * 27,
  },
  'case:zero-length round beam (-> sphere)': {
    build: (l) => {
      vec(scratch, 0, 0, 0);
      raw.Lattice_AddBeam(lib, l, scratch, scratch, 2.5, 2.5, true);
    },
    analyticVolume: (4 / 3) * Math.PI * 2.5 ** 3,
  },
  'case:flat cone r=2 L=20 (fallback)': { build: (l) => beamAt(l, 0, 2, 2, false) },
  'case:flat cone tapered r 3->1 (fallback)': { build: (l) => beamAt(l, 0, 3, 1, false) },
  'case:axis-aligned Z capsule r=1 L=10': {
    build: (l) => {
      vec(scratch, 0, 0, -5);
      vec(scratch + VEC3, 0, 0, 5);
      raw.Lattice_AddBeam(lib, l, scratch, scratch + VEC3, 1, 1, true);
    },
    analyticVolume: capsuleVolume(1, 10),
  },
  'case:overlapping crossed capsules': {
    build: (l) => {
      vec(scratch, -10, 0, 0);
      vec(scratch + VEC3, 10, 0, 0);
      raw.Lattice_AddBeam(lib, l, scratch, scratch + VEC3, 2, 2, true);
      vec(scratch, 0, -10, 0);
      vec(scratch + VEC3, 0, 10, 0);
      raw.Lattice_AddBeam(lib, l, scratch, scratch + VEC3, 2, 2, true);
    },
  },
  'case:mixed caps + sphere': {
    build: (l) => {
      beamAt(l, 0, 2, 2, true);
      beamAt(l, 6, 3, 1, true);
      beamAt(l, 12, 2, 2, false);
      vec(scratch, 0, -8, 0);
      raw.Lattice_AddSphere(lib, l, scratch, 3);
    },
  },
  'case:empty lattice': { build: () => {} },
};

// ── extracted fixtures ────────────────────────────────────────────────────────
/**
 * Captures the Lattice an example's own code authors, without re-authoring it here. The
 * Proxy hands the example a session whose createLattice records what it hands back;
 * everything else passes straight through, so the beam set, coordinates and cap flags are
 * exactly what the example produces. The private-method calls are deliberate: `private` in
 * TypeScript is a compile-time marker, and the stage methods are the fixture boundary the
 * SK-0.1 stage decomposition already names.
 */
async function extractedFixtures() {
  const captured = [];
  const spy = new Proxy(pk, {
    get(target, key) {
      if (key === 'createLattice') {
        return (...args) => {
          const lattice = target.createLattice(...args);
          captured.push(lattice);
          return lattice;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const { HelixHeatX } = await import('../examples/helixheatx/helixHeatX.ts');
  const { ThreadCutter } = await import('../examples/helixheatx/helpers.ts');
  const { localFrame } = await import('../src/shapekernel.ts');

  const heatx = new HelixHeatX(spy);
  const grabbed = [];
  const take = (label, run) => {
    captured.length = 0;
    run();
    if (captured.length === 0) throw new Error(`${label}: captured no lattice`);
    grabbed.push({ label, lattice: captured[0] });
  };

  take('heatx:turning-fins.hot', () => heatx.turningFins('hot'));
  take('heatx:straight-fins.hot', () => heatx.straightFins('hot'));
  take('heatx:helical-void.hot', () => heatx.helicalVoid('hot'));
  // The flat-cap control: ThreadCutter's helix is roundCap:false throughout, so this
  // fixture takes the serial fallback end to end. HeatX's own parameters
  // (helixHeatX.ts flange(): cutLength 24, maxRadius 6, coreRadius 5, slope 1.3).
  // It captures flange.create's ThreadCutter, not the io-threads stage (that stage
  // is BasePipe collars through the mesh path). Recorded results before 2026-09-27
  // key this fixture as 'heatx:io-threads (flat caps)'.
  take('heatx:thread-cutter (flat caps)', () =>
    new ThreadCutter(localFrame.create([0, 0, -10]), 24, 6, 5, 1.3).voxConstruct(spy),
  );

  const { wireframeFromCrystalTask } = await import('../examples/quasicrystals/run.ts');
  take('quasicrystal:wireframe gen-1', () => wireframeFromCrystalTask(spy, 1));

  const fixtures = {};
  for (const { label, lattice } of grabbed) {
    fixtures[label] = { handle: lattice.handle, latticeMemUsage: lattice.memUsage };
  }
  return fixtures;
}

const render = (exportName, latticeHandle) => {
  const h = raw.Voxels_hCreate(lib);
  raw[exportName](lib, h, latticeHandle);
  return h;
};

// ── pass: equivalence ─────────────────────────────────────────────────────────
async function equivalence() {
  const results = {};
  const score = (name, latticeHandle, analyticVolume) => {
    const serial = render('Voxels_RenderLattice', latticeHandle);
    const tubes = render('Voxels_RenderLatticeTubes', latticeHandle);
    results[name] =
      raw.Voxels_bIsEmpty(lib, serial) && raw.Voxels_bIsEmpty(lib, tubes)
        ? { bothEmpty: true, signIdentical: true }
        : accuracy(serial, tubes, analyticVolume);
    for (const h of [serial, tubes]) raw.Voxels_Destroy(lib, h);
    process.stderr.write(`  ${name}\n`);
  };

  for (const [name, spec] of Object.entries(SYNTHETIC)) {
    const lattice = raw.Lattice_hCreate(lib);
    spec.build(lattice);
    score(name, lattice, spec.analyticVolume);
    raw.Lattice_Destroy(lib, lattice);
  }
  for (const [name, spec] of Object.entries(await extractedFixtures())) {
    score(name, spec.handle);
    results[name].latticeMemUsage = spec.latticeMemUsage;
  }
  return results;
}

// ── pass: timing ──────────────────────────────────────────────────────────────
async function timing() {
  const results = {};
  for (const [name, spec] of Object.entries(await extractedFixtures())) {
    const arm = (exportName) => () => {
      const t0 = performance.now();
      const h = render(exportName, spec.handle);
      const ms = performance.now() - t0;
      raw.Voxels_Destroy(lib, h);
      return ms;
    };
    const { slowMs, fastMs, order } = await collectPairedSamples({
      repeats: REPEATS,
      warmups: 1,
      slow: arm('Voxels_RenderLattice'),
      fast: arm('Voxels_RenderLatticeTubes'),
    });
    const summary = summarizePairedSamples({ slowMs, fastMs });
    results[name] = { ...summary, order, latticeMemUsage: spec.latticeMemUsage };
    process.stderr.write(
      `  ${name}: serial ${summary.slow.median.toFixed(1)} ms, tubes ${summary.fast.median.toFixed(1)} ms` +
        ` -> ${summary.medianRatio.toFixed(3)}x [${summary.ci95.low.toFixed(3)}, ${summary.ci95.high.toFixed(3)}]\n`,
    );
  }
  return results;
}

// ── pass: determinism ─────────────────────────────────────────────────────────
// The identity oracle, per fixture: raw level-set volume as an exact hex double, plus the
// extracted mesh's counts and an FNV-1a over its VERTEX and TRIANGLE bytes, read through
// the SK-0.3 bulk exports. Two hashes over the actual primitive arrays, because a volume
// collision is cheap, a triangle-count collision is not, and the bytes settle it — this is
// a strictly finer oracle than the STL-size check the suite's pins use.
const fnv1a = (bytes) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

async function determinism() {
  const results = {};
  for (const [name, spec] of Object.entries(await extractedFixtures())) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const h = render('Voxels_RenderLatticeTubes', spec.handle);
      const oracle = withMesh(h, (mesh) => {
        const vertices = raw.Mesh_nVertexCount(lib, mesh);
        const faces = raw.Mesh_nTriangleCount(lib, mesh);
        const bytes = Math.max(1, 12 * Math.max(vertices, faces));
        const p = module._malloc(bytes);
        try {
          raw.Mesh_GetVertices(lib, mesh, p, vertices);
          const vertexFnv = fnv1a(bytesAt(p, 12 * vertices));
          raw.Mesh_GetTriangles(lib, mesh, p, faces);
          const triangleFnv = fnv1a(bytesAt(p, 12 * faces));
          return { vertices, triangles: faces, vertexFnv, triangleFnv };
        } finally {
          module._free(p);
        }
      });
      runs.push({ volumeHex: hexFloat(raw.Voxels_fCalculateVolume(lib, h)), ...oracle });
      raw.Voxels_Destroy(lib, h);
    }
    const first = JSON.stringify(runs[0]);
    results[name] = { runs, stable: runs.every((r) => JSON.stringify(r) === first) };
    process.stderr.write(`  ${name}: ${results[name].stable ? 'STABLE' : 'UNSTABLE'} ${first}\n`);
  }
  return results;
}

// ── pass: memory ──────────────────────────────────────────────────────────────
/**
 * The 10^5-beam jungle gym the charter's memory question names: 33^3 nodes on a 3 mm
 * pitch, one strut to each +axis neighbour -> 3*33*33*32 = 104,544 round-capped beams,
 * authored through the bulk wire format (8 floats/beam, SK-0.3). Deterministic by
 * construction — no RNG anywhere.
 */
function beams1e5() {
  const N = 33;
  const PITCH = 3;
  const beams = [];
  const at = (i) => (i - (N - 1) / 2) * PITCH;
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      for (let z = 0; z < N; z++)
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]) {
          if (x + dx >= N || y + dy >= N || z + dz >= N) continue;
          beams.push(at(x), at(y), at(z), 0.5, at(x + dx), at(y + dy), at(z + dz), 0.5);
        }
  const count = beams.length / 8;
  const bytes = module._malloc(beams.length * 4 + count * 4);
  module.HEAPF32.set(beams, bytes >> 2);
  module.HEAPU32.fill(1, (bytes + beams.length * 4) >> 2, ((bytes + beams.length * 4) >> 2) + count);
  const lattice = raw.Lattice_hCreate(lib);
  raw.Lattice_AddBeams(lib, lattice, bytes, bytes + beams.length * 4, count);
  module._free(bytes);
  return { handle: lattice, beamCount: count, latticeMemUsage: Number(raw.Library_nLatticesMemUsage(lib)) };
}

async function memoryPass() {
  const spec = FIXTURE === 'beams-1e5' ? beams1e5() : (await extractedFixtures())['heatx:helical-void.hot'];
  if (!spec) throw new Error('memory pass needs the helical-void fixture');
  const before = heapBytes();
  const t0 = performance.now();
  const h = render(LANE === 'serial' ? 'Voxels_RenderLattice' : 'Voxels_RenderLatticeTubes', spec.handle);
  const ms = performance.now() - t0;
  const after = heapBytes();
  const volumeHex = hexFloat(raw.Voxels_fCalculateVolume(lib, h));
  raw.Voxels_Destroy(lib, h);
  return {
    lane: LANE,
    variant,
    fixture: FIXTURE,
    beamCount: spec.beamCount,
    latticeMemUsage: spec.latticeMemUsage,
    heapBeforeBytes: before,
    heapAfterBytes: after,
    heapGrowthBytes: after - before,
    renderMs: ms,
    volumeHex,
  };
}

// ── run ───────────────────────────────────────────────────────────────────────
const payload = { fingerprint };
if (has('--equivalence')) payload.equivalence = await equivalence();
if (has('--timing')) payload.timing = await timing();
if (has('--determinism')) payload.determinism = await determinism();
if (has('--memory')) payload.memory = await memoryPass();
fingerprint.endLoad = loadavg()[0];
fingerprint.endPower = battery();

const json = `${JSON.stringify(payload, null, 1)}\n`;
if (OUT) {
  mkdirSync(dirname(resolve(HERE, OUT)), { recursive: true });
  writeFileSync(resolve(HERE, OUT), json);
  process.stderr.write(`\nwrote ${OUT}\n`);
} else {
  process.stdout.write(json);
}
process.exit(0);
