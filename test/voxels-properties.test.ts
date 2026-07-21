// R14 — SG1/SG2: raw-grid volume vs the mesh-roundtrip properties(), bounds via
// the intermediate mesh (the only accurate way), memUsage.

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

test('SG1 — post-boolean raw volume is distorted; properties() corrects it', () => {
  const a = sphere(10);
  const b = sphere(10, [6, 0, 0]);
  const carved = a.subtract(b);

  // The true remaining volume: sphere minus the overlapping lens.
  const d = 6, r = 10;
  const lens = (Math.PI * (4 * r + d) * (2 * r - d) ** 2) / 12;
  const analytic = (4 / 3) * Math.PI * r ** 3 - lens;

  const raw = carved.volume;
  const corrected = carved.properties().volume;

  // OpenVDB retains distance-0 surface voxels after booleans: the raw number
  // must be visibly inflated, the round-tripped one accurate.
  assert.ok(Math.abs(corrected - analytic) / analytic < 0.03, `properties().volume ${corrected} vs analytic ${analytic}`);
  assert.ok(raw > corrected, `raw ${raw} should exceed corrected ${corrected} (distance-0 voxels)`);

  // The maximal-distortion case: a − a has NO volume, yet the raw grid reports
  // the whole narrow band; properties() round-trips it away.
  const nothing = a.subtract(a);
  assert.ok(nothing.volume > a.volume * 0.01, `a−a raw volume should be grossly inflated, got ${nothing.volume}`);
  assert.ok(nothing.properties().volume < a.volume * 0.001, `properties() must correct it, got ${nothing.properties().volume}`);
});

test('pre-boolean: raw and corrected volumes agree on a pristine primitive', () => {
  const body = sphere(8);
  const raw = body.volume;
  const { volume: corrected } = body.properties();
  assert.ok(Math.abs(raw - corrected) / corrected < 0.02, `${raw} vs ${corrected}`);
});

test('bounds() via mesh matches the primitive; properties().bounds identical', () => {
  const body = sphere(10, [5, -3, 2]);
  const bounds = body.bounds();
  const expected = { min: [-5, -13, -8], max: [15, 7, 12] };
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(bounds.min[axis]! - expected.min[axis]!) < 0.5, `min[${axis}] ${bounds.min[axis]}`);
    assert.ok(Math.abs(bounds.max[axis]! - expected.max[axis]!) < 0.5, `max[${axis}] ${bounds.max[axis]}`);
  }
  assert.deepEqual(body.properties().bounds, bounds);
});

test('SG2 — isEmpty on empty/full fields; memUsage is a live number', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  assert.equal(empty.isEmpty, true);
  const body = sphere(5);
  assert.equal(body.isEmpty, false);
  assert.ok(body.memUsage > 0, 'a real field uses memory');
  assert.ok(body.memUsage > empty.memUsage, 'sphere outweighs empty');
});
