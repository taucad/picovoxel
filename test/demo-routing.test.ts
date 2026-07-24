import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clampVoxelSize, modelRoute } from '../demo/routing.ts';

test('demo routes are stable kebab-case slugs', () => {
  assert.equal(modelRoute('gyroid (implicit SDF)'), 'gyroid-implicit-sdf');
  assert.equal(modelRoute('RoverWheel — Wheel_02 (heavy)'), 'rover-wheel-wheel-02-heavy');
  assert.equal(modelRoute('implicit gyroid ∩ sphere'), 'implicit-gyroid-sphere');
});

test('model changes preserve voxel size unless the next range excludes it', () => {
  const range = { min: 0.35, max: 1 };
  assert.equal(clampVoxelSize(0.47, 0.5, range), 0.47);
  assert.equal(clampVoxelSize(0.1, 0.5, range), 0.35);
  assert.equal(clampVoxelSize(2, 0.5, range), 1);
  assert.equal(clampVoxelSize(Number.NaN, 0.5, range), 0.5);
});
