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
  // Non-dyadic fractional corners about 1e5 mm out, stored as float32. Every value
  // lies in [2^16, 2^17), where float32 steps are exactly 2^-7, so 128·v is an
  // integer and the exact volume follows in BigInt. Measured about the world
  // origin instead of a mesh vertex, the float64 triple products (~1e15) cancel
  // and lose about 1e-5 of the result; this test needs 1e-9.
  const corners = [
    [100_000.3, 100_000.7, 100_000.1],
    [100_010.9, 100_000.2, 100_000.6],
    [100_000.4, 100_010.8, 100_000.3],
    [100_000.6, 100_000.1, 100_010.7],
  ];
  const vertices = Float32Array.from(corners.flat());
  const mesh = pk.createMesh({ vertices, triangles: TETRA.triangles });
  const { volume, area } = mesh.measure();
  const fixed = Array.from(vertices, (value) => BigInt(value * 128));
  const corner = <T>(values: ArrayLike<T>, index: number): [T, T, T] => [
    values[index * 3]!,
    values[index * 3 + 1]!,
    values[index * 3 + 2]!,
  ];
  const t = TETRA.triangles;
  let sixVolume = 0n;
  // Edge vectors are exact float64 differences of float32 values, so the plain
  // float64 area sum is an accurate oracle.
  let twiceArea = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [ax, ay, az] = corner(fixed, t[i]!);
    const [bx, by, bz] = corner(fixed, t[i + 1]!);
    const [cx, cy, cz] = corner(fixed, t[i + 2]!);
    sixVolume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const a = corner(vertices, t[i]!);
    const b = corner(vertices, t[i + 1]!);
    const c = corner(vertices, t[i + 2]!);
    const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const [wx, wy, wz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    twiceArea += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  close(volume, Number(sixVolume) / 6 / 128 ** 3, 1e-9, 'volume');
  close(area, twiceArea / 2, 1e-12, 'area');
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

/** An axis-aligned box of voxels, rendered from a closed 12-triangle mesh. */
const box = (min: [number, number, number], max: [number, number, number]): Voxels => {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const mesh = pk.createMesh({
    vertices: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    triangles: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
      7,
    ],
  });
  const voxels = mesh.toVoxels();
  mesh.dispose();
  return voxels;
};

// The boolean-residue pins (blueprint Q-E10): the live grid over-counts both of
// these (test/voxels-properties.test.ts), while the mesh skips distance-0 voxels.
test('measure() of a − a is zero: the mesh of an emptied grid has no triangles', () => {
  const a = pk.createVoxels({ shape: 'sphere', radius: 10 });
  const mesh = a.subtract(a).toMesh();
  assert.deepEqual(mesh.measure(), { volume: 0, area: 0 });
  mesh.dispose();
});

test('measure() after a subtract with coincident faces is within the grid-rounding tolerance', () => {
  // A 10 mm cube minus its own +x half: three faces of the cutter lie exactly on
  // faces of the cube. What remains is a 5 × 10 × 10 mm box: 500 mm³, 400 mm².
  // Tolerance: the grid rounds the box's 100 mm of sharp edges, which at 0.5 mm
  // measured −0.7% volume and −2.6% area; the bounds are 1% and 3%. The raw grid
  // reads the coincident-face residue as volume (+15% here).
  const half = box([0, 0, 0], [10, 10, 10]).subtract(box([5, 0, 0], [10, 10, 10]));
  const mesh = half.toMesh();
  const { volume, area } = mesh.measure();
  close(volume, 500, 0.01, 'volume');
  close(area, 400, 0.03, 'area');
  assert.ok(half.volume > 1.1 * 500, `the raw grid should over-count the residue, got ${half.volume}`);
  mesh.dispose();
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
