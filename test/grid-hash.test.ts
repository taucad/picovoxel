// SKv2-0 V0.1 — the G0 canonical grid hash self-tests (NON-DETERMINISM.md
// §14.5). The load-bearing claims, each pinned here:
//   * representation-insensitivity — tile vs dense-leaf encodings of ONE field
//     hash equal (the `bIsEqual` lesson made structural), proven two ways:
//     the in-place densifier, and the interval-pruned tape vs dense-fill
//     callback render of the same implicit;
//   * discrimination — any voxel-level content change moves the hash (the
//     mutation half: a hash that never moves passes every identity gate);
//   * the oracle is pure — hashing never mutates the grid it measures.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
});
afterAll(() => pk.dispose());

const sphere = (radius: number, center: readonly [number, number, number] = [0, 0, 0]) =>
  pk.createVoxels({ shape: 'sphere', center, radius });

test('G0 grid hash — shape, determinism, and purity', () => {
  const a = sphere(5);
  const first = a.gridHash();
  assert.match(first.hash, /^[0-9a-f]{32}$/, 'XXH3-128 renders as 32 hex chars');
  assert.ok(first.activeVoxels > 0, 'a real level set has a narrow band');
  assert.ok(first.insideTiles + first.insideOffVoxels > 0, 'a solid has an inside classification');

  // Purity: the hash normalizes a COPY; the live grid must not move.
  const memBefore = a.memUsage;
  const volumeBefore = a.volume;
  assert.deepEqual(a.gridHash(), first, 'repeated hashing is bit-stable');
  assert.equal(a.memUsage, memBefore, 'hashing must not re-represent the live grid');
  assert.equal(a.volume, volumeBefore, 'hashing must not change the field');

  // Two independent constructions of the same shape are one geometry.
  assert.deepEqual(sphere(5).gridHash(), first, 'same construction, same tuple');
});

test('G0 grid hash — tile vs dense-leaf encodings of one field hash equal', () => {
  // r=8 at 0.4 mm is the smallest sphere here with a real interior-tile
  // population (8 tiles); r=5 has none and would vacuously pass.
  const a = sphere(8);
  const before = a.gridHash();
  assert.ok(before.insideTiles > 0, 'the fixture must actually contain interior tiles');
  const memBefore = a.memUsage;

  a.densifyInterior();
  assert.ok(a.memUsage > memBefore, 'densification must really change the representation');
  assert.deepEqual(a.gridHash(), before, 'post-prune normalization erases the encoding difference');
});

test('G0 grid hash — interval-pruned tape ≡ dense-fill callback of the same implicit', () => {
  // §14.5's named self-test pair: the serialized-expression render takes the
  // slab-parallel tape path (interval-pruned tiles); the JS callback takes
  // upstream's serial dense per-voxel loop. Same field, maximally different
  // tree construction.
  const bounds = { boundsMin: [-6, -6, -6], boundsMax: [6, 6, 6] } as const;
  const viaTape = pk.createVoxels({
    shape: 'implicit',
    ...bounds,
    sdf: ['-', ['sqrt', ['+', ['*', 'x', 'x'], ['*', 'y', 'y'], ['*', 'z', 'z']]], 5],
  });
  const viaCallback = pk.createVoxels({
    shape: 'implicit',
    ...bounds,
    sdf: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - 5,
  });
  assert.deepEqual(viaTape.gridHash(), viaCallback.gridHash(), 'one implicit, one hash');
});

test('G0 grid hash — content changes move the hash (mutation test)', () => {
  const a = sphere(5);
  const base = a.gridHash();

  // Band-level change: a marginally different surface.
  assert.notEqual(sphere(5.2).gridHash().hash, base.hash, 'a different surface is a different hash');

  // Disjoint addition: content the tolerance gates would shrug at (<3% volume)
  // but exact identity must flag.
  const withCrumb = a.union(sphere(1, [20, 0, 0]));
  const mutated = withCrumb.gridHash();
  assert.notEqual(mutated.hash, base.hash, 'added geometry moves the hash');
  assert.ok(mutated.activeVoxels > base.activeVoxels, 'and the active count');

  // Interior-only change: hollowing removes inside classification the band
  // does not fully describe.
  const hollowed = a.subtract(sphere(2));
  assert.notEqual(hollowed.gridHash().hash, base.hash, 'a void inside is a different geometry');
});

test('G0 grid hash — disposed voxels refuse to hash', () => {
  const a = sphere(3);
  a.dispose();
  assert.throws(() => a.gridHash(), /disposed/i);
  assert.throws(() => a.densifyInterior(), /disposed/i);
});
