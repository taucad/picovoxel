// R2 (real-world-subjects blueprint) — tier-0 examples smoke, and the
// packaging gate: examples import the BUILT package by name (Node
// self-reference through the exports map), so this suite proves the exports
// map, dist completeness and type resolution — not src/. A missing dist fails
// loudly here instead of as a resolution error deep in the import graph.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import type { Pico } from '../src/index.ts';

const distEntry = join(import.meta.dirname, '..', 'dist', 'index.js');
assert.ok(
  existsSync(distEntry),
  'examples consume built artifacts — run `npm run build` before `npm test` (CI builds first).',
);

// Import AFTER the dist guard so staleness reports as the guard message.
const { booleanShowcase } = await import('../examples/pico/boolean-showcase.ts');
const { helloWorld } = await import('../examples/pico/hello-world.ts');
const { createPico } = await import('picovoxel');

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('hello-world: the unit cube crosses the bulk mesh path intact', () => {
  const mesh = helloWorld(pk);
  assert.equal(mesh.vertexCount, 8);
  assert.equal(mesh.triangleCount, 12);
  const { min, max } = mesh.bounds();
  assert.deepEqual(min, [-0.5, -0.5, -0.5]);
  assert.deepEqual(max, [0.5, 0.5, 0.5]);
});

test('boolean-showcase: union/subtract/intersect land near the closed-form volumes', () => {
  const result = booleanShowcase(pk);
  // Closed form: r=20, centers 20 apart → lens (spherical-cap pair) volume
  // V_lens = π(4r+d)(2r−d)²/12 = π·100·900/12·... computed below.
  const r = 20;
  const d = 20;
  const sphereVolume = (4 / 3) * Math.PI * r ** 3;
  const lens = (Math.PI * (4 * r + d) * (2 * r - d) ** 2) / 12;
  const expected =
    2 * sphereVolume - lens + // union of two spheres
    (sphereVolume - lens) + // A minus B
    lens; // A intersect B
  assert.ok(
    Math.abs(result.volume - expected) / expected < 0.01,
    `voxelized volume ${result.volume} within 1% of closed form ${expected}`,
  );
  assert.ok(result.triangleCount > 1000, 'meshing produced real geometry');
  assert.equal(result.stlBytes.length, 84 + 50 * result.triangleCount, 'binary STL layout');
});
