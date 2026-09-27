// SKv2-0 V0.11 — P8 batched queries. Gates from the charter row:
// batch ≡ serial EXACT per ray (the serial export is the oracle); hit/miss
// 100% off-grazing; closest-point in-band and within one voxel of the true
// minimum (the SDF/analytic sphere is its own oracle).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
});
afterAll(() => pk.dispose());

test('raycastBatch ≡ serial raycastToSurface, exact per ray, hit/miss 100% off-grazing', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const origins: number[] = [];
  const directions: number[] = [];
  const cases: [number, number, number, number, number, number][] = [];
  // 26 off-grazing directions from outside toward (and away from) the sphere.
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue;
        const n = Math.hypot(dx, dy, dz);
        cases.push([14 * (dx / n), 14 * (dy / n), 14 * (dz / n), -dx / n, -dy / n, -dz / n]); // inward: hit
        cases.push([14 * (dx / n), 14 * (dy / n), 14 * (dz / n), dx / n, dy / n, dz / n]); // outward: miss
      }
  for (const c of cases) {
    origins.push(c[0], c[1], c[2]);
    directions.push(c[3], c[4], c[5]);
  }
  const { hits, hit } = sphere.raycastBatch({ origins, directions });
  let hitCount = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const serial = sphere.raycastToSurface([c[0], c[1], c[2]], [c[3], c[4], c[5]]);
    assert.equal(hit[i] === 1, serial !== null, `ray ${i}: hit/miss must match the serial oracle`);
    if (serial) {
      hitCount++;
      for (let axis = 0; axis < 3; axis++) {
        assert.equal(hits[i * 3 + axis], serial[axis], `ray ${i} axis ${axis}: batch must be EXACT vs serial`);
      }
    }
  }
  assert.equal(hitCount, cases.length / 2, 'every inward ray hits, every outward ray misses (off-grazing)');
});

test('closestPointsOnSurface: sub-voxel, in-band, within one voxel of the true minimum', () => {
  const radius = 8;
  const sphere = pk.createVoxels({ shape: 'sphere', radius });
  const queries: number[] = [];
  const expected: number[] = []; // true distance to the surface per query
  for (const [x, y, z] of [
    [12, 0, 0], [0, -11, 3], [4, 4, 4], [0, 0, 0.5], [9, 9, 0], [-2, 1, 7],
  ] as const) {
    queries.push(x, y, z);
    expected.push(Math.abs(Math.hypot(x, y, z) - radius));
  }
  const { points, found } = sphere.closestPointsOnSurface({ points: queries });
  for (let i = 0; i < expected.length; i++) {
    assert.equal(found[i], 1, `query ${i} must find the surface`);
    const px = points[i * 3]!, py = points[i * 3 + 1]!, pz = points[i * 3 + 2]!;
    // The returned point lies on the analytic surface within a voxel…
    assert.ok(Math.abs(Math.hypot(px, py, pz) - radius) <= pk.voxelSize, `query ${i}: result must be in-band (|r|=${Math.hypot(px, py, pz)})`);
    // …and realizes the true minimum within a voxel.
    const qx = queries[i * 3]!, qy = queries[i * 3 + 1]!, qz = queries[i * 3 + 2]!;
    const dist = Math.hypot(px - qx, py - qy, pz - qz);
    assert.ok(Math.abs(dist - expected[i]!) <= pk.voxelSize, `query ${i}: |realized−true| = ${Math.abs(dist - expected[i]!)}`);
  }
});

test('batch inputs must be matching xyz triples', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  assert.throws(
    () => sphere.raycastBatch({ origins: [0, 0, 0], directions: [1, 0] }),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT',
  );
  assert.throws(
    () => sphere.closestPointsOnSurface({ points: [1, 2] }),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT',
  );
});
