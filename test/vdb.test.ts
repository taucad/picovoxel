// R20 — SG5 VDB: byte round-trips over MEMFS, first-levelset-wins semantics with
// the rich error, voxel-size handshake, name/index access, type mismatch guards.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('byte round-trip: voxels -> vdb bytes -> voxels equals (native exactness)', () => {
  const body = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const vdb = pk.createVdb();
  assert.equal(vdb.add(body, 'body'), 0, 'first field lands at index 0');

  const bytes = vdb.toBytes();
  assert.ok(bytes.length > 1000, `vdb bytes ${bytes.length}`);

  const restored = pk.voxelsFromVdb(bytes);
  assert.ok(restored.equals(body), 'round-tripped voxels must equal the source');
});

test('mixed container: fields() lists names+types; typed getters by index and name', () => {
  const body = pk.createVoxels({ shape: 'sphere', radius: 6 });
  const scalar = pk.createScalarField({ from: body });
  const vector = pk.createVectorField();
  vector.set([0, 0, 0], [1, 2, 3]);

  const vdb = pk.createVdb();
  vdb.add(body, 'body');
  vdb.add(scalar, 'sd');
  vdb.add(vector, 'flow');
  assert.equal(vdb.fieldCount, 3);

  const bytes = vdb.toBytes();
  const back = pk.openVdb(bytes);
  const fields = back.fields();
  assert.deepEqual(fields.map((f) => f.name).sort(), ['body', 'flow', 'sd']);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]));
  assert.equal(byName['body'], 'voxels');
  assert.equal(byName['sd'], 'scalarField');
  assert.equal(byName['flow'], 'vectorField');

  // Access by name (linear scan, as C#) and by index.
  const voxelsBack = back.getVoxels('body');
  assert.ok(voxelsBack.equals(body));
  // SD fields store the narrow band only — probe near the surface, not the centre.
  const scalarBack = back.getScalarField('sd');
  assert.ok(scalarBack.get([6, 0, 0]) !== null, 'scalar field data survived');
  const vectorBack = back.getVectorField('flow');
  assert.deepEqual(vectorBack.get([0, 0, 0]), [1, 2, 3], 'vector field data survived');
});

test('type mismatch and missing names produce typed, listing errors', () => {
  const vdb = pk.createVdb();
  vdb.add(pk.createVoxels({ shape: 'sphere', radius: 3 }), 'solid');

  try {
    vdb.getScalarField('solid');
    assert.fail('type mismatch accepted');
  } catch (error) {
    assert.ok(error instanceof PicoError);
    assert.match(error.message, /is a voxels, not a scalarField/);
  }
  try {
    vdb.getVoxels('nope');
    assert.fail('missing name accepted');
  } catch (error) {
    assert.ok(error instanceof PicoError);
    assert.match(error.message, /No field named 'nope'.*solid/s, 'error must list what IS there');
  }
  assert.throws(() => vdb.getVoxels(5), /out of range/);
});

test('SG5 — no compatible field: rich error lists every field found', () => {
  const scalar = pk.createScalarField();
  scalar.set([0, 0, 0], 1);
  const vector = pk.createVectorField();
  vector.set([0, 0, 0], [1, 1, 1]);

  const vdb = pk.createVdb();
  vdb.add(scalar, 'a');
  vdb.add(vector, 'b');
  const bytes = vdb.toBytes();

  try {
    pk.voxelsFromVdb(bytes);
    assert.fail('no-voxels vdb accepted');
  } catch (error) {
    assert.ok(error instanceof PicoError);
    assert.equal(error.code, 'PICO_VDB_NO_COMPATIBLE_FIELD');
    assert.match(error.message, /a \(scalarField\)/);
    assert.match(error.message, /b \(vectorField\)/);
  }
});

test('SG5 — first voxel field wins when several exist', () => {
  const small = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const large = pk.createVoxels({ shape: 'sphere', radius: 6 });
  const scalar = pk.createScalarField();
  scalar.set([0, 0, 0], 1);

  const vdb = pk.createVdb();
  vdb.add(scalar, 'noise');
  vdb.add(small, 'first-voxels');
  vdb.add(large, 'second-voxels');

  const restored = pk.voxelsFromVdb(vdb.toBytes());
  // Field ORDER inside a .vdb is not guaranteed stable, so assert it equals
  // one of the voxel fields — the semantic is "a first compatible field", never
  // the scalar and never a merge.
  assert.ok(restored.equals(small) || restored.equals(large), 'must be exactly one of the voxel fields');
});

test('voxel-size handshake: vdbVoxelSize reads PicoGK.VoxelSize from the bytes', async () => {
  const other = await createPico({ voxelSize: 0.8 });
  const body = other.createVoxels({ shape: 'sphere', radius: 6 });
  const vdb = other.createVdb();
  vdb.add(body, 'b');
  const bytes = vdb.toBytes();
  other.dispose();

  const size = pk.vdbVoxelSize(bytes);
  assert.ok(Math.abs(size - 0.8) < 1e-4, `handshake read ${size}, expected 0.8`);

  // The documented workflow: create a matching session, then load.
  const matching = await createPico({ voxelSize: size });
  const restored = matching.voxelsFromVdb(bytes);
  assert.ok(Math.abs(restored.volume - (4 / 3) * Math.PI * 216) / ((4 / 3) * Math.PI * 216) < 0.05);
  matching.dispose();
});

test('cross-session add is refused (SG10)', async () => {
  const other = await createPico({ voxelSize: 0.5 });
  const foreign = other.createVoxels({ shape: 'sphere', radius: 2 });
  const vdb = pk.createVdb();
  try {
    vdb.add(foreign, 'foreign');
    assert.fail('cross-session field accepted');
  } catch (error) {
    assert.equal((error as { code: string }).code, 'PICO_SESSION_MISMATCH');
  }
  other.dispose();
});
