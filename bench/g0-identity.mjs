// SKv2-0 V0.1 — the G0 identity harness (NON-DETERMINISM.md §6, §14.3, §14.5).
//
// One "record" is the full G0 tuple for a fixture at a scale on a build lane:
//   canonical grid hash + active/inside counts   (in-module, src/pico-hash.cpp)
//   volume as a hex float64                       (raw grid volume — exact fn of the grid)
//   triangle/vertex counts                        (extracted mesh)
//   order-invariant mesh multiset hash            (bench/stl-identity.mjs, §14.5-reconciled)
//   nonFiniteRecords                              (hard health boolean — never folded away)
//
// The two oracles are deliberately redundant: the grid hash sees the field, the
// multiset sees the extracted mesh. On any identity pair they must AGREE — a
// grid-equal/mesh-unequal split means nondeterministic meshing, the reverse
// means mesh-blind field drift; either is reported as DISAGREE and fails the
// run (a charter exit assertion for V0.1).
//
// Shapes (§14.3):
//   triple  — run-to-run identity, N runs (default 3), one fixture/scale/build
//   sweep   — the release shape: HeatX at {1.0, 0.7, 0.5} mm + the M10-class
//             gyroid tape at 0.25 mm, on both builds, N per cell. Since
//             D-pre.6 every cell also runs the fast-lane legs: `{ lane:
//             'fast' }` triples gated by G1 (SK-0.8 tolerance shape: volume/
//             area ≤3%, bounds <1 voxel, checkLevelSet no dirtier than the
//             exact leg) against the exact reference, plus one `{ lane:
//             'fast', fastRenorm: false }` record that must be G0-identical
//             to L0 — the tighten-inside-fast comparability pattern (V0.5).
//   record  — one record (building block; --jsonl for ledgers)
// The per-commit shape (N=2 + reference at {1.0, 0.7} mm) lives in the test
// suite: test/g0-gate.test.ts against test/fixtures/g0-reference.json.
//
// Host load is free ambient variance for identity runs: recorded, never
// controlled (§14.3). Identity work needs no pmset discipline — nothing here
// is a timing claim.
//
// Usage
//   node bench/g0-identity.mjs record --fixture heatx|gyroid --build single|multi --size S [--lane L] [--fast-renorm true|false] [--label L] [--jsonl F]
//   node bench/g0-identity.mjs triple --fixture F --build B --size S [--runs N] [--lane L] [--fast-renorm true|false] [--jsonl F]
//   node bench/g0-identity.mjs sweep [--runs N] [--jsonl F]
//   node bench/g0-identity.mjs gate --jsonl F     (replay D-pre.6 verdicts from a recorded sweep)
//   node bench/g0-identity.mjs selftest

import { appendFileSync, readFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPinSource } from './pin-guard.mjs';
import { stlIdentity } from './stl-identity.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The G0 tuple fields; two records are one geometry iff all of them match. */
export const G0_FIELDS = [
  'gridHash',
  'activeVoxels',
  'insideTiles',
  'insideOffVoxels',
  'volumeHex',
  'triangles',
  'vertices',
  'multiset',
];

/** Field-by-field G0 comparison: [] = identical geometry. */
export function compareG0(a, b) {
  return G0_FIELDS.filter((field) => a[field] !== b[field]);
}

const unhexFloat = (hex) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

/**
 * D-pre.6 — is a record's mesh-round-trip measure self-consistent? The
 * SG1 rebuild (pico-props.cpp: mesh → fresh voxels → LevelSetMeasure) is the
 * corrected measure, but meshToLevelSet of a pathological mesh can leak
 * interior classification and report garbage: the D-pre.6 sweep caught the
 * exact-lane HeatX @ 0.7 mm rebuilt volume at 1.93× the live-grid volume
 * (healthy cells sit at 1.20–1.23×) with area collapsed 3.5×. Records whose
 * rebuilt/live ratio leaves (1/1.5, 1.5) are measure-unhealthy: their
 * mesh-measure gates are unusable, which the caller reports loudly.
 * ponytail: ratio heuristic with the observed 1.23-vs-1.93 separation; the
 * upgrade path is a real mesh self-intersection oracle.
 */
