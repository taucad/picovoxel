// R17 — lattice (B3 single addBeam signature, SG12 roundCap default) + polyline.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPicoGK, PicoGkError, type PicoGK } from '../src/index.ts';

let pk: PicoGK;
beforeAll(async () => {
  pk = await createPicoGK({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('beam ≙ capsule cross-check: a single round-capped beam matches the primitive', () => {
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-10, 0, 0], end: [10, 0, 0], radius: 3 });
  const viaLattice = lattice.toVoxels();

  const viaCapsule = pk.createVoxels({ shape: 'beam', start: [-10, 0, 0], end: [10, 0, 0], radius: 3 });
  const ratio = viaLattice.volume / viaCapsule.volume;
  assert.ok(Math.abs(ratio - 1) < 0.02, `lattice beam vs capsule primitive ratio ${ratio}`);
});

test('SG12 — roundCap defaults true; flat caps measurably differ', () => {
  const make = (roundCap: boolean | undefined) => {
    const lattice = pk.createLattice();
    lattice.addBeam({ start: [0, 0, -8], end: [0, 0, 8], radius: 3, ...(roundCap === undefined ? {} : { roundCap }) });
    return lattice.toVoxels();
  };
  const defaulted = make(undefined);
  const rounded = make(true);
  const flat = make(false);

  assert.ok(defaulted.equals(rounded), 'default must be roundCap: true');
  assert.ok(!flat.equals(rounded), 'flat caps are a different body');
  // Flat caps cut the two hemispheres (4/3 π r³ total) but extend the cylinder.
  const cylinder = Math.PI * 9 * 16;
  const hemispheres = (4 / 3) * Math.PI * 27;
  assert.ok(Math.abs(flat.volume - cylinder) / cylinder < 0.06, `flat ${flat.volume} vs cylinder ${cylinder}`);
  assert.ok(Math.abs(rounded.volume - (cylinder + hemispheres)) / (cylinder + hemispheres) < 0.06, `round ${rounded.volume}`);
});

test('tapered beam radii and spheres combine additively', () => {
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-10, 0, 0], end: [10, 0, 0], startRadius: 2, endRadius: 4 });
  lattice.addSphere({ center: [0, 15, 0], radius: 3 });
  const voxels = lattice.toVoxels();
  assert.ok(voxels.isInside([0, 15, 0]), 'sphere present');
  assert.ok(voxels.isInside([9, 0, 0]), 'thick end present');
  assert.ok(!voxels.isInside([-9, 3.5, 0]), 'thin end really is thin');
  assert.ok(lattice.memUsage > 0);
});

test('lattice validation: radius required through one options signature (B3)', () => {
  const lattice = pk.createLattice();
  for (const bad of [
    () => lattice.addBeam({ start: [0, 0, 0], end: [1, 0, 0] }),
    () => lattice.addBeam({ start: [0, 0, 0], end: [1, 0, 0], radius: -2 }),
    () => lattice.addSphere({ center: [0, 0, 0], radius: 0 }),
  ]) {
    try {
      bad();
      assert.fail('invalid lattice input accepted');
    } catch (error) {
      assert.ok(error instanceof PicoGkError);
      assert.equal(error.code, 'PICOGK_INVALID_ARGUMENT');
    }
  }
});

test('polyline: vertices, count, color round-trip, bounds', () => {
  const line = pk.createPolyLine({ color: [1, 0.25, 0, 0.5] });
  assert.equal(line.addVertex([0, 0, 0]), 0);
  assert.equal(line.addVertex([1, 2, 0]), 1);
  line.addVertices([[2, 4, 0], [3, 6, 1]]);
  assert.equal(line.vertexCount, 4);
  assert.deepEqual(line.vertices[2], [2, 4, 0]);

  const [r, g, b, a] = line.color;
  assert.equal(r, 1);
  assert.equal(g, 0.25);
  assert.equal(b, 0);
  assert.equal(a, 0.5);

  const bounds = line.bounds();
  assert.deepEqual(bounds.min, [0, 0, 0]);
  assert.deepEqual(bounds.max, [3, 6, 1]);
  assert.ok(line.memUsage > 0);
});

test('polyline color defaults to opaque white', () => {
  const line = pk.createPolyLine();
  assert.deepEqual(line.color, [1, 1, 1, 1]);
});
