// voxels.toMesh({ adaptivity, relax }) — OpenVDB adaptive meshing through
// Mesh_hCreateFromVoxelsAdaptive (patches/PicoGKRuntime/0006). Adaptivity 0
// is the uniform mesher byte for byte, relax or not; above 0 the mesh is
// coarser on flat regions, carries `fast` provenance, and an exact session
// refuses it. Serial and multi give the same bytes.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico, type ToMeshOptions, type Voxels } from '../src/index.ts';
import { createPico as createPicoMulti } from '../src/multi.ts';

let open: Pico;
let box: Voxels;
beforeAll(async () => {
  open = await createPico({ voxelSize: 0.5 });
  // A 20 × 12 × 4 mm box: large flat faces, the case adaptivity is for.
  box = open.createVoxels({
    shape: 'implicit',
    boundsMin: [-11, -7, -3],
    boundsMax: [11, 7, 3],
    sdf: (x, y, z) => {
      const qx = Math.abs(x) - 10;
      const qy = Math.abs(y) - 6;
      const qz = Math.abs(z) - 2;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      return outside + Math.min(Math.max(qx, qy, qz), 0);
    },
  });
});
afterAll(() => open.dispose());

const isPicoError = (code: string) => (error: unknown) => error instanceof PicoError && error.code === code;

test('no options and adaptivity 0 are the uniform mesh, byte for byte and exact', () => {
  const reference = box.toMesh();
  for (const options of [
    {},
    { adaptivity: 0 },
    { adaptivity: undefined },
    { adaptivity: 0, relax: true },
    { relax: false },
  ] satisfies ToMeshOptions[]) {
    const mesh = box.toMesh(options);
    assert.deepEqual(mesh.vertices, reference.vertices);
    assert.deepEqual(mesh.triangles, reference.triangles);
    assert.equal(mesh.lane, 'exact');
  }
  assert.ok(Buffer.from(box.toMesh({ adaptivity: 0 }).toStl()).equals(Buffer.from(reference.toStl())));
});

test('adaptivity above 0 cuts the triangles of flat faces, keeps the bounds and is deterministic', () => {
  const uniform = box.toMesh();
  const adaptive = box.toMesh({ adaptivity: 0.5 });
  assert.ok(
    adaptive.triangleCount * 3 <= uniform.triangleCount,
    `adaptive ${adaptive.triangleCount} vs uniform ${uniform.triangleCount}: expected at least 3x fewer`,
  );
  const a = adaptive.bounds();
  const u = uniform.bounds();
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(a.min[axis]! - u.min[axis]!) <= 0.25, `min[${axis}] moved`);
    assert.ok(Math.abs(a.max[axis]! - u.max[axis]!) <= 0.25, `max[${axis}] moved`);
  }
  // The uniform mesher already bevels the box's sharp edges (about 934 of
  // 960 mm³); merging cells cuts the bevels a little further.
  const volume = adaptive.measure().volume;
  const reference = uniform.measure().volume;
  assert.ok(Math.abs(volume - reference) / reference < 0.03, `adaptive volume ${volume} vs ${reference} mm³`);
  const again = box.toMesh({ adaptivity: 0.5, relax: false });
  assert.deepEqual(again.vertices, adaptive.vertices);
  assert.deepEqual(again.triangles, adaptive.triangles);
});