export function measureHealthy(record) {
  const live = unhexFloat(record.volumeHex);
  if (!(live > 0)) return record.propVolume === 0;
  const ratio = record.propVolume / live;
  return ratio > 1 / 1.5 && ratio < 1.5;
}

/**
 * D-pre.6 — the G1 tolerance gate (SK-0.8 shape, bench/results/webgpu-v2/
 * SK-0.8.md): a fast-lane record against its exact-lane reference.
 * - Live-grid volume (volumeHex, an exact function of each grid) within 3% —
 *   binds always; it is the robust leg of the volume gate.
 * - Mesh-round-trip volume and area (SG1 properties) within 3% — gated only
 *   when the exact reference is measureHealthy(); a fast-side-only pathology
 *   still fails loudly (that IS a lane regression signal).
 * - Bounds (mesh bbox — independent of the rebuild) within one voxel/axis.
 * - checkLevelSet no DIRTIER than the exact leg — when the exact output
 *   itself is non-clean (full-pipeline CSG kinks, the 0.7 mm float-width
 *   artifact), inherited dirt is a caller-reported warning, not a failure.
 */
export function compareG1(fast, exact, voxelSize) {
  const failures = [];
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  if (rel(unhexFloat(fast.volumeHex), unhexFloat(exact.volumeHex)) >= 0.03)
    failures.push(`live volume ${unhexFloat(fast.volumeHex)} vs ${unhexFloat(exact.volumeHex)}`);
  if (measureHealthy(exact)) {
    if (rel(fast.propVolume, exact.propVolume) >= 0.03)
      failures.push(`volume ${fast.propVolume} vs ${exact.propVolume}`);
    if (rel(fast.propArea, exact.propArea) >= 0.03)
      failures.push(`area ${fast.propArea} vs ${exact.propArea}`);
  }
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(fast.boundsMin[axis] - exact.boundsMin[axis]) >= voxelSize)
      failures.push(`bounds.min[${axis}] ${fast.boundsMin[axis]} vs ${exact.boundsMin[axis]}`);
    if (Math.abs(fast.boundsMax[axis] - exact.boundsMax[axis]) >= voxelSize)
      failures.push(`bounds.max[${axis}] ${fast.boundsMax[axis]} vs ${exact.boundsMax[axis]}`);
  }
  if (fast.diagnose !== '' && exact.diagnose === '') failures.push(`checkLevelSet: ${fast.diagnose}`);
  return failures;
}

/**
 * The oracle-agreement check (V0.1 exit assertion): the field-side oracle
 * (grid hash + counts + volume) and the mesh-side oracle (multiset + counts)
 * must render the same verdict on every pair.
 */
export function oraclesAgree(a, b) {
  const differing = compareG0(a, b);
  const fieldSide = ['gridHash', 'activeVoxels', 'insideTiles', 'insideOffVoxels', 'volumeHex'];
  const meshSide = ['triangles', 'vertices', 'multiset'];
  const fieldSame = !differing.some((f) => fieldSide.includes(f));
  const meshSame = !differing.some((f) => meshSide.includes(f));
  return fieldSame === meshSame;
}

// M10-class fixture: the gyroid tape (bench/run.mjs M10 — the only SDF shape
// reachable from pthread workers, and the trig-heavy Wave-D denominator).
const GYROID_SCALE = (2 * Math.PI) / 10;
const GYROID = [
  '-',
  [
    'abs',
    [
      '+',
      ['*', ['sin', ['*', 'x', GYROID_SCALE]], ['cos', ['*', 'y', GYROID_SCALE]]],
      ['*', ['sin', ['*', 'y', GYROID_SCALE]], ['cos', ['*', 'z', GYROID_SCALE]]],
      ['*', ['sin', ['*', 'z', GYROID_SCALE]], ['cos', ['*', 'x', GYROID_SCALE]]],
    ],
  ],
  0.4,
];

