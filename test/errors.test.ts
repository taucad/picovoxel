// R21 — every error code produced at least once, with code + a message naming the
// offending value; PICOGK_DISPOSED per wrapper type; guard() branch coverage.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { guard, notImplemented, PicoGkError, type PicoGkErrorCode } from '../src/errors.ts';
import { createPicoGK } from '../src/index.ts';

function grab(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function expectCode(error: unknown, code: PicoGkErrorCode): asserts error is PicoGkError {
  assert.ok(error instanceof PicoGkError, `expected PicoGkError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.ok(error.message.length > 20, 'message must explain, not just name a code');
}

test('guard: WebAssembly.Exception -> PICOGK_INVALID_HANDLE (with cause + args)', () => {
  const tag = new WebAssembly.Tag({ parameters: ['i32'] });
  const boom = new WebAssembly.Exception(tag, [7]);
  const guarded = guard('Voxels_fCalculateVolume', () => {
    throw boom;
  }, () => 'handle=42');
  const error = grab(guarded);
  expectCode(error, 'PICOGK_INVALID_HANDLE');
  assert.match(error.message, /Voxels_fCalculateVolume/);
  assert.match(error.message, /handle=42/);
  assert.equal(error.cause, boom, 'original throw preserved as cause');
});

test('guard: WebAssembly.RuntimeError -> PICOGK_OUT_OF_MEMORY', () => {
  const error = grab(guard('Voxels_Offset', () => {
    throw new WebAssembly.RuntimeError('memory access out of bounds');
  }));
  expectCode(error, 'PICOGK_OUT_OF_MEMORY');
  assert.match(error.message, /voxelSize/);
});

test('guard: PicoGkError passes through unchanged; anything else -> PICOGK_CALL_FAILED', () => {
  const original = new PicoGkError('PICOGK_RESERVED_METADATA', 'do not rewrap this error, it is already typed');
  assert.equal(grab(guard('X', () => { throw original; })), original);

  const wrapped = grab(guard('Mesh_GetVertices', () => {
    throw new Error('plain failure');
  }));
  expectCode(wrapped, 'PICOGK_CALL_FAILED');
});

test('guard: integration — a real bogus-handle ABI throw becomes PICOGK_INVALID_HANDLE', async () => {
  const pk = await createPicoGK();
  const raw = pk.module.cwrap('Mesh_nTriangleCount', 'bigint', ['bigint', 'bigint']) as (l: bigint, m: bigint) => bigint;
  const guarded = guard('Mesh_nTriangleCount', () => raw(pk.handle, 987654321n));
  const error = grab(guarded);
  expectCode(error, 'PICOGK_INVALID_HANDLE');
  // The module survives — create something real afterwards.
  assert.ok(pk.createVoxels({ shape: 'sphere', radius: 3 }).volume > 0);
  pk.dispose();
});

test('PICOGK_DISPOSED — every wrapper type refuses use after dispose', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
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
    expectCode(error, 'PICOGK_DISPOSED');
    assert.match(error.message, new RegExp(kind), `message names the ${kind} kind`);
  }

  // The session itself, last.
  pk.dispose();
  const error = grab(() => pk.createVoxels({ shape: 'empty' }));
  expectCode(error, 'PICOGK_DISPOSED');
});

test('PICOGK_NOT_IMPLEMENTED — the stub error helper', () => {
  const error = grab(() => notImplemented('picogk-js/example'));
  expectCode(error, 'PICOGK_NOT_IMPLEMENTED');
  assert.match(error.message, /picogk-js\/example/);
});

test('remaining codes are produced by their owning paths (cross-reference)', async () => {
  // Each of these codes has dedicated coverage in its own suite; this test pins
  // one canonical producer per code so the enumeration can never silently rot.
  const pk = await createPicoGK();
  const other = await createPicoGK();

  expectCode(grab(() => pk.createVoxels({ shape: 'sphere', radius: -1 })), 'PICOGK_INVALID_ARGUMENT');
  expectCode(
    grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).union(other.createVoxels({ shape: 'empty' }))),
    'PICOGK_SESSION_MISMATCH',
  );
  expectCode(grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).metadata.set('class', 'x')), 'PICOGK_RESERVED_METADATA');
  await assert.rejects(
    () => createPicoGK({ wasm: { wasmBinary: new Uint8Array(4) } }),
    (e: unknown) => e instanceof PicoGkError && e.code === 'PICOGK_WASM_INIT_FAILED',
  );

  const scalar = pk.createScalarField();
  scalar.set([0, 0, 0], 1);
  const vdb = pk.createVdb();
  vdb.add(scalar, 'only-scalar');
  expectCode(grab(() => pk.voxelsFromVdb(vdb.toBytes())), 'PICOGK_VDB_NO_COMPATIBLE_FIELD');

  pk.dispose();
  other.dispose();
});
