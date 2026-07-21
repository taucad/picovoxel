// R21 — every error code produced at least once, with code + a message naming the
// offending value; PICO_DISPOSED per wrapper type; guard() branch coverage.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { guard, notImplemented, PicoError, type PicoErrorCode } from '../src/errors.ts';
import { createPico } from '../src/index.ts';

function grab(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function expectCode(error: unknown, code: PicoErrorCode): asserts error is PicoError {
  assert.ok(error instanceof PicoError, `expected PicoError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.ok(error.message.length > 20, 'message must explain, not just name a code');
}

test('guard: WebAssembly.Exception -> PICO_INVALID_HANDLE (with cause + args)', () => {
  const tag = new WebAssembly.Tag({ parameters: ['i32'] });
  const boom = new WebAssembly.Exception(tag, [7]);
  const guarded = guard('Voxels_fCalculateVolume', () => {
    throw boom;
  }, () => 'handle=42');
  const error = grab(guarded);
  expectCode(error, 'PICO_INVALID_HANDLE');
  assert.match(error.message, /Voxels_fCalculateVolume/);
  assert.match(error.message, /handle=42/);
  assert.equal(error.cause, boom, 'original throw preserved as cause');
});

test('guard: WebAssembly.RuntimeError -> PICO_OUT_OF_MEMORY', () => {
  const error = grab(guard('Voxels_Offset', () => {
    throw new WebAssembly.RuntimeError('memory access out of bounds');
  }));
  expectCode(error, 'PICO_OUT_OF_MEMORY');
  assert.match(error.message, /voxelSize/);
});

test('guard: PicoError passes through unchanged; anything else -> PICO_CALL_FAILED', () => {
  const original = new PicoError('PICO_RESERVED_METADATA', 'do not rewrap this error, it is already typed');
  assert.equal(grab(guard('X', () => { throw original; })), original);

  const wrapped = grab(guard('Mesh_GetVertices', () => {
    throw new Error('plain failure');
  }));
  expectCode(wrapped, 'PICO_CALL_FAILED');
});

test('guard: integration — a real bogus-handle ABI throw becomes PICO_INVALID_HANDLE', async () => {
  const pk = await createPico();
  const raw = pk.module.cwrap('Mesh_nTriangleCount', 'bigint', ['bigint', 'bigint']) as (l: bigint, m: bigint) => bigint;
  const guarded = guard('Mesh_nTriangleCount', () => raw(pk.handle, 987654321n));
  const error = grab(guarded);
  expectCode(error, 'PICO_INVALID_HANDLE');
  // The module survives — create something real afterwards.
  assert.ok(pk.createVoxels({ shape: 'sphere', radius: 3 }).volume > 0);
  pk.dispose();
});

test('PICO_DISPOSED — every wrapper type refuses use after dispose', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  const voxels = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const metadata = voxels.metadata;
  const mesh = voxels.toMesh();
  const lattice = pk.createLattice();
  const polyLine = pk.createPolyLine();
  const scalarField = pk.createScalarField();
  const vectorField = pk.createVectorField();
  const vdb = pk.createVdb();

  const uses: Array<[string, { dispose(): void }, () => unknown]> = [
    ['Voxels', voxels, () => voxels.volume],
    ['Mesh', mesh, () => mesh.vertices],
    ['Lattice', lattice, () => lattice.memUsage],
    ['PolyLine', polyLine, () => polyLine.vertexCount],
    ['ScalarField', scalarField, () => scalarField.get([0, 0, 0])],
    ['VectorField', vectorField, () => vectorField.get([0, 0, 0])],
    ['VdbFile', vdb, () => vdb.fieldCount],
    ['Metadata', metadata, () => metadata.count],
  ];
  for (const [kind, wrapper, use] of uses) {
    if (kind !== 'Metadata') wrapper.dispose(); // voxels.dispose() already disposed its metadata
    const error = grab(use);
    expectCode(error, 'PICO_DISPOSED');
    assert.match(error.message, new RegExp(kind), `message names the ${kind} kind`);
  }

  // The session itself, last.
  pk.dispose();
  const error = grab(() => pk.createVoxels({ shape: 'empty' }));
  expectCode(error, 'PICO_DISPOSED');
});

test('PICO_NOT_IMPLEMENTED — the stub error helper', () => {
  const error = grab(() => notImplemented('picovoxel/example'));
  expectCode(error, 'PICO_NOT_IMPLEMENTED');
  assert.match(error.message, /picovoxel\/example/);
});

test('remaining codes are produced by their owning paths (cross-reference)', async () => {
  // Each of these codes has dedicated coverage in its own suite; this test pins
  // one canonical producer per code so the enumeration can never silently rot.
  const pk = await createPico();
  const other = await createPico();

  expectCode(grab(() => pk.createVoxels({ shape: 'sphere', radius: -1 })), 'PICO_INVALID_ARGUMENT');
  expectCode(
    grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).union(other.createVoxels({ shape: 'empty' }))),
    'PICO_SESSION_MISMATCH',
  );
  expectCode(grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).metadata.set('class', 'x')), 'PICO_RESERVED_METADATA');
  await assert.rejects(
    () => createPico({ wasm: { wasmBinary: new Uint8Array(4) } }),
    (e: unknown) => e instanceof PicoError && e.code === 'PICO_WASM_INIT_FAILED',
  );

  const scalar = pk.createScalarField();
  scalar.set([0, 0, 0], 1);
  const vdb = pk.createVdb();
  vdb.add(scalar, 'only-scalar');
  expectCode(grab(() => pk.voxelsFromVdb(vdb.toBytes())), 'PICO_VDB_NO_COMPATIBLE_FIELD');

  pk.dispose();
  other.dispose();
});