const FIXTURES = {
  heatx: async (session) => {
    const { task } = await import('../examples/helixheatx/run.ts');
    return task(session).voxels;
  },
  gyroid: (session) =>
    session.createVoxels({
      shape: 'implicit',
      boundsMin: [-12, -12, -12],
      boundsMax: [12, 12, 12],
      sdf: GYROID,
    }),
};

const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

/** openvdb's own tools::checkLevelSet, '' = clean (the SK-0.8 hard gate). */
function diagnose(session, voxels) {
  const bDiagnose = session.module.cwrap('Voxels_bDiagnose', 'boolean', ['bigint', 'bigint', 'number']);
  const p = session.module._malloc(255);
  try {
    bDiagnose(session.handle, voxels.handle, p);
    return session.module.UTF8ToString(p);
  } finally {
    session.module._free(p);
  }
}

/** One full G0 record: fresh session, fixture, both oracles, environment.
 * `lane`/`fastRenorm` thread through to createPico (D-pre.6 fast-lane legs);
 * `g1: true` additionally captures the G1 inputs (SG1 properties +
 * checkLevelSet) — opt-in so the per-commit g0 gate stays lean. */
export async function g0Record({
  fixture,
  build,
  size,
  lane = undefined,
  fastRenorm = undefined,
  g1 = false,
  label = undefined,
}) {
  const { createPico } = await import(build === 'multi' ? '../src/multi.ts' : '../src/index.ts');
  const loadBefore = loadavg()[0];
  const started = performance.now();
  const session = await createPico({
    voxelSize: size,
    ...(lane !== undefined && { lane }),
    ...(fastRenorm !== undefined && { fastRenorm }),
  });
  const voxels = await FIXTURES[fixture](session);
  const grid = voxels.gridHash();
  const mesh = voxels.toMesh();
  // The harness is an oracle consumer, not an export path: acknowledge fast
  // provenance explicitly (V0.5 boundary) — the identity math is lane-blind.
  const stl = stlIdentity(mesh.toStl(mesh.lane === 'fast' ? { acceptLane: 'fast' } : undefined));
  const props = g1 ? voxels.properties() : undefined;
  const laneTag = lane === undefined ? '' : `:${lane}${fastRenorm === false ? '-tight' : ''}`;
  const record = {
    label: label ?? `${fixture}@${size}mm/${build}${laneTag}`,
    fixture,
    build,
    size,
    lane: session.lane,
    provenance: mesh.lane, // value provenance (LUB over the fixture) — what pin writers assert on
    gridHash: grid.hash,
    activeVoxels: grid.activeVoxels,
    insideTiles: grid.insideTiles,
    insideOffVoxels: grid.insideOffVoxels,
    volumeHex: hexFloat(voxels.volume),
    triangles: mesh.triangleCount,
    vertices: mesh.vertexCount,
    multiset: stl.multiset,
    nonFiniteRecords: stl.nonFiniteRecords,
    stlBytes: stl.stlBytes,
    ...(g1 && {
      propVolume: props.volume,
      propArea: props.area,
      boundsMin: props.bounds.min,
      boundsMax: props.bounds.max,
      diagnose: diagnose(session, voxels),
    }),
    threads: (session.module.PThread?.runningWorkers.length ?? 0) + 1,
    wallMs: Math.round(performance.now() - started),
    cpu: `${cpus()[0]?.model} x${cpus().length}`,
    ram: `${Math.round(totalmem() / 2 ** 30)}GiB`,
    os: `${platform()} ${release()}`,
    node: process.version,
    loadBefore,
    loadAfter: loadavg()[0],
    date: new Date().toISOString(),
  };
  session.dispose();
  return record;
}

