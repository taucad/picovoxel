// Runtime patches 0007 and 0008 (upstream/LEDGER.md U28-U30): what each one changes,
// checked through the raw ABI where the facade already validates the input, and through
// the facade where the result moved.
// - MI10/RC7: mesh and polyline indices are checked in every build; a bad corner or read
//   index throws a recoverable exception instead of storing a dangling index.
// - RC5: the metadata string getters refuse a null or zero-length buffer.
// - RC4: a scalar field built from voxels holds only the requested value.
// - VO4: a zero-length flat-capped beam renders nothing instead of NaN.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';
import { bindPicoRaw, type PicoRaw } from '../src/raw.ts';

let pk: Pico;
let raw: PicoRaw;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
  raw = bindPicoRaw(pk.module);
});
afterAll(() => pk.dispose());

test('MI10: a triangle corner outside the vertex range throws and stores nothing', () => {
  const mesh = raw.Mesh_hCreate(pk.handle);
  const scratch = pk.module._malloc(16);
  try {
    for (const corner of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]) {
      pk.module.HEAPF32.set(corner, scratch >>> 2);
      raw.Mesh_nAddVertex(pk.handle, mesh, scratch);
    }
    for (const bad of [
      [0, 1, 3],
      [0, -1, 2],
    ]) {
      pk.module.HEAP32.set(bad, scratch >>> 2);
      assert.throws(() => raw.Mesh_nAddTriangle(pk.handle, mesh, scratch));
    }
    assert.equal(raw.Mesh_nTriangleCount(pk.handle, mesh), 0);
    pk.module.HEAP32.set([0, 1, 2], scratch >>> 2);
    assert.equal(raw.Mesh_nAddTriangle(pk.handle, mesh, scratch), 0);

    assert.throws(() => raw.Mesh_GetVertex(pk.handle, mesh, 3, scratch));
    assert.throws(() => raw.Mesh_GetVertex(pk.handle, mesh, -1, scratch));
    assert.throws(() => raw.Mesh_GetTriangle(pk.handle, mesh, 1, scratch));
  } finally {
    pk.module._free(scratch);
    raw.Mesh_Destroy(pk.handle, mesh);
  }
});

test('RC5: the metadata name getter refuses a null or zero-length buffer', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  const metadata = raw.Metadata_hFromVoxels(pk.handle, sphere.handle);
  const buffer = pk.module._malloc(64);
  try {
    assert.ok(raw.Metadata_nCount(pk.handle, metadata) > 0);
    assert.equal(raw.Metadata_bGetNameAt(pk.handle, metadata, 0, 0, 64), false);
    assert.equal(raw.Metadata_bGetNameAt(pk.handle, metadata, 0, buffer, 0), false);
    assert.equal(raw.Metadata_bGetNameAt(pk.handle, metadata, 0, buffer, 64), true);
  } finally {
    pk.module._free(buffer);
    raw.Metadata_Destroy(pk.handle, metadata);
  }
});

test('RC4: a scalar field built from voxels holds only the requested value', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 6 });
  for (const sdThreshold of [0, 0.5, 2]) {
    const field = pk.createScalarField({ from: sphere, value: 3, sdThreshold });
    const values = new Set<number>();
    let count = 0;
    field.traverse((_x, _y, _z, value) => {
      values.add(value);
      count++;
    });
    assert.ok(count > 0, `threshold ${sdThreshold} selects voxels`);
    assert.deepEqual([...values], [3], `threshold ${sdThreshold}`);
  }
});

test('VO4: a zero-length flat-capped beam renders nothing', () => {
  const build = (withBeam: boolean) => {
    const lattice = pk.createLattice();
    lattice.addSphere({ center: [0, 0, 0], radius: 4 });
    if (withBeam) lattice.addBeam({ start: [3, 0, 0], end: [3, 0, 0], radius: 3, roundCap: false });
    return lattice.toVoxels().gridHash();
  };
  assert.deepEqual(build(true), build(false));

  const alone = pk.createLattice();
  alone.addBeam({ start: [1, 2, 3], end: [1, 2, 3], radius: 2, roundCap: false });
  assert.equal(alone.toVoxels().gridHash().activeVoxels, 0);
});
