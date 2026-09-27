// SKv2-0 V0.8 (T11) — bIsEqual repair: O(stored) sign-set comparison.
// The binding property is VERDICT IDENTITY with upstream's dense O(bbox³)
// scan (kept on the raw subpath) across every fixture class the charter
// names: equal, sign-differ, coincident-surface, and representation-
// insensitivity (tile vs dense-leaf encodings of one field).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico, type Voxels } from '../src/index.ts';

let pk: Pico;
let slow: (a: Voxels, b: Voxels) => boolean;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
  const raw = pk.module.cwrap('Voxels_bIsEqual', 'boolean', ['bigint', 'bigint', 'bigint']) as (
    l: bigint, a: bigint, b: bigint) => boolean;
  slow = (a, b) => raw(pk.handle, a.handle, b.handle);
});
afterAll(() => pk.dispose());

/** Every verdict must match the upstream scan, both operand orders. */
const agree = (a: Voxels, b: Voxels, label: string): boolean => {
  const fast = a.equals(b);
  assert.equal(fast, slow(a, b), `${label}: fast diverged from the upstream scan`);
  assert.equal(b.equals(a), slow(b, a), `${label}: fast diverged (reversed operands)`);
  return fast;
};

test('equal / sign-differ / coincident-surface verdicts, upstream-identical', () => {
  const a = pk.createVoxels({ shape: 'sphere', radius: 8 });

  // Equal: an independent clone.
  assert.equal(agree(a, a.clone(), 'clone'), true);

  // Coincident-surface: a different GRID with the same classification — a
  // crumb strictly inside the sphere adds negative values where the sign was
  // already negative, so the inside-set (and upstream's verdict) is unchanged
  // only if the crumb's band stays interior; at r=2 center-origin it does not
  // reach the surface band of r=8, but its own narrow band flips outer-band
  // signs — the verdict is what upstream says, and both must say it.
  const crumb = a.union(pk.createVoxels({ shape: 'sphere', radius: 2 }));
  agree(a, crumb, 'interior crumb');

  // Sign-differ: same shape, shifted by one voxel.
  const shifted = pk.createVoxels({ shape: 'sphere', center: [0.4, 0, 0], radius: 8 });
  assert.equal(agree(a, shifted, 'shifted'), false);

  // Disjoint content in one operand only.
  const withSatellite = a.union(pk.createVoxels({ shape: 'sphere', center: [20, 0, 0], radius: 2 }));
  assert.equal(agree(a, withSatellite, 'satellite'), false);

  // a−a degenerate vs a fresh empty.
  const empty = pk.createVoxels({ shape: 'empty' });
  agree(a.subtract(a), empty, 'degenerate vs empty');
});

test('representation-insensitivity: tile vs dense-leaf encodings compare equal', () => {
  const a = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const dense = a.clone();
  dense.densifyInterior();
  assert.equal(agree(a, dense, 'tile vs dense'), true, 'one field, two encodings, must be equal');
});

test('exact-zero boundary: <=0 classifies inside, both paths agree', () => {
  // A plane SDF sampled at voxel centres lands exactly 0.0 on the z=0 layer —
  // inside under upstream's <=0. A half-voxel shift moves that layer to +0.2 —
  // outside. The two fields must differ, and fast must match the scan on both
  // comparisons (the boundary class that would expose a <0 mask).
  const plane = (offset: number) =>
    pk.createVoxels({
      shape: 'implicit',
      boundsMin: [-4, -4, -4],
      boundsMax: [4, 4, 4],
      sdf: ['+', 'z', offset],
    });
  const at = plane(0);
  const nudged = plane(0.2);
  assert.equal(agree(at, at.clone(), 'zero-layer clone'), true);
  assert.equal(agree(at, nudged, 'zero-layer vs nudged'), false);
});