/** N-run identity: exit 0 = every pair G0-identical, oracles agreeing, no NaN. */
export async function runTriple({
  fixture,
  build,
  size,
  runs,
  jsonl,
  lane = undefined,
  fastRenorm = undefined,
  g1 = false,
}) {
  const laneTag = lane === undefined ? '' : `:${lane}${fastRenorm === false ? '-tight' : ''}`;
  const records = [];
  let failed = false;
  for (let run = 0; run < runs; run++) {
    const record = await g0Record({
      fixture,
      build,
      size,
      lane,
      fastRenorm,
      g1,
      label: `${fixture}@${size}mm/${build}${laneTag}#${run + 1}`,
    });
    records.push(record);
    if (jsonl) appendFileSync(jsonl, JSON.stringify(record) + '\n');
    console.log(
      `${record.label.padEnd(28)} grid ${record.gridHash.slice(0, 16)}  multiset ${record.multiset.slice(0, 16)}  ` +
        `${record.triangles} tris  ${record.wallMs} ms  load ${record.loadBefore.toFixed(1)}`,
    );
    if (record.nonFiniteRecords > 0) {
      console.error(
        `  FAIL ${record.label}: ${record.nonFiniteRecords} non-finite records — never legitimate`,
      );
      failed = true;
    }
  }
  for (let i = 1; i < records.length; i++) {
    const differing = compareG0(records[0], records[i]);
    if (!oraclesAgree(records[0], records[i])) {
      console.error(`  DISAGREE run 1 vs ${i + 1}: field/mesh oracles split on [${differing.join(', ')}]`);
      failed = true;
    } else if (differing.length > 0) {
      console.error(`  FAIL run 1 vs ${i + 1}: G0 mismatch on [${differing.join(', ')}]`);
      failed = true;
    }
  }
  if (!failed) console.log(`  G0-identical x${records.length}, oracles agree`);
  return { records, failed };
}

const SWEEP = [
  { fixture: 'heatx', sizes: [1.0, 0.7, 0.5] },
  { fixture: 'gyroid', sizes: [0.25] },
];

async function cmdSweep({ runs, jsonl }) {
  let failed = false;
  for (const { fixture, sizes } of SWEEP) {
    for (const size of sizes) {
      const firstOf = {};
      for (const build of ['single', 'multi']) {
        const result = await runTriple({ fixture, build, size, runs, jsonl });
        failed ||= result.failed;
        firstOf[build] = result.records[0];
        // LANES item 3 — this record is the exact reference every fast leg is gated against.
        assertPinSource(firstOf[build].provenance, `${fixture}@${size}mm/${build} reference`);
      }
      // Cross-lane: single and multi are one geometry (Class 0/1 lanes).
      const differing = compareG0(firstOf.single, firstOf.multi);
      if (differing.length > 0) {
        console.error(`  FAIL cross-lane ${fixture}@${size}: [${differing.join(', ')}]`);
        failed = true;
      } else {
        console.log(`  cross-lane ${fixture}@${size}: single ≡ multi`);
      }

      // D-pre.6 — the fast-lane legs (V0.5 §14.1). The F lane keeps run-to-run
      // identity (runTriple) and is G1-gated against the exact reference of
      // the same build; a G0-coincident fast leg (no Class-2 op executed) is
      // reported as such.
      for (const build of ['single', 'multi']) {
        const result = await runTriple({ fixture, build, size, runs, jsonl, lane: 'fast', g1: true });
        failed ||= result.failed;
        failed = fastLegVerdict(result.records[0], firstOf[build], { fixture, build, size }) || failed;
      }
      // Tighten-inside-fast: { lane: 'fast', fastRenorm: false } expresses
      // cross-lane byte comparability — it must be G0-identical to L0.
      const tight = await g0Record({ fixture, build: 'single', size, lane: 'fast', fastRenorm: false });
      if (jsonl) appendFileSync(jsonl, JSON.stringify(tight) + '\n');
      failed = tightLegVerdict(tight, firstOf.single, { fixture, size }) || failed;
    }
  }
  return failed;
}

