// R8 (real-world-subjects blueprint) — the four closed-form oracles from
// leap71/PicoGKUnitTests UnitTests.cs (MIT), ported at the SAME tolerances the
// C# suite pins: sphere volume within 1 mm³ of 4/3·π·r³, bbox within 0.1 mm,
// slice images exactly 305×305 at r=15 / 0.1 mm, subtract-self exactly empty.
// The only consumer suite written against the new explicit-Library API — it
// maps 1:1 onto the picovoxel session model.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPico } from '../src/index.ts';

const sphereVolume = (r: number): number => (4 / 3) * Math.PI * r ** 3;

test('CreateNewVoxels: a fresh voxel field is empty', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    assert.equal(pk.createVoxels({ shape: 'empty' }).isEmpty, true);
  } finally {
    pk.dispose();
  }
});

test('VoxelSubtractingIsEmpty: vox − vox is empty with exactly zero properties-volume', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', center: [0, 0, 0], radius: 15 });
    const nothing = sphere.subtract(sphere);
    assert.equal(nothing.isEmpty, true);
    const { volume, bounds } = nothing.properties();
    assert.equal(volume, 0); // C# Assert.Equal(0f, fVolumeCubicMM) — exact
    assert.ok(bounds.min[0] > bounds.max[0], 'bounding box is the empty sentinel (C# oBox.bIsEmpty())');
  } finally {
    pk.dispose();
  }
});

test('VoxelSlices: r=15 sphere at 0.1 mm allocates exactly 305×305 slice images', async () => {
  const pk = await createPico({ voxelSize: 0.1 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', center: [0, 0, 0], radius: 15 });
    const count = sphere.sliceCount;
    assert.ok(count > 0);
    // C#: imgAllocateSlice → 305×305 (300 voxels of geometry + narrow band).
    const mid = sphere.getSlice({ index: Math.floor(count / 2) });
    assert.equal(mid.width, 305);
    assert.equal(mid.height, 305);
    // C#: GetInterpolatedVoxelSlice(nSliceCount / 2.5f).
    const interpolated = sphere.getSlice({ z: count / 2.5, interpolated: true });
    assert.equal(interpolated.width, 305);
    assert.equal(interpolated.height, 305);
  } finally {
    pk.dispose();
  }
});

test('VoxelBoundingBoxesAndVolumes: closed-form sphere volume and bbox at C# tolerances', async () => {
  const pk = await createPico({ voxelSize: 0.1 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', center: [0, 0, 0], radius: 15 });
    assert.equal(sphere.isEmpty, false);
    const { volume, bounds } = sphere.properties();
    assert.ok(
      Math.abs(sphereVolume(15) - volume) < 1,
      `volume ${volume} within 1 mm³ of ${sphereVolume(15)}`,
    );
    // C# pins X within 0.1f; the sphere is symmetric, so assert every axis.
    for (const axis of [0, 1, 2] as const) {
      assert.ok(Math.abs(bounds.min[axis] - -15) < 0.1, `min[${axis}] ${bounds.min[axis]} ≈ -15`);
      assert.ok(Math.abs(bounds.max[axis] - 15) < 0.1, `max[${axis}] ${bounds.max[axis]} ≈ 15`);
      // C#: vecCenter() == Vector3.Zero — exact float equality on symmetric bounds.
      assert.equal((bounds.min[axis] + bounds.max[axis]) / 2, 0, `center[${axis}] exactly zero`);
    }
  } finally {
    pk.dispose();
  }
});