test('relax keeps the triangle count of an adaptive mesh and is deterministic', () => {
  const plain = box.toMesh({ adaptivity: 0.75 });
  const relaxed = box.toMesh({ adaptivity: 0.75, relax: true });
  assert.equal(relaxed.triangleCount, plain.triangleCount);
  assert.equal(relaxed.lane, 'fast');
  const again = box.toMesh({ adaptivity: 0.75, relax: true });
  assert.deepEqual(again.vertices, relaxed.vertices);
  assert.deepEqual(again.triangles, relaxed.triangles);

  // The relax pass only moves vertices of disoriented triangles, which a box
  // or a sphere does not produce; a gyroid-masked ball does.
  const gyroid = open.createVoxels({ shape: 'sphere', radius: 6 }).maskedByImplicit({
    sdf: [
      '-',
      [
        'abs',
        [
          '+',
          ['*', ['sin', ['*', 'x', 0.6]], ['cos', ['*', 'y', 0.6]]],
          ['*', ['sin', ['*', 'y', 0.6]], ['cos', ['*', 'z', 0.6]]],
          ['*', ['sin', ['*', 'z', 0.6]], ['cos', ['*', 'x', 0.6]]],
        ],
      ],
      0.4,
    ],
  });
  const gyroidPlain = gyroid.toMesh({ adaptivity: 0.5 });
  const gyroidRelaxed = gyroid.toMesh({ adaptivity: 0.5, relax: true });
  assert.equal(gyroidRelaxed.triangleCount, gyroidPlain.triangleCount);
  assert.deepEqual(gyroidRelaxed.triangles, gyroidPlain.triangles, 'relax keeps the topology');
  assert.notDeepEqual(gyroidRelaxed.vertices, gyroidPlain.vertices, 'relax moves vertices');
});

test('an adaptive mesh carries fast provenance and needs consent to export in an open session', () => {
  const adaptive = box.toMesh({ adaptivity: 0.25 });
  assert.equal(adaptive.lane, 'fast');
  assert.throws(() => adaptive.toStl(), isPicoError('PICO_LANE_EXPORT'));
  assert.ok(adaptive.toStl({ acceptLane: 'fast' }).length > 84);
});

test('adaptivity outside [0, 1) and a non-boolean relax are refused before any native call', () => {
  for (const adaptivity of [-0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => box.toMesh({ adaptivity }), isPicoError('PICO_INVALID_ARGUMENT'), `${adaptivity}`);
  }
  // The largest float below 1 is the top of the range.
  assert.equal(box.toMesh({ adaptivity: Math.fround(1 - 2 ** -24) }).lane, 'fast');
  for (const relax of [1, 'yes', null]) {
    assert.throws(
      () => box.toMesh({ adaptivity: 0.5, relax: relax as unknown as boolean }),
      isPicoError('PICO_INVALID_ARGUMENT'),
      String(relax),
    );
  }
});

test("a lane: 'exact' session refuses adaptivity above 0 and still meshes at 0", async () => {
  const exact = await createPico({ voxelSize: 0.5, lane: 'exact' });
  try {
    const sphere = exact.createVoxels({ shape: 'sphere', radius: 4 });
    assert.throws(() => sphere.toMesh({ adaptivity: 0.5 }), isPicoError('PICO_LANE_LOOSENED'));
    assert.equal(sphere.toMesh({ adaptivity: 0 }).lane, 'exact');
  } finally {
    exact.dispose();
  }
});

test('a fast session meshes adaptively and exports without consent', async () => {
  const fast = await createPico({ voxelSize: 0.5, lane: 'fast' });
  try {
    const mesh = fast.createVoxels({ shape: 'sphere', radius: 4 }).toMesh({ adaptivity: 0.9 });
    assert.equal(mesh.lane, 'fast');
    assert.ok(mesh.toStl().length > 84);
  } finally {
    fast.dispose();
  }
});

test('serial and multi produce the same adaptive bytes', async () => {
  const multi = await createPicoMulti({ voxelSize: 0.5 });
  try {
    const shape = (pk: Pico) =>
      pk
        .createVoxels({ shape: 'sphere', radius: 9 })
        .subtract(pk.createVoxels({ shape: 'beam', start: [0, 0, -12], end: [0, 0, 12], radius: 4 }));
    const serialShape = shape(open);
    const multiShape = shape(multi);
    for (const options of [
      { adaptivity: 0.25 },
      { adaptivity: 0.75 },
      { adaptivity: 0.75, relax: true },
    ] satisfies ToMeshOptions[]) {
      const a = serialShape.toMesh(options);
      const b = multiShape.toMesh(options);
      assert.deepEqual(b.vertices, a.vertices, JSON.stringify(options));
      assert.deepEqual(b.triangles, a.triangles, JSON.stringify(options));
    }
  } finally {
    multi.dispose();
  }
});
