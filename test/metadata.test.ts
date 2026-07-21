// R19 — SG3 reserved-name guard + SG4 auto PicoGK.Class tagging + typed table.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('SG3 — all four reserved classes throw PICO_RESERVED_METADATA', () => {
  const metadata = pk.createVoxels({ shape: 'sphere', radius: 5 }).metadata;
  for (const name of ['PicoGK.Custom', 'picogk.sneaky', 'class', 'Name', 'file_thing', 'FILE_X']) {
    for (const op of [() => metadata.set(name, 'x'), () => metadata.remove(name)]) {
      try {
        op();
        assert.fail(`reserved name '${name}' accepted`);
      } catch (error) {
        assert.ok(error instanceof PicoError, `${name}: got ${String(error)}`);
        assert.equal(error.code, 'PICO_RESERVED_METADATA', name);
      }
    }
  }
});

test('SG4 — fresh Voxels/ScalarField/VectorField carry the PicoGK.Class tag', () => {
  const cases: Array<[string, () => { metadata: { get(name: string): unknown } }]> = [
    ['Voxels', () => pk.createVoxels({ shape: 'sphere', radius: 3 })],
    ['ScalarField', () => pk.createScalarField()],
    ['VectorField', () => pk.createVectorField()],
  ];
  for (const [expected, make] of cases) {
    assert.equal(make().metadata.get('PicoGK.Class'), expected, `${expected} tag`);
  }
  // Derived voxels are fresh objects too — they must carry the tag as well.
  const derived = pk.createVoxels({ shape: 'sphere', radius: 3 }).offset({ distance: 1 });
  assert.equal(derived.metadata.get('PicoGK.Class'), 'Voxels');
});

test('typed set/get round-trips with type dispatch string/float/vector', () => {
  const metadata = pk.createVoxels({ shape: 'sphere', radius: 4 }).metadata;
  const before = metadata.count;

  metadata.set('author', 'picovoxel');
  metadata.set('density', 7.5);
  metadata.set('origin', [1, 2, 3]);
  assert.equal(metadata.count, before + 3);

  assert.equal(metadata.typeOf('author'), 'string');
  assert.equal(metadata.typeOf('density'), 'float');
  assert.equal(metadata.typeOf('origin'), 'vector');
  assert.equal(metadata.typeOf('nonexistent'), 'unknown');

  assert.equal(metadata.get('author'), 'picovoxel');
  assert.equal(metadata.get('density'), 7.5);
  assert.deepEqual(metadata.get('origin'), [1, 2, 3]);
  assert.equal(metadata.get('nonexistent'), undefined);

  for (const name of ['author', 'density', 'origin']) {
    assert.ok(metadata.names().includes(name), `${name} listed`);
  }
});

test('remove deletes through the capital-D upstream export', () => {
  const metadata = pk.createScalarField().metadata;
  metadata.set('temp', 1);
  const count = metadata.count;
  metadata.remove('temp');
  assert.equal(metadata.count, count - 1);
  assert.equal(metadata.get('temp'), undefined);
});

test('invalid value types are refused', () => {
  const metadata = pk.createVectorField().metadata;
  for (const bad of [null, { a: 1 }, [1, 2], [1, 2, 3, 4], true]) {
    try {
      metadata.set('key', bad as never);
      assert.fail(`value ${JSON.stringify(bad)} accepted`);
    } catch (error) {
      assert.ok(error instanceof PicoError);
      assert.equal(error.code, 'PICO_INVALID_ARGUMENT');
    }
  }
});

test('metadata accessor is cached per wrapper and survives value churn', () => {
  const voxels = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const a = voxels.metadata;
  const b = voxels.metadata;
  assert.equal(a, b, 'accessor must be cached (no handle churn per read)');
  a.set('k', 'v');
  assert.equal(b.get('k'), 'v');
});
