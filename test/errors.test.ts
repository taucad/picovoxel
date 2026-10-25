// R21 — every error code produced at least once, with code + a message naming the
// offending value; PICO_DISPOSED per wrapper type; guard() branch coverage.

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  guard,
  notImplemented,
  PicoError,
  registerOutOfMemoryProbe,
  type PicoErrorCode,
} from '../src/errors.ts';
import { createPico, type Pico } from '../src/index.ts';
import { bindPicoRaw } from '../src/raw.ts';

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
  const guarded = guard(
    'Voxels_fCalculateVolume',
    () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the guard must map a raw WebAssembly.Exception
      throw boom;
    },
    () => 'handle=42',
  );
  const error = grab(guarded);
  expectCode(error, 'PICO_INVALID_HANDLE');
  assert.match(error.message, /Voxels_fCalculateVolume/);
  assert.match(error.message, /handle=42/);
  assert.equal(error.cause, boom, 'original throw preserved as cause');
});

function syntheticException(): WebAssembly.Exception {
  return new WebAssembly.Exception(new WebAssembly.Tag({ parameters: ['i32'] }), [7]);
}

function throwing(exception: WebAssembly.Exception): () => never {
  return () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the guard must map a raw WebAssembly.Exception
    throw exception;
  };
}

test('guard: a WebAssembly.Exception a probe identifies as std::bad_alloc -> PICO_OUT_OF_MEMORY', () => {
  const boom = syntheticException();
  const seen: WebAssembly.Exception[] = [];
  const owner = {};
  const unregister = registerOutOfMemoryProbe(owner, (exception) => {
    seen.push(exception);
    return exception === boom;
  });
  try {
    const error = grab(guard('Voxels_Offset', throwing(boom), () => 'distance=2'));
    expectCode(error, 'PICO_OUT_OF_MEMORY');
    assert.match(error.message, /Voxels_Offset/);
    assert.match(error.message, /distance=2/);
    assert.match(error.message, /4 GiB/, 'the message states the heap limit');
    assert.match(error.message, /coarser voxelSize/);
    assert.equal(error.cause, boom, 'original throw preserved as cause');

    // A throw the probe does not claim keeps its old meaning.
    expectCode(grab(guard('Mesh_nTriangleCount', throwing(syntheticException()))), 'PICO_INVALID_HANDLE');
    assert.equal(seen.length, 2, 'the probe saw both throws');
  } finally {
    unregister();
  }
  expectCode(grab(guard('Voxels_Offset', throwing(boom))), 'PICO_INVALID_HANDLE');
  assert.equal(seen.length, 2, 'an unregistered probe is not consulted');
});

test('guard: a probe whose owner was collected is dropped, not called', () => {
  // A WeakRef whose target is already gone, standing in for a collected runtime.
  vi.stubGlobal(
    'WeakRef',
    class {
      deref(): undefined {
        return undefined;
      }
    },
  );
  let calls = 0;
  try {
    registerOutOfMemoryProbe({}, () => ++calls > 0);
  } finally {
    vi.unstubAllGlobals();
  }
  expectCode(grab(guard('Voxels_Offset', throwing(syntheticException()))), 'PICO_INVALID_HANDLE');
  expectCode(grab(guard('Voxels_Offset', throwing(syntheticException()))), 'PICO_INVALID_HANDLE');
  assert.equal(calls, 0);
});

test('guard: a live module does not claim an exception it did not throw', async () => {
  const pk = await createPico();
  // The probe rethrows into this module, which has no catch clause for a foreign tag.
  expectCode(grab(guard('Voxels_Offset', throwing(syntheticException()))), 'PICO_INVALID_HANDLE');
  pk.dispose();
});

/**
 * Fills the wasm heap to its 4 GiB ceiling with _malloc blocks, runs `body`, then
 * frees them. The blocks are never written, so the host commits almost none of it.
 */
function withExhaustedHeap<T>(pk: Pico, body: () => T): T {
  const { module } = pk;
  const held: number[] = [];
  try {
    for (const size of [64 << 20, 1 << 20, 64 << 10, 1 << 10]) {
      for (let pointer = module._malloc(size); pointer !== 0; pointer = module._malloc(size))
        held.push(pointer);
    }
    assert.equal(module.HEAPU8.buffer.byteLength, 4 * 1024 ** 3 - 64 * 1024, 'the heap reached its ceiling');
    return body();
  } finally {
    for (const pointer of held) module._free(pointer);
  }
}

