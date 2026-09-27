// R11 — booleans/clone: purity (SG11), variadic ≙ sequential, SG10 session
// mismatch, SG2 emptiness. Oracles: Voxels_bIsEqual (native exactness) + FNV-1a
// over meshed geometry (byte-level).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico, type Voxels } from '../src/index.ts';
import { fnv1a } from './helpers.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

const sphere = (radius: number, center: readonly [number, number, number] = [0, 0, 0]) =>
  pk.createVoxels({ shape: 'sphere', center, radius });

function meshHash(voxels: Voxels): [number, number] {
  const mesh = voxels.toMesh();
  const hashes: [number, number] = [fnv1a(mesh.vertices), fnv1a(mesh.triangles)];
  mesh.dispose();
  return hashes;
}

test('clone is an equal, independent field', () => {
  const a = sphere(8);
  const copy = a.clone();
  assert.ok(copy.equals(a), 'clone must equal its source');
  assert.notEqual(copy.handle, a.handle, 'clone must be a distinct handle');

  // Mutating a derivation of the clone must not touch the source (independence).
  const grown = copy.union(sphere(4, [12, 0, 0]));
  assert.ok(!grown.equals(a));
  assert.ok(copy.equals(a), 'clone unchanged by deriving from it');
});

test('purity: operands survive union/subtract/intersect (SG11 copy-first)', () => {
  const a = sphere(10);
  const b = sphere(10, [8, 0, 0]);
  const beforeA = meshHash(a);
  const beforeB = meshHash(b);

  const union = a.union(b);
  const difference = a.subtract(b);
  const intersection = a.intersect(b);

  assert.deepEqual(meshHash(a), beforeA, 'a mutated by boolean ops');
  assert.deepEqual(meshHash(b), beforeB, 'b mutated by boolean ops');
  assert.ok(union.volume > a.volume, 'union grows');
  assert.ok(difference.volume < a.volume, 'subtraction shrinks');
  assert.ok(intersection.volume > 0 && intersection.volume < a.volume, 'overlap intersection is partial');
});

test('variadic union ≙ sequential (native equality + mesh FNV)', () => {
  const a = sphere(8);
  const b = sphere(6, [10, 0, 0]);
  const c = sphere(4, [0, 10, 0]);

  const variadic = a.union(b, c);
  const sequential = a.union(b).union(c);
  assert.ok(variadic.equals(sequential), 'variadic union must equal sequential');
  assert.deepEqual(meshHash(variadic), meshHash(sequential), 'meshed bytes must match');
});

test('variadic subtract ≙ sequential', () => {
  const body = sphere(12);
  const holeA = sphere(5, [8, 0, 0]);
  const holeB = sphere(5, [-8, 0, 0]);

  const variadic = body.subtract(holeA, holeB);
  const sequential = body.subtract(holeA).subtract(holeB);
  assert.ok(variadic.equals(sequential));
  assert.deepEqual(meshHash(variadic), meshHash(sequential));
});

test('disjoint algebra: union doubles, intersection empty, subtraction no-op', () => {
  const a = sphere(10);
  const b = sphere(10, [30, 0, 0]);
  const volumeA = a.volume;

  assert.ok(Math.abs(a.union(b).volume - 2 * volumeA) / (2 * volumeA) < 0.01);
  assert.equal(a.intersect(b).isEmpty, true);
  assert.ok(Math.abs(a.subtract(b).volume - volumeA) / volumeA < 0.01);
});

test('SG2 — a.subtract(a).isEmpty is true while raw volume lies (~5% narrow band)', () => {
  const a = sphere(10);
  const nothing = a.subtract(a);
  assert.equal(nothing.isEmpty, true, 'topologically empty');
  const residual = nothing.volume;
  assert.ok(
    residual > 0,
    `narrow band residual expected, got ${residual} (the reason isEmpty is the oracle)`,
  );
  // Band thickness scales with voxel size: ~5% at 0.4mm (tier-2), ~6% at 0.5mm here.
  assert.ok(residual < a.volume * 0.08, `residual ${residual} grew past the narrow-band ballpark`);
});

test('SG10 — cross-session operands throw PICO_SESSION_MISMATCH', async () => {
  const other = await createPico({ voxelSize: 0.5 });
  const foreign = other.createVoxels({ shape: 'sphere', radius: 5 });
  const local = sphere(5);

  for (const op of [
    () => local.union(foreign),
    () => local.subtract(foreign),
    () => local.intersect(foreign),
    () => local.equals(foreign),
  ]) {
    try {
      op();
      assert.fail('cross-session op did not throw');
    } catch (error) {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal((error as { code: string }).code, 'PICO_SESSION_MISMATCH');
    }
  }
  other.dispose();
});

// SK-0.5's operand-copy guard lived here and is GONE with the change it guarded.
// U-SK05-a (merge-based CSG, which removed the eager whole-operand deep copy) was
// reverted for nondeterministic fine-cell geometry loss on the multi build (see the
// fine-cell gate in test/examples-helixheatx.test.ts). Booleans deep-copy the operand
// again, so an assertion that they don't is false. The measurement shape it used
// (heap high-water on a contained-operand union, clone arm as the control) is what a
// re-attempt should re-run — but not as a committed test until the fine-cell race
// is explained.

// SK-0.5 — the dense per-voxel fills prune before they hand the grid on.
//
// `union(empty)` is a clone plus csgUnion, and csgUnion ends in pruneLevelSet, so
// it yields the pruned form of any field. A fill that already pruned has nothing
// left to give. Before the change these paths carried 5.5% (lattice), 36%
// (projectZSlice) and 68% (implicit callback) of prunable tree.
test('per-voxel fills leave no prunable tree behind', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  const lattice = pk.createLattice();
  for (let i = 0; i < 8; i++)
    lattice.addBeam({ start: [-15, 0, i * 3 - 12], end: [15, 0, i * 3 - 12], radius: 2 });

  const cases: Array<[string, Voxels]> = [
    ['RenderLattice', lattice.toVoxels()],
    [
      'RenderImplicit',
      pk.createVoxels({
        shape: 'implicit',
        boundsMin: [-15, -15, -15],
        boundsMax: [15, 15, 15],
        sdf: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - 12,
      }),
    ],
    ['ProjectZSlice', sphere(12).projectZSlice({ startZ: 0, endZ: 8 })],
  ];

  for (const [name, filled] of cases) {
    assert.equal(filled.memUsage, filled.union(empty).memUsage, `${name} still ships prunable tree`);
  }
});
