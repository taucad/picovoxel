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
//             gyroid tape at 0.25 mm, on both builds, N per cell
//   record  — one record (building block; --jsonl for ledgers)
// The per-commit shape (N=2 + reference at {1.0, 0.7} mm) lives in the test
// suite: test/g0-gate.test.ts against test/fixtures/g0-reference.json.
//
// Host load is free ambient variance for identity runs: recorded, never
// controlled (§14.3). Identity work needs no pmset discipline — nothing here
// is a timing claim.
//
// Usage
//   node bench/g0-identity.mjs record --fixture heatx|gyroid --build single|multi --size S [--label L] [--jsonl F]
//   node bench/g0-identity.mjs triple --fixture F --build B --size S [--runs N] [--jsonl F]
//   node bench/g0-identity.mjs sweep [--runs N] [--jsonl F]
//   node bench/g0-identity.mjs selftest

import { appendFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** One full G0 record: fresh session, fixture, both oracles, environment. */
export async function g0Record({ fixture, build, size, label = undefined }) {
  const { createPico } = await import(build === 'multi' ? '../src/multi.ts' : '../src/index.ts');
  const loadBefore = loadavg()[0];
  const started = performance.now();
  const session = await createPico({ voxelSize: size });
  const voxels = await FIXTURES[fixture](session);
  const grid = voxels.gridHash();
  const mesh = voxels.toMesh();
  const stl = stlIdentity(mesh.toStl());
  const record = {
    label: label ?? `${fixture}@${size}mm/${build}`,
    fixture,
    build,
    size,
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
export async function runTriple({ fixture, build, size, runs, jsonl }) {
  const records = [];
  let failed = false;
  for (let run = 0; run < runs; run++) {
    const record = await g0Record({ fixture, build, size, label: `${fixture}@${size}mm/${build}#${run + 1}` });
    records.push(record);
    if (jsonl) appendFileSync(jsonl, JSON.stringify(record) + '\n');
    console.log(
      `${record.label.padEnd(28)} grid ${record.gridHash.slice(0, 16)}  multiset ${record.multiset.slice(0, 16)}  ` +
        `${record.triangles} tris  ${record.wallMs} ms  load ${record.loadBefore.toFixed(1)}`,
    );
    if (record.nonFiniteRecords > 0) {
      console.error(`  FAIL ${record.label}: ${record.nonFiniteRecords} non-finite records — never legitimate`);
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
      }
      // Cross-lane: single and multi are one geometry (Class 0/1 lanes).
      const differing = compareG0(firstOf.single, firstOf.multi);
      if (differing.length > 0) {
        console.error(`  FAIL cross-lane ${fixture}@${size}: [${differing.join(', ')}]`);
        failed = true;
      } else {
        console.log(`  cross-lane ${fixture}@${size}: single ≡ multi`);
      }
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
  if (compareG0(base, { ...base }).length !== 0) throw new Error('selftest: identical records must compare empty');
  for (const field of G0_FIELDS) {
    const mutated = { ...base, [field]: 'x' };
    if (!compareG0(base, mutated).includes(field)) throw new Error(`selftest: mutation of ${field} must be flagged`);
  }
  if (!oraclesAgree(base, { ...base })) throw new Error('selftest: identical records agree');
  if (!oraclesAgree(base, { ...base, gridHash: 'x', multiset: 'x' })) throw new Error('selftest: both-sides drift agrees');
  if (oraclesAgree(base, { ...base, gridHash: 'x' })) throw new Error('selftest: field-only drift must disagree');
  if (oraclesAgree(base, { ...base, multiset: 'x' })) throw new Error('selftest: mesh-only drift must disagree');
  console.log('g0-identity selftest: ok');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'selftest') {
    cmdSelftest();
  } else if (command === 'record') {
    const record = await g0Record({
      fixture: arg(rest, '--fixture', 'heatx'),
      build: arg(rest, '--build', 'single'),
      size: Number(arg(rest, '--size', '1.0')),
      label: arg(rest, '--label'),
    });
    console.log(JSON.stringify(record));
    const jsonl = arg(rest, '--jsonl');
    if (jsonl) appendFileSync(jsonl, JSON.stringify(record) + '\n');
  } else if (command === 'triple') {
    const { failed } = await runTriple({
      fixture: arg(rest, '--fixture', 'heatx'),
      build: arg(rest, '--build', 'single'),
      size: Number(arg(rest, '--size', '1.0')),
      runs: Number(arg(rest, '--runs', '3')),
      jsonl: arg(rest, '--jsonl'),
    });
    process.exitCode = failed ? 1 : 0;
  } else if (command === 'sweep') {
    const failed = await cmdSweep({ runs: Number(arg(rest, '--runs', '3')), jsonl: arg(rest, '--jsonl') });
    process.exitCode = failed ? 1 : 0;
  } else {
    console.error('usage: g0-identity.mjs record|triple|sweep|selftest [--fixture heatx|gyroid] [--build single|multi] [--size S] [--runs N] [--jsonl F]');
    process.exitCode = 2;
  }
}
