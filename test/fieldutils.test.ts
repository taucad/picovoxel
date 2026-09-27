// R14 (real-world-subjects blueprint) — fieldUtils: the two headless
// FieldUtils helpers over the traverse surface. The extractor is checked on a
// sphere (near-unit outward normals), every option branch runs both ways
// (threshold, direction filter, scaleBy, defaults), and vectorFieldMerge is
// checked for source writes + target preservation.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPico,
  surfaceNormalFieldExtractor,
  vectorFieldMerge,
  type Pico,
  type Vec3,
  type VectorField,
  type Voxels,
} from '../src/index.ts';

let pk: Pico;
let sphere: Voxels;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
  sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
});
afterAll(() => pk.dispose());

function collect(field: VectorField): Array<{ position: Vec3; value: Vec3 }> {
  const entries: Array<{ position: Vec3; value: Vec3 }> = [];
  field.traverse((x, y, z, vx, vy, vz) => entries.push({ position: [x, y, z], value: [vx, vy, vz] }));
  return entries;
}

test('defaults: near-surface normals are near-unit and point outward', () => {
  const entries = collect(surfaceNormalFieldExtractor(pk, sphere));
  assert.ok(entries.length > 100, `a whole-sphere band extracts many normals, got ${entries.length}`);
  for (const { position, value } of entries) {
    const length = Math.hypot(value[0], value[1], value[2]);
    assert.ok(Math.abs(length - 1) < 1e-3, `near-unit normal, |n| = ${length}`);
    const radius = Math.hypot(position[0], position[1], position[2]);
    const outward =
      (position[0] * value[0] + position[1] * value[1] + position[2] * value[2]) / (radius * length);
    assert.ok(outward > 0.98, `outward normal at ${position.join(',')}: dot(n, r̂) = ${outward}`);
  }
});

test('surfaceThresholdVx: a wide threshold keeps more of the band than the default; a tiny one less', () => {
  const wide = collect(surfaceNormalFieldExtractor(pk, sphere, { surfaceThresholdVx: 2.5 })).length;
  const dflt = collect(surfaceNormalFieldExtractor(pk, sphere, {})).length;
  const tiny = collect(surfaceNormalFieldExtractor(pk, sphere, { surfaceThresholdVx: 0.05 })).length;
  assert.ok(wide > dflt, `wide ${wide} > default ${dflt}`);
  assert.ok(dflt > tiny, `default ${dflt} > tiny ${tiny}`);
  assert.ok(tiny > 0, `even a tiny threshold catches some surface voxels, got ${tiny}`);
});

test('directionFilter: +Z with tolerance keeps only top-cap normals', () => {
  const all = collect(surfaceNormalFieldExtractor(pk, sphere));
  // A non-unit filter also exercises the normalization, exactly as the C# does.
  const top = collect(
    surfaceNormalFieldExtractor(pk, sphere, { directionFilter: [0, 0, 2], directionFilterTolerance: 0.05 }),
  );
  assert.ok(top.length > 0, 'the top cap is non-empty');
  assert.ok(
    top.length < all.length / 4,
    `a 0.05-tolerance cap is a small fraction: ${top.length} of ${all.length}`,
  );
  for (const { value } of top) {
    assert.ok(value[2] > 0.9, `top-cap normal points up, nz = ${value[2]}`);
  }
});

test('scaleBy: stored normals scale component-wise, bit-exactly for powers of two', () => {
  const base = new Map(
    collect(surfaceNormalFieldExtractor(pk, sphere)).map(({ position, value }) => [
      position.join(','),
      value,
    ]),
  );
  const scaled = collect(surfaceNormalFieldExtractor(pk, sphere, { scaleBy: [2, 2, -4] }));
  assert.equal(scaled.length, base.size, 'scaling changes values, never the active set');
  for (const { position, value } of scaled) {
    const unscaled = base.get(position.join(','));
    assert.ok(unscaled, `scaled entry at ${position.join(',')} exists unscaled`);
    assert.deepEqual(value, [2 * unscaled[0], 2 * unscaled[1], -4 * unscaled[2]]);
  }
});

test('vectorFieldMerge: every source active lands in the target; other target values survive', () => {
  const source = pk.createVectorField();
  source.set([1, 0, 0], [1, 2, 3]);
  source.set([2, 0, 0], [4, 5, 6]);
  const target = pk.createVectorField();
  target.set([2, 0, 0], [-9, -9, -9]); // overlapped — merge overwrites
  target.set([5, 0, 0], [7, 8, 9]); // untouched — merge preserves
  vectorFieldMerge(source, target);
  assert.deepEqual(target.get([1, 0, 0]), [1, 2, 3]);
  assert.deepEqual(target.get([2, 0, 0]), [4, 5, 6]);
  assert.deepEqual(target.get([5, 0, 0]), [7, 8, 9]);
  assert.equal(collect(target).length, 3);
});
