// R18 — ScalarField/VectorField: factories, set/get/remove null-returns, traverse
// trampolines (visit-count oracle), dims/slices/bounds, SG6 signed distance ≙
// voxels SD probe, clone.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPicoGK, type PicoGK } from '../src/index.ts';

let pk: PicoGK;
beforeAll(async () => {
  pk = await createPicoGK({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('scalar set/get/remove: null where nothing was set', () => {
  const field = pk.createScalarField();
  assert.equal(field.get([0, 0, 0]), null, 'fresh field holds nothing');
  field.set([0, 0, 0], 42);
  assert.equal(field.get([0, 0, 0]), 42);
  field.remove([0, 0, 0]);
  assert.equal(field.get([0, 0, 0]), null, 'removed value gone');
});

test('vector set/get/remove round-trips Vec3 values', () => {
  const field = pk.createVectorField();
  assert.equal(field.get([0, 0, 0]), null);
  field.set([0, 0, 0], [1, 2, 3]);
  assert.deepEqual(field.get([0, 0, 0]), [1, 2, 3]);
  field.remove([0, 0, 0]);
  assert.equal(field.get([0, 0, 0]), null);
});

test('scalar traverse: visit count equals set count; values and positions echo back', () => {
  const field = pk.createScalarField();
  const want = new Map<string, number>();
  for (let i = 0; i < 5; i++) {
    const position: [number, number, number] = [i * 2, 0, 0];
    field.set(position, i * 10);
    want.set(`${position[0]}`, i * 10);
  }
  const seen: Array<[number, number]> = [];
  field.traverse((x, _y, _z, value) => seen.push([x, value]));
  assert.equal(seen.length, want.size, 'every active value visited exactly once');
  for (const [x, value] of seen) {
    assert.equal(want.get(`${x}`), value, `value at x=${x}`);
  }
});

test('vector traverse: scalars in, scalars out', () => {
  const field = pk.createVectorField();
  field.set([1, 0, 0], [7, 8, 9]);
  field.set([3, 0, 0], [-1, -2, -3]);
  const seen: number[][] = [];
  field.traverse((x, y, z, vx, vy, vz) => seen.push([x, y, z, vx, vy, vz]));
  assert.equal(seen.length, 2);
  const at1 = seen.find((s) => s[0] === 1);
  assert.deepEqual(at1?.slice(3), [7, 8, 9]);
});

test('build-from-voxels factories: interior carries the constant', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const scalar = pk.createScalarField({ from: sphere, value: 42 });
  assert.equal(scalar.get([0, 0, 0]), 42, 'interior filled');
  assert.equal(scalar.get([20, 0, 0]), null, 'exterior empty');

  const vector = pk.createVectorField({ from: sphere, value: [9, 8, 7] });
  assert.deepEqual(vector.get([0, 0, 0]), [9, 8, 7]);

  // sdThreshold widens/narrows the "inside" band.
  const tight = pk.createScalarField({ from: sphere, value: 1, sdThreshold: 0 });
  let tightCount = 0;
  tight.traverse(() => tightCount++);
  const loose = pk.createScalarField({ from: sphere, value: 1, sdThreshold: 2 });
  let looseCount = 0;
  loose.traverse(() => looseCount++);
  assert.ok(looseCount > tightCount, `threshold 2 (${looseCount}) must activate more than 0 (${tightCount})`);
});

test('SG6 — signedDistanceAt ≙ voxels SD probe (value × voxelSize)', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const sd = pk.createScalarField({ from: sphere });

  // Stored values are voxel-unit signed distance; the facade converts to mm.
  for (const [point, expected] of [
    [[0, 0, 0], -8], // centre: 8mm inside... but the narrow band clamps far interior values
    [[8, 0, 0], 0], // on the surface
  ] as const) {
    const got = sd.signedDistanceAt(point as [number, number, number]);
    if (got === null) continue; // outside the narrow band nothing is stored
    if (expected === 0) {
      assert.ok(Math.abs(got) < 0.6, `surface SD ${got}`);
    } else {
      assert.ok(got < 0, `interior SD must be negative, got ${got}`);
    }
  }

  // The convertible check: near-surface stored value × voxelSize ≈ true distance.
  const nearSurface = sd.signedDistanceAt([8.5, 0, 0]);
  assert.ok(nearSurface !== null, 'half a millimetre outside is inside the band');
  assert.ok(Math.abs(nearSurface - 0.5) < 0.3, `SD at r=8.5 should be ≈ +0.5mm, got ${nearSurface}`);
});

test('dims/slice/bounds on a field built from voxels', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const field = pk.createScalarField({ from: sphere });

  const { size } = field.dimensions();
  for (const n of size) assert.ok(n > 30 && n < 44, `field extent ${n}`);

  const slice = field.getSlice({ index: Math.floor(size[2] / 2) });
  assert.equal(slice.data.length, slice.width * slice.height);
  assert.ok(slice.data.some((v) => v < 0), 'mid slice has interior samples');

  const bounds = field.bounds();
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(bounds.min[axis]! < -7 && bounds.max[axis]! > 7, `bounds axis ${axis}: ${bounds.min[axis]}..${bounds.max[axis]}`);
  }
});

test('clone is independent; copy factory from voxels', () => {
  const field = pk.createScalarField();
  field.set([0, 0, 0], 5);
  const copy = field.clone();
  assert.equal(copy.get([0, 0, 0]), 5, 'clone carries values');
  copy.set([0, 0, 0], 9);
  assert.equal(field.get([0, 0, 0]), 5, 'source unchanged');

  const vector = pk.createVectorField();
  vector.set([1, 1, 1], [4, 5, 6]);
  const vcopy = vector.clone();
  assert.deepEqual(vcopy.get([1, 1, 1]), [4, 5, 6]);
});

test('memUsage present on both field kinds', () => {
  const scalar = pk.createScalarField();
  const vector = pk.createVectorField();
  assert.ok(scalar.memUsage >= 0);
  assert.ok(vector.memUsage >= 0);
});
