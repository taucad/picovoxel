// The identity harness (G0): run-to-run and cross-build geometry identity.
//
// One "record" is the full identity tuple for a fixture at a scale on a build:
//   canonical grid hash + active/inside counts   (in-module, src/pico-hash.cpp)
//   volume as a hex float64                       (raw grid volume — exact fn of the grid)
//   triangle/vertex counts                        (extracted mesh)
//   order-invariant mesh multiset hash            (bench/stl-multiset.mjs)
//   nonFiniteRecords                              (hard health counter — never folded away)
//
// The two oracles are deliberately redundant: the grid hash sees the field, the
// multiset sees the extracted mesh. On any identity pair they must AGREE — a
// grid-equal/mesh-unequal split means nondeterministic meshing, the reverse
// means mesh-blind field drift; either is reported as DISAGREE and fails the
// run. The comparisons and verdicts live in bench/g0-compare.mjs.
//
// Shapes:
//   triple  — run-to-run identity, N runs (default 3), one fixture/scale/build
//   sweep   — the release shape: HeatX at {1.0, 0.7, 0.5} mm + the gyroid tape
//             at 0.25 mm, on both builds, N per cell. Every cell also runs the
//             fast-lane legs: `{ lane: 'fast' }` triples gated by G1 (the
//             fastRenorm tolerance shape: volume/area ≤3%, bounds <1 voxel,
//             checkLevelSet no dirtier than the exact leg) against the exact
//             reference, plus one `{ lane: 'fast', fastRenorm: false }` record
//             that must be identical to the exact reference — tightening
//             inside a fast session restores byte comparability.
//   record  — one record (building block; --jsonl for ledgers)
// The per-commit shape (N=2 + reference at {1.0, 0.7} mm) lives in the test
// suite: test/g0-gate.test.ts against test/fixtures/g0-reference.json.
//
// Host load is free ambient variance for identity runs: recorded, never
// controlled. Identity work needs no pmset discipline — nothing here
// is a timing claim.
//
// Usage
//   node bench/g0-identity.mjs record --fixture heatx|gyroid --build single|multi --size S [--lane L] [--fast-renorm true|false] [--label L] [--jsonl F]
//   node bench/g0-identity.mjs triple --fixture F --build B --size S [--runs N] [--lane L] [--fast-renorm true|false] [--jsonl F]
//   node bench/g0-identity.mjs sweep [--runs N] [--jsonl F]
//   node bench/g0-identity.mjs gate --jsonl F     (replay the fast-lane verdicts from a recorded sweep)

import { appendFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SWEEP,
  compareG0,
  fastLegVerdict,
  hexFloat,
  oraclesAgree,
  replayGates,
  tightLegVerdict,
} from './g0-compare.mjs';
import { assertPinSource } from './pin-guard.mjs';
import { stlIdentity } from './stl-multiset.mjs';

// The gyroid tape (the bench/run.mjs M10 subject): the only SDF shape reachable
// from pthread workers, and trig-heavy.
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

/** openvdb's own tools::checkLevelSet, '' = clean (the fastRenorm hard gate). */
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
 * `lane`/`fastRenorm` thread through to createPico (the fast-lane legs);
 * `g1: true` additionally captures the G1 inputs (corrected properties +
 * checkLevelSet) — opt-in so the per-commit g0 gate stays lean.
 * @param {{ fixture: string, build: string, size: number, lane?: string, fastRenorm?: boolean, g1?: boolean, label?: string }} options
 */
export async function g0Record({ fixture, build, size, lane, fastRenorm, g1 = false, label }) {
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
  // provenance explicitly (the export boundary) — the identity math is lane-blind.
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
export async function runTriple({ fixture, build, size, runs, jsonl, lane, fastRenorm, g1 = false }) {
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

async function cmdSweep({ runs, jsonl }) {
  let failed = false;
  for (const { fixture, sizes } of SWEEP) {
    for (const size of sizes) {
      const firstOf = {};
      for (const build of ['single', 'multi']) {
        const result = await runTriple({ fixture, build, size, runs, jsonl });
        failed ||= result.failed;
        firstOf[build] = result.records[0];
        // Pin guard: this record is the exact reference every fast leg is gated against.
        assertPinSource(firstOf[build].provenance, `${fixture}@${size}mm/${build} reference`);
      }
      // Cross-build: single and multi are one geometry.
      const differing = compareG0(firstOf.single, firstOf.multi);
      if (differing.length > 0) {
        console.error(`  FAIL cross-lane ${fixture}@${size}: [${differing.join(', ')}]`);
        failed = true;
      } else {
        console.log(`  cross-lane ${fixture}@${size}: single ≡ multi`);
      }

      // The fast-lane legs. The fast lane keeps run-to-run identity
      // (runTriple) and is G1-gated against the exact reference of the same
      // build; a G0-coincident fast leg (no value-changing op executed) is
      // reported as such.
      for (const build of ['single', 'multi']) {
        const result = await runTriple({ fixture, build, size, runs, jsonl, lane: 'fast', g1: true });
        failed ||= result.failed;
        failed = fastLegVerdict(result.records[0], firstOf[build], { fixture, build, size }) || failed;
      }
      // Tighten-inside-fast: { lane: 'fast', fastRenorm: false } expresses
      // cross-lane byte comparability — it must be G0-identical to the exact reference.
      const tight = await g0Record({ fixture, build: 'single', size, lane: 'fast', fastRenorm: false });
      if (jsonl) appendFileSync(jsonl, JSON.stringify(tight) + '\n');
      failed = tightLegVerdict(tight, firstOf.single, { fixture, size }) || failed;
    }
  }
  return failed;
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'gate') {
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
      'usage: g0-identity.mjs record|triple|sweep|gate [--fixture heatx|gyroid] [--build single|multi] [--size S] [--runs N] [--lane exact|fast|auto] [--fast-renorm true|false] [--g1] [--jsonl F]',
    );
    process.exitCode = 2;
  }
}