/** D-pre.6 verdict for one fast leg vs its exact reference. Returns failed. */
export function fastLegVerdict(fast, exact, { fixture, build, size }) {
  if (!measureHealthy(exact)) {
    console.log(
      `  WARN ${fixture}@${size}/${build}: exact reference is measure-UNHEALTHY ` +
        `(rebuilt ${exact.propVolume} vs live ${unhexFloat(exact.volumeHex)}) — mesh-measure gates skipped`,
    );
  }
  const g1 = compareG1(fast, exact, size);
  if (g1.length > 0) {
    console.error(`  FAIL G1 fast/${build} ${fixture}@${size}: ${g1.join('; ')}`);
    return true;
  }
  const coincident = compareG0(fast, exact).length === 0;
  const dirt =
    fast.diagnose !== ''
      ? ` (WARN inherited checkLevelSet dirt: exact "${exact.diagnose}" fast "${fast.diagnose}")`
      : '';
  console.log(
    `  G1 fast/${build} ${fixture}@${size}: gates clean${coincident ? ' (G0-coincident)' : ''}${dirt}`,
  );
  return false;
}

/** D-pre.6 verdict for the tighten-inside-fast leg. Returns failed. */
export function tightLegVerdict(tight, exactSingle, { fixture, size }) {
  const differing = compareG0(tight, exactSingle);
  if (differing.length > 0) {
    console.error(
      `  FAIL tighten-inside-fast ${fixture}@${size}: [${differing.join(', ')}] — fast+fastRenorm:false must be hash-identical to L0`,
    );
    return true;
  }
  console.log(`  tighten-inside-fast ${fixture}@${size}: ≡ L0`);
  return false;
}

/** Replay the D-pre.6 verdicts from a recorded sweep JSONL — pure record
 * math, no geometry reruns (the gates are functions of the records). */
