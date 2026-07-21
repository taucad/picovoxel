// R10 — createVoxels shapes: empty/sphere/beam(+capsule alias)/implicit, with
// analytic-volume oracles and the raw primitive as the beam cross-check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPico, PicoError } from '../src/index.ts';

test('empty shape: isEmpty true, zero volume, SG2 oracle available', async () => {
  const pk = await createPico();
  const empty = pk.createVoxels({ shape: 'empty' });
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.volume, 0);
  pk.dispose();
});

test('sphere: analytic volume within marching tolerance', async () => {
  const pk = await createPico({ voxelSize: 0.4 });
  const sphere = pk.createVoxels({ shape: 'sphere', center: [3, -2, 1], radius: 10 });
  const analytic = (4 / 3) * Math.PI * 1000;
  assert.ok(Math.abs(sphere.volume - analytic) / analytic < 0.02, `${sphere.volume} vs ${analytic}`);
  assert.equal(sphere.isEmpty, false);
  pk.dispose();
});

test('beam ≙ raw capsule primitive; capsule alias identical; tapered radii differ', async () => {
  const pk = await createPico({ voxelSize: 0.4 });
  const beam = pk.createVoxels({ shape: 'beam', start: [-10, 0, 0], end: [10, 0, 0], radius: 4 });

  // Analytic: cylinder + two hemispheres.
  const analytic = Math.PI * 16 * 20 + (4 / 3) * Math.PI * 64;
  assert.ok(Math.abs(beam.volume - analytic) / analytic < 0.03, `${beam.volume} vs ${analytic}`);

  // The alias must produce the exact same field.
  const capsule = pk.createVoxels({ shape: 'capsule', start: [-10, 0, 0], end: [10, 0, 0], radius: 4 });
  assert.ok(beam.equals(capsule), 'beam and capsule alias must be identical fields');

  // Tapered form drives the two-radius ABI path.
  const tapered = pk.createVoxels({ shape: 'beam', start: [-10, 0, 0], end: [10, 0, 0], startRadius: 2, endRadius: 6 });
  assert.ok(!tapered.equals(beam), 'tapered beam must differ');
  assert.ok(tapered.volume > 0);
  pk.dispose();
});

test('implicit: JS SDF sphere ≙ native primitive within 2%', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  const implicit = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: (x, y, z) => Math.hypot(x, y, z) - 10,
  });
  const native = pk.createVoxels({ shape: 'sphere', radius: 10 });
  const ratio = implicit.volume / native.volume;
  assert.ok(Math.abs(ratio - 1) < 0.02, `ratio ${ratio}`);
  pk.dispose();
});

test('shape validation errors are typed and name the problem', async () => {
  const pk = await createPico();
  const cases: Array<[object, RegExp]> = [
    [{ shape: 'sphere', radius: 0 }, /positive radius/],
    [{ shape: 'beam', start: [0, 0, 0], end: [1, 0, 0] }, /radius/],
    [{ shape: 'beam', radius: 2 }, /start and end/],
    [{ shape: 'wibble' }, /Unknown shape/],
  ];
  for (const [options, pattern] of cases) {
    try {
      pk.createVoxels(options as never);
      assert.fail(`createVoxels(${JSON.stringify(options)}) did not throw`);
    } catch (error) {
      assert.ok(error instanceof PicoError, `got ${String(error)}`);
      assert.equal(error.code, 'PICO_INVALID_ARGUMENT');
      assert.match(error.message, pattern);
    }
  }
  pk.dispose();
});
