// Mesh.measure(): the mesh-integral volume and area, and the properties()
// closed-cavity caveat it cross-checks. Oracles are closed forms: a tetrahedron
// measured exactly, and hollow spheres against 4/3·π·(R³ − r³) and 4π·(R² + r²).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico, type Voxels } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

// Outward-facing unit-corner tetrahedron with legs of 10 mm.
const TETRA = {
  vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};
const TETRA_VOLUME = 1000 / 6;
const TETRA_AREA = 150 + 50 * Math.sqrt(3); // three right triangles + the equilateral face of side 10√2

const close = (actual: number, expected: number, relative: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= relative * Math.abs(expected),
    `${what}: ${actual} is not within ${relative * 100}% of ${expected}`,
  );

test('measure() integrates a tetrahedron exactly', () => {
  const mesh = pk.createMesh(TETRA);
  const { volume, area } = mesh.measure();
  close(volume, TETRA_VOLUME, 1e-12, 'volume');
  close(area, TETRA_AREA, 1e-12, 'area');
  mesh.dispose();
});

test('measure() gives a negative volume for inward-facing triangles and the same area', () => {
  const inverted = TETRA.triangles.slice();
  for (let i = 0; i < inverted.length; i += 3)
    [inverted[i + 1], inverted[i + 2]] = [inverted[i + 2]!, inverted[i + 1]!];
  const mesh = pk.createMesh({ vertices: TETRA.vertices, triangles: inverted });
  const { volume, area } = mesh.measure();
  close(volume, -TETRA_VOLUME, 1e-12, 'volume');
  close(area, TETRA_AREA, 1e-12, 'area');
  mesh.dispose();
});

test('measure() does not lose precision far from the origin', () => {
  const far = TETRA.vertices.map((value, index) => value + [10_000, -20_000, 30_000][index % 3]!);
  const mesh = pk.createMesh({ vertices: far, triangles: TETRA.triangles });
  const { volume, area } = mesh.measure();
  close(volume, TETRA_VOLUME, 1e-12, 'volume');
  close(area, TETRA_AREA, 1e-12, 'area');
  mesh.dispose();
});

test('measure() of an empty mesh is zero, and a disposed mesh refuses', () => {
  const empty = pk.createMesh({ vertices: [], triangles: [] });
  assert.deepEqual(empty.measure(), { volume: 0, area: 0 });
  empty.dispose();
  assert.throws(
    () => empty.measure(),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_DISPOSED',
  );
});

const R = 20;
const r = 10;
const HOLLOW_VOLUME = (4 / 3) * Math.PI * (R ** 3 - r ** 3);
const HOLLOW_AREA = 4 * Math.PI * (R ** 2 + r ** 2);
const SOLID_VOLUME = (4 / 3) * Math.PI * R ** 3;

/** A sphere of radius R with a concentric spherical cavity of radius r, optionally vented along +x. */
const hollowSphere = (ventVoxels = 0): Voxels => {
  let part = pk
    .createVoxels({ shape: 'sphere', radius: R })
    .subtract(pk.createVoxels({ shape: 'sphere', radius: r }));
  if (ventVoxels > 0) {
    const radius = (ventVoxels * pk.voxelSize) / 2;
    part = part.subtract(pk.createVoxels({ shape: 'beam', start: [0, 0, 0], end: [2 * R, 0, 0], radius }));
  }
  return part;
};

test('a sealed cavity: properties() measures the solid sphere, measure() the hollow one', () => {
  const part = hollowSphere();
  const mesh = part.toMesh();
  const measured = mesh.measure();
  close(measured.volume, HOLLOW_VOLUME, 0.005, 'mesh volume');
  close(measured.area, HOLLOW_AREA, 0.005, 'mesh area');
  // The documented caveat: the mesh → voxels round trip fills the cavity and drops its surface.
  const properties = part.properties();
  close(properties.volume, SOLID_VOLUME, 0.005, 'properties() volume');
  close(properties.area, 4 * Math.PI * R ** 2, 0.005, 'properties() area');
  mesh.dispose();
});

test('a cavity vented through a 3-voxel channel measures correctly; a 2-voxel channel reads as sealed', () => {
  const wide = hollowSphere(3);
  const wideMesh = wide.toMesh();
  close(wide.properties().volume, wideMesh.measure().volume, 0.005, '3-voxel vent');
  const narrow = hollowSphere(2);
  const narrowMesh = narrow.toMesh();
  close(narrowMesh.measure().volume, HOLLOW_VOLUME, 0.005, '2-voxel vent, mesh volume');
  close(narrow.properties().volume, SOLID_VOLUME, 0.005, '2-voxel vent, properties() volume');
  wideMesh.dispose();
  narrowMesh.dispose();
});
