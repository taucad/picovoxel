// The record math behind the identity harness (bench/g0-identity.mjs) and the
// per-commit identity gate (test/g0-gate.test.ts): comparisons, tolerance gates
// and verdicts over recorded tuples. Pure functions of the records, so they are
// unit-tested (test/g0-compare.test.mjs) and measured by the coverage gate;
// geometry runs stay in the harness.

import { readFileSync } from 'node:fs';

/** The identity tuple (G0) fields; two records are one geometry iff all of them match. */
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
 * Is a record's mesh-round-trip measure self-consistent? The rebuild
 * (pico-props.cpp: mesh → fresh voxels → LevelSetMeasure) is the corrected
 * measure, but meshToLevelSet of a pathological mesh can leak interior
 * classification: one exact-lane HeatX @ 0.7 mm sweep rebuilt the volume at
 * 1.93× the live-grid volume (healthy cells sit at 1.20–1.23×) with area
 * collapsed 3.5×. Records whose rebuilt/live ratio leaves (1/1.5, 1.5) are
 * measure-unhealthy: their mesh-measure gates are unusable, which the caller
 * reports loudly.
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
 * The G1 tolerance gate: a fast-lane record against its exact-lane reference.
 * - Live-grid volume (volumeHex, an exact function of each grid) within 3% —
 *   binds always; it is the robust leg of the volume gate.
 * - Mesh-round-trip volume and area within 3% — gated only when the exact
 *   reference is measureHealthy(); a fast-side-only pathology still fails
 *   loudly (that IS a lane regression signal).
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
 * The oracle-agreement check: the field-side oracle
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

/** A float64 as 16 hex digits of its bit pattern: exact, and diffable as text. */
export const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

/** The release sweep: fixtures and voxel sizes, each run on both builds. */
export const SWEEP = [
  { fixture: 'heatx', sizes: [1.0, 0.7, 0.5] },
  { fixture: 'gyroid', sizes: [0.25] },
];

/** The verdict for one fast-lane leg against its exact reference. Returns failed. */
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

/** The verdict for the tighten-inside-fast leg. Returns failed. */
export function tightLegVerdict(tight, exactSingle, { fixture, size }) {
  const differing = compareG0(tight, exactSingle);
  if (differing.length > 0) {
    console.error(
      `  FAIL tighten-inside-fast ${fixture}@${size}: [${differing.join(', ')}] — fast+fastRenorm:false must be hash-identical to the exact reference`,
    );
    return true;
  }
  console.log(`  tighten-inside-fast ${fixture}@${size}: ≡ exact reference`);
  return false;
}

/** Replay the fast-lane verdicts from a recorded sweep JSONL — pure record
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
