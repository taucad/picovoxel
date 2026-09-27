// SKv2-0 V0.7 — facade booleans on the shared-nothing csg*Copy exports.
// The ABI-level value-identity differential lives in tier2 C18; this pins the
// facade properties: purity, the a−a degenerate, allocation accounting, and
// variadic chaining equivalence.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
});
afterAll(() => pk.dispose());

const sphere = (radius: number, center: [number, number, number] = [0, 0, 0]) =>
  pk.createVoxels({ shape: 'sphere', radius, center });

test('booleans are pure, net one new handle, and inputs stay untouched', () => {
  const a = sphere(8);
  const b = sphere(6, [5, 0, 0]);
  const aHash = a.gridHash().hash;
  const bHash = b.gridHash().hash;

  for (const run of [() => a.union(b), () => a.subtract(b), () => a.intersect(b)] as const) {
    const before = pk.allocated.voxels;
    const result = run();
    assert.equal(pk.allocated.voxels, before + 1, 'exactly one fresh grid per boolean pair');
    assert.equal(a.gridHash().hash, aHash, 'receiver untouched (purity)');
    assert.equal(b.gridHash().hash, bHash, 'operand untouched');
    result.dispose();
  }
});

test('a−a stays the SG2 degenerate: isEmpty true, non-zero narrow-band volume', () => {
  const a = sphere(8);
  const degenerate = a.subtract(a);
  assert.equal(degenerate.isEmpty, true, 'SG2 — isEmpty is THE emptiness oracle');
  assert.ok(degenerate.volume > 0, 'the raw narrow-band volume quirk is unchanged (never test volume ≈ 0)');
});

test('a failing operand mid-chain destroys the intermediate and leaks nothing', () => {
  const a = sphere(8);
  const b = sphere(5, [6, 0, 0]);
  const dead = sphere(4);
  dead.dispose();
  const before = pk.allocated.voxels;
  // First pair succeeds (an owned intermediate exists), second operand throws —
  // the catch arm must destroy the intermediate before rethrowing.
  assert.throws(() => a.union(b, dead));
  assert.equal(pk.allocated.voxels, before, 'the chain intermediate must not leak');
});

test('variadic union/subtract chain pairwise ≡ sequential pairs', () => {
  const a = sphere(8);
  const b = sphere(5, [6, 0, 0]);
  const c = sphere(4, [0, 6, 0]);

  const variadic = a.union(b, c);
  const pairwise = a.union(b).union(c);
  assert.equal(variadic.gridHash().hash, pairwise.gridHash().hash, 'union chain');

  const variadicSub = a.subtract(b, c);
  const pairwiseSub = a.subtract(b).subtract(c);
  assert.equal(variadicSub.gridHash().hash, pairwiseSub.gridHash().hash, 'subtract chain');

  // Zero-operand form stays a pure independent copy.
  const copy = a.union();
  assert.equal(copy.gridHash().hash, a.gridHash().hash);
  assert.notEqual(copy.handle, a.handle);
});