export function replayGates(jsonlPath) {
  const rows = readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const firstByLeg = {};
  for (const row of rows) {
    const leg = row.label.split('#')[0];
    firstByLeg[leg] ??= row;
  }
  let failed = false;
  for (const { fixture, sizes } of SWEEP) {
    for (const size of sizes) {
      const leg = (suffix) => firstByLeg[`${fixture}@${size}mm/${suffix}`];
      for (const build of ['single', 'multi']) {
        const fast = leg(`${build}:fast`);
        const exact = leg(build);
        if (!fast || !exact) continue;
        failed = fastLegVerdict(fast, exact, { fixture, build, size }) || failed;
      }
      const tight = leg('single:fast-tight');
      if (tight && leg('single')) failed = tightLegVerdict(tight, leg('single'), { fixture, size }) || failed;
    }
  }
  return failed;
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

/** ponytail: assert-based self-check of the comparator — the gate logic itself. */
function cmdSelftest() {
  const base = Object.fromEntries(G0_FIELDS.map((f) => [f, 'v']));
  if (compareG0(base, { ...base }).length !== 0)
    throw new Error('selftest: identical records must compare empty');
  for (const field of G0_FIELDS) {
    const mutated = { ...base, [field]: 'x' };
    if (!compareG0(base, mutated).includes(field))
      throw new Error(`selftest: mutation of ${field} must be flagged`);
  }
  if (!oraclesAgree(base, { ...base })) throw new Error('selftest: identical records agree');
  if (!oraclesAgree(base, { ...base, gridHash: 'x', multiset: 'x' }))
    throw new Error('selftest: both-sides drift agrees');
  if (oraclesAgree(base, { ...base, gridHash: 'x' }))
    throw new Error('selftest: field-only drift must disagree');
  if (oraclesAgree(base, { ...base, multiset: 'x' }))
    throw new Error('selftest: mesh-only drift must disagree');
  // compareG1 — the D-pre.6 tolerance comparator. hexFloat(100) makes the
  // live and rebuilt volumes agree (ratio 1 — measure-healthy).
  const g1 = {
    volumeHex: hexFloat(100),
    propVolume: 100,
    propArea: 50,
    boundsMin: [0, 0, 0],
    boundsMax: [10, 10, 10],
    diagnose: '',
  };
  if (compareG1(g1, g1, 0.5).length !== 0) throw new Error('selftest: identical G1 records must pass');
  if (compareG1({ ...g1, propVolume: 102.9 }, g1, 0.5).length !== 0)
    throw new Error('selftest: 2.9% volume drift passes');
  if (compareG1({ ...g1, propVolume: 103.1 }, g1, 0.5).length === 0)
    throw new Error('selftest: 3.1% volume drift must fail');
  if (compareG1({ ...g1, propArea: 48.4 }, g1, 0.5).length === 0)
    throw new Error('selftest: 3.2% area drift must fail');
  if (compareG1({ ...g1, boundsMax: [10, 10, 10.6] }, g1, 0.5).length === 0)
    throw new Error('selftest: >1 voxel bounds drift must fail');
  if (compareG1({ ...g1, boundsMin: [-0.4, 0, 0] }, g1, 0.5).length !== 0)
    throw new Error('selftest: <1 voxel bounds drift passes');
  if (compareG1({ ...g1, diagnose: 'dirty' }, g1, 0.5).length === 0)
    throw new Error('selftest: fast-only checkLevelSet dirt must fail');
  if (compareG1({ ...g1, diagnose: 'dirty' }, { ...g1, diagnose: 'dirty' }, 0.5).length !== 0)
    throw new Error('selftest: inherited dirt is a warning, not a lane regression');
  // measureHealthy + the live-volume gate (the 0.7 mm pathology shape).
  if (!measureHealthy(g1)) throw new Error('selftest: ratio-1 record is measure-healthy');
  const sick = { ...g1, propVolume: 193 }; // rebuilt 1.93× live — the observed pathology
  if (measureHealthy(sick)) throw new Error('selftest: 1.93× rebuilt/live must be measure-unhealthy');
  if (compareG1(g1, sick, 0.5).length !== 0)
    throw new Error('selftest: unhealthy reference skips mesh-measure gates (live volumes agree)');
  if (compareG1({ ...g1, volumeHex: hexFloat(104) }, sick, 0.5).length === 0)
    throw new Error('selftest: the live-volume gate still binds under an unhealthy reference');
  if (compareG1(sick, g1, 0.5).length === 0)
    throw new Error('selftest: a fast-side-only measure pathology must fail loudly');
  console.log('g0-identity selftest: ok');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'selftest') {
    cmdSelftest();
  } else if (command === 'gate') {
    process.exitCode = replayGates(arg(rest, '--jsonl')) ? 1 : 0;
  } else if (command === 'record') {
    const fr = arg(rest, '--fast-renorm');
    const record = await g0Record({
      fixture: arg(rest, '--fixture', 'heatx'),
      build: arg(rest, '--build', 'single'),
      size: Number(arg(rest, '--size', '1.0')),
      lane: arg(rest, '--lane'),
      fastRenorm: fr === undefined ? undefined : fr === 'true',
      g1: rest.includes('--g1'),
      label: arg(rest, '--label'),
    });
    console.log(JSON.stringify(record));
    const jsonl = arg(rest, '--jsonl');
    if (jsonl) appendFileSync(jsonl, JSON.stringify(record) + '\n');
  } else if (command === 'triple') {
    const fr = arg(rest, '--fast-renorm');
    const { failed } = await runTriple({
      fixture: arg(rest, '--fixture', 'heatx'),
      build: arg(rest, '--build', 'single'),
      size: Number(arg(rest, '--size', '1.0')),
      runs: Number(arg(rest, '--runs', '3')),
      jsonl: arg(rest, '--jsonl'),
      lane: arg(rest, '--lane'),
      fastRenorm: fr === undefined ? undefined : fr === 'true',
      g1: rest.includes('--g1'),
    });
    process.exitCode = failed ? 1 : 0;
  } else if (command === 'sweep') {
    const failed = await cmdSweep({ runs: Number(arg(rest, '--runs', '3')), jsonl: arg(rest, '--jsonl') });
    process.exitCode = failed ? 1 : 0;
  } else {
    console.error(
      'usage: g0-identity.mjs record|triple|sweep|gate|selftest [--fixture heatx|gyroid] [--build single|multi] [--size S] [--runs N] [--lane exact|fast|auto] [--fast-renorm true|false] [--g1] [--jsonl F]',
    );
    process.exitCode = 2;
  }
}
