// R10 — session completion: factory, info, memory/allocated maps, coordinate
// conversions (B2 fixed), validation, wasm-init failure path.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPico, PicoError } from '../src/index.ts';

function grab(fn: () => unknown, what = 'call'): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${what} to throw, it did not` });
}

test('factory info: name/version/buildInfo/voxelSize', async () => {
  const pk = await createPico({ voxelSize: 0.7 });
  assert.equal(pk.voxelSize, 0.7);
  assert.match(pk.name, /^PicoGK Core Library/);
  assert.match(pk.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pk.buildInfo.length > 0);
  pk.dispose();
});

test('B2 — mmToVoxel binds the REAL export and inverts voxelToMm', async () => {
  const pk = await createPico({ voxelSize: 0.5 });

  // Under the upstream bug (Library.cs:276 calls _VoxelsToMm), 10mm would map to
  // 5 "voxels" (× voxelSize) instead of 20 (÷ voxelSize). Pin the correct scaling.
  assert.deepEqual(pk.mmToVoxel([10, 20, 30]), [20, 40, 60], 'mm -> voxel must DIVIDE by voxel size');
  assert.deepEqual(pk.voxelToMm([20, 40, 60]), [10, 20, 30], 'voxel -> mm must MULTIPLY by voxel size');

  // Round-trip on integer voxel coordinates is exact (including negatives).
  for (const v of [
    [7, -3, 12],
    [0, 0, 0],
    [-40, 5, -1],
  ] as const) {
    assert.deepEqual(pk.mmToVoxel(pk.voxelToMm(v)), v, `round trip ${v.join(',')}`);
  }
  pk.dispose();
});

test('memory map: nine camelCase keys, total grows with an allocation', async () => {
  const pk = await createPico();
  const before = pk.memory;
  assert.deepEqual(Object.keys(before).sort(), [
    'lattices',
    'meshes',
    'metadata',
    'polyLines',
    'scalarFields',
    'total',
    'vdbFiles',
    'vectorFields',
    'voxels',
  ]);
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
  const after = pk.memory;
  assert.ok(after.voxels > before.voxels, 'voxels memory must grow');
  assert.ok(after.total >= after.voxels, 'total covers per-type usage');
  sphere.dispose();
  pk.dispose();
});

test('allocated map: eight camelCase keys, tracks creations', async () => {
  const pk = await createPico();
  assert.deepEqual(Object.keys(pk.allocated).sort(), [
    'lattices',
    'meshes',
    'metadata',
    'polyLines',
    'scalarFields',
    'vdbFiles',
    'vectorFields',
    'voxels',
  ]);
  for (const count of Object.values(pk.allocated)) assert.equal(count, 0);
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  assert.equal(pk.allocated.voxels, 1);
  sphere.dispose();
  assert.equal(pk.allocated.voxels, 0);
  pk.dispose();
});

test('factory validation: voxelSize must be positive and finite', async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => createPico({ voxelSize: bad }),
      (e: unknown) => e instanceof PicoError && e.code === 'PICO_INVALID_ARGUMENT',
      `voxelSize ${bad} must be rejected`,
    );
  }
});

test('wasm init failure path: invalid binary surfaces as PICO_WASM_INIT_FAILED', async () => {
  await assert.rejects(
    () => createPico({ wasm: { wasmBinary: new Uint8Array([1, 2, 3, 4]) } }),
    (e: unknown) =>
      e instanceof PicoError && e.code === 'PICO_WASM_INIT_FAILED' && /instantiate/.test(e.message),
  );
});

test('session methods refuse a disposed session', async () => {
  const pk = await createPico();
  pk.dispose();
  const error = grab(() => pk.createVoxels({ shape: 'empty' }), 'factory on a disposed session');
  assert.ok(error instanceof PicoError);
  assert.equal(error.code, 'PICO_DISPOSED');
});