test('guard: integration — real heap exhaustion in native code becomes PICO_OUT_OF_MEMORY', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  const error = withExhaustedHeap(pk, () => grab(() => pk.createVoxels({ shape: 'sphere', radius: 20 })));
  expectCode(error, 'PICO_OUT_OF_MEMORY');
  assert.ok(
    error.cause instanceof WebAssembly.Exception,
    'the native std::bad_alloc, not a facade allocation',
  );
  assert.match(error.message, /Voxels_hCreateSphere/);
  // With the blocks freed, the same module builds the same sphere.
  assert.ok(pk.createVoxels({ shape: 'sphere', radius: 20 }).volume > 0);
  pk.dispose();
});

test('Library_nExceptionKind — 1 for std::bad_alloc, 0 for another C++ throw or none', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  const raw = bindPicoRaw(pk.module);
  const kindOf = (rethrow: () => void) => {
    const pointer = pk.module.addFunction(rethrow, 'v');
    try {
      return raw.Library_nExceptionKind(pointer);
    } finally {
      pk.module.removeFunction(pointer);
    }
  };
  const capture = (call: () => unknown): WebAssembly.Exception => {
    const thrown = grab(call);
    assert.ok(thrown instanceof WebAssembly.Exception, `expected a native throw, got ${String(thrown)}`);
    return thrown;
  };

  const badAlloc = capture(() => withExhaustedHeap(pk, () => raw.Voxels_hCreateSphere(pk.handle, 0, 20)));
  // roGet's std::out_of_range, from a handle the instance never issued.
  const outOfRange = capture(() => raw.Mesh_nTriangleCount(pk.handle, 987654321n));
  assert.equal(kindOf(throwing(badAlloc)), 1);
  assert.equal(kindOf(throwing(outOfRange)), 0);
  assert.equal(
    kindOf(() => undefined),
    0,
    'a callback that returns normally',
  );
  const foreign = new Error('not a C++ exception');
  assert.equal(
    grab(() =>
      kindOf(() => {
        throw foreign;
      }),
    ),
    foreign,
    'a JS throw passes through the C++ catch clauses',
  );
  pk.dispose();
});

test('guard: WebAssembly.RuntimeError -> PICO_OUT_OF_MEMORY', () => {
  const error = grab(
    guard('Voxels_Offset', () => {
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    }),
  );
  expectCode(error, 'PICO_OUT_OF_MEMORY');
  assert.match(error.message, /voxelSize/);
});

test('guard: PicoError passes through unchanged; anything else -> PICO_CALL_FAILED', () => {
  const original = new PicoError('PICO_RESERVED_METADATA', 'do not rewrap this error, it is already typed');
  assert.equal(
    grab(
      guard('X', () => {
        throw original;
      }),
    ),
    original,
  );

  const wrapped = grab(
    guard('Mesh_GetVertices', () => {
      throw new Error('plain failure');
    }),
  );
  expectCode(wrapped, 'PICO_CALL_FAILED');
});

test('guard: integration — a real bogus-handle ABI throw becomes PICO_INVALID_HANDLE', async () => {
  const pk = await createPico();
  const raw = pk.module.cwrap('Mesh_nTriangleCount', 'bigint', ['bigint', 'bigint']) as (
    l: bigint,
    m: bigint,
  ) => bigint;
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

  expectCode(
    grab(() => pk.createVoxels({ shape: 'sphere', radius: -1 })),
    'PICO_INVALID_ARGUMENT',
  );
  expectCode(
    grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).union(other.createVoxels({ shape: 'empty' }))),
    'PICO_SESSION_MISMATCH',
  );
  expectCode(
    grab(() => pk.createVoxels({ shape: 'sphere', radius: 2 }).metadata.set('class', 'x')),
    'PICO_RESERVED_METADATA',
  );
  await assert.rejects(
    () => createPico({ wasm: { wasmBinary: new Uint8Array(4) } }),
    (e: unknown) => e instanceof PicoError && e.code === 'PICO_WASM_INIT_FAILED',
  );

  const scalar = pk.createScalarField();
  scalar.set([0, 0, 0], 1);
  const vdb = pk.createVdb();
  vdb.add(scalar, 'only-scalar');
  expectCode(
    grab(() => pk.voxelsFromVdb(vdb.toBytes())),
    'PICO_VDB_NO_COMPATIBLE_FIELD',
  );

  pk.dispose();
  other.dispose();
});
