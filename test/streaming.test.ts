// Streamed export (src/pico-stream.cpp): every streamed form writes the bytes
// its whole-buffer twin writes. The byte-locked STL fixtures pin toStl() itself
// (test/examples-*.test.ts, test/g0-gate.test.ts); these tests hold the
// streams, the chunked toStl() and the zero-copy readback to it, at batch and
// chunk sizes that split meshes mid-node and mid-batch.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expectTypeOf, test } from 'vitest';
import {
  createPico,
  PicoError,
  type MeshChunk,
  type Pico,
  type StlChunkSink,
  type StreamMeshResult,
  type StreamStlResult,
  type Voxels,
} from '../src/index.ts';
import { writeStlBytes } from '../src/stl.ts';
import { EXACT_LANE_SET } from '../src/lanes.ts';

let pk: Pico;
let part: Voxels;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
  // Two level-1 nodes' worth of surface, with a cavity: batches split it.
  const outer = pk.createVoxels({ shape: 'sphere', radius: 30 });
  const lobe = pk.createVoxels({ shape: 'sphere', radius: 14, center: [32, 0, 0] });
  part = outer.union(lobe).shell({ offset: -2 });
});
afterAll(() => pk.dispose());

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Concatenates copied chunks, optionally behind `head`. */
const join = (chunks: readonly Uint8Array[], head?: Uint8Array): Uint8Array => {
  const parts = head ? [head, ...chunks] : chunks;
  const out = new Uint8Array(parts.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of parts) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

const collect = (): { chunks: Uint8Array[]; write: StlChunkSink } => {
  const chunks: Uint8Array[] = [];
  return { chunks, write: (chunk) => chunks.push(chunk.slice()) };
};

test('voxels.streamStl writes the bytes of toMesh().toStl() at every batch and chunk size', () => {
  const mesh = part.toMesh();
  const reference = mesh.toStl();
  mesh.dispose();
  for (const [batchLeaves, chunkTriangles] of [
    [undefined, undefined],
    [1, 1000],
    [64, 7],
    [100_000, 1],
  ] as const) {
    const { chunks, write } = collect();
    const result = part.streamStl(write, { batchLeaves, chunkTriangles });
    assert.equal(sha(join(chunks, result.header)), sha(reference), `batchLeaves ${batchLeaves}`);
    assert.equal(result.triangleCount, (reference.length - 84) / 50);
    // Whole quads: the chunk bound rounds down to an even count, at least 2.
    const bound = Math.max(2, (chunkTriangles ?? 65_536) & ~1);
    assert.ok(chunks.every((chunk) => chunk.length <= bound * 50));
  }
  // includeHeader: a counting pass first, then the whole file in order.
  const { chunks, write } = collect();
  const result = part.streamStl(write, { includeHeader: true, batchLeaves: 16 });
  assert.equal(sha(join(chunks)), sha(reference));
  assert.deepEqual(chunks[0], result.header);
});

test('streamMesh concatenates to the toMesh() arrays, element for element', () => {
  const mesh = part.toMesh();
  for (const batchLeaves of [undefined, 1, 37]) {
    const vertices: Float32Array[] = [];
    const triangles: Uint32Array[] = [];
    const result = part.streamMesh(
      (chunk) => {
        vertices.push(chunk.vertices.slice());
        triangles.push(chunk.triangles.slice());
      },
      { batchLeaves },
    );
    assert.deepEqual(result, { vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount });
    const flat = (arrays: (Float32Array | Uint32Array)[]) =>
      join(arrays.map((array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength)));
    assert.equal(sha(flat(vertices)), sha(new Uint8Array(mesh.vertices.buffer)), `vertices, ${batchLeaves}`);
    assert.equal(
      sha(flat(triangles)),
      sha(new Uint8Array(mesh.triangles.buffer)),
      `triangles, ${batchLeaves}`,
    );
  }
  mesh.dispose();
});

test('toStl() and mesh.streamStl() write the bytes of the JavaScript STL writer', () => {
  const mesh = part.toMesh();
  // Before any read the export streams native records; after one it writes
  // from the cached arrays in JavaScript. Both are the STL writer's bytes.
  const streamed = mesh.toStl();
  const arrays = { vertices: mesh.vertices, triangles: mesh.triangles };
  assert.equal(sha(mesh.toStl()), sha(streamed));
  assert.equal(sha(writeStlBytes(arrays.vertices, arrays.triangles, {}, EXACT_LANE_SET)), sha(streamed));

  for (const chunkTriangles of [1, 333, undefined]) {
    const tail = collect();
    const result = mesh.streamStl(tail.write, { chunkTriangles });
    assert.equal(sha(join(tail.chunks, result.header)), sha(streamed));
    const whole = collect();
    mesh.streamStl(whole.write, { includeHeader: true, chunkTriangles });
    assert.equal(sha(join(whole.chunks)), sha(streamed));
  }
  // A transformed export keeps the JavaScript writer.
  assert.equal(
    sha(mesh.toStl({ unit: 'cm', scale: 2 })),
    sha(writeStlBytes(arrays.vertices, arrays.triangles, { unit: 'cm', scale: 2 }, EXACT_LANE_SET)),
  );
  mesh.dispose();
});

test('a zero-area triangle writes a zero normal on the native and JavaScript writers alike', () => {
  // Three collinear corners, one of them -0: the identity path writes +0.
  const vertices = [0, 0, -0, 1, 1, 1, 2, 2, 2];
  const mesh = pk.createMesh({ vertices, triangles: [0, 1, 2, 2, 1, 0] });
  const native = mesh.toStl();
  const javascript = writeStlBytes(
    Float32Array.from(vertices),
    Uint32Array.of(0, 1, 2, 2, 1, 0),
    {},
    EXACT_LANE_SET,
  );
  assert.equal(sha(native), sha(javascript));
  assert.deepEqual([...new Float32Array(native.buffer.slice(84, 96))], [0, 0, 0], 'no normal for no area');
  mesh.dispose();
});

test('mesh readback copies straight out of the mesh, with no staging buffer', () => {
  const mesh = part.toMesh();
  const before = pk.module.HEAPU8.length;
  const { vertices } = mesh;
  const { triangles } = mesh;
  assert.equal(pk.module.HEAPU8.length, before, 'reading a mesh grows no heap');
  assert.equal(vertices.length, mesh.vertexCount * 3);
  assert.equal(triangles.length, mesh.triangleCount * 3);
  assert.ok(triangles.every((index) => index < mesh.vertexCount));
  // An empty mesh reads as empty arrays (its storage pointers are null).
  const empty = pk.createMesh({ vertices: [], triangles: [] });
  assert.deepEqual([empty.vertices.length, empty.triangles.length, empty.toStl().length], [0, 0, 84]);
  const { chunks, write } = collect();
  assert.deepEqual(empty.streamStl(write).triangleCount, 0);
  assert.deepEqual(chunks, []);
  mesh.dispose();
});

test('streams of an empty grid write a header and no records', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  const { chunks, write } = collect();
  const result = empty.streamStl(write, { includeHeader: true });
  assert.equal(result.triangleCount, 0);
  assert.deepEqual(chunks, [result.header]);
  assert.deepEqual(
    empty.streamMesh(() => assert.fail('no chunk')),
    { vertexCount: 0, triangleCount: 0 },
  );
});

test('stream options are validated before anything runs', () => {
  const refuse = (run: () => unknown, pattern: RegExp) =>
    assert.throws(
      run,
      (error: unknown) =>
        error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT' && pattern.test(error.message),
    );
  const mesh = part.toMesh();
  for (const chunkTriangles of [0, 1.5, -1, 2 ** 31]) {
    refuse(() => part.streamStl(() => {}, { chunkTriangles }), /chunkTriangles/u);
    refuse(() => mesh.streamStl(() => {}, { chunkTriangles }), /chunkTriangles/u);
  }
  for (const batchLeaves of [0, 2.5, 2 ** 31]) {
    refuse(() => part.streamStl(() => {}, { batchLeaves }), /batchLeaves/u);
    refuse(() => part.streamMesh(() => {}, { batchLeaves }), /batchLeaves/u);
  }
  mesh.dispose();
});

test('a sink that throws ends the stream with its own error and frees it', () => {
  const failure = new Error('disk full');
  const mesh = part.toMesh();
  const heap = pk.module.HEAPU8.length;
  for (let round = 0; round < 3; round++) {
    assert.throws(
      () =>
        part.streamStl(() => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.throws(
      () =>
        part.streamMesh(() => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.throws(
      () =>
        mesh.streamStl(() => {
          throw failure;
        }),
      (error) => error === failure,
    );
  }
  assert.equal(pk.module.HEAPU8.length, heap, 'abandoned streams free their batches');
  // The grid and mesh stay usable.
  assert.ok(part.streamStl(() => {}).triangleCount > 0);
  assert.ok(mesh.streamStl(() => {}).triangleCount > 0);
  mesh.dispose();
});

test('streams follow the lane export rules of toStl()', async () => {
  const fast = await createPico({ voxelSize: 0.5, lane: 'fast' });
  const open = await createPico({ voxelSize: 0.5 });
  try {
    for (const session of [fast, open]) {
      const tainted = session
        .createVoxels({ shape: 'sphere', radius: 6 })
        .offset({ distance: 1, fastRenorm: true });
      const mesh = tainted.toMesh();
      const reference = mesh.toStl({ acceptLane: 'fast' });
      const streamed = collect();
      const result = tainted.streamStl(streamed.write, { acceptLane: 'fast' });
      assert.equal(sha(join(streamed.chunks, result.header)), sha(reference), 'LANE=fast header and records');
      const meshStreamed = collect();
      mesh.streamStl(meshStreamed.write, { acceptLane: 'fast', includeHeader: true });
      assert.equal(sha(join(meshStreamed.chunks)), sha(reference));
      if (session === open) {
        assert.throws(() => tainted.streamStl(() => {}), /PICO_LANE_EXPORT|non-exact/u);
        assert.throws(() => mesh.streamStl(() => {}), /non-exact/u);
      } else {
        assert.equal(sha(join([], tainted.streamStl(() => {}).header)), sha(reference.subarray(0, 84)));
      }
    }
  } finally {
    fast.dispose();
    open.dispose();
  }
});

test('stream consumer shapes', () => {
  const mesh = part.toMesh();
  const stl = part.streamStl(() => {});
  const fromMesh = mesh.streamStl(() => {});
  const indexed = part.streamMesh((chunk) => {
    expectTypeOf(chunk).toEqualTypeOf<MeshChunk>();
    assert.ok(chunk.vertices instanceof Float32Array && chunk.triangles instanceof Uint32Array);
  });
  assert.deepEqual(Object.keys(stl).sort(), ['header', 'triangleCount']);
  assert.deepEqual(Object.keys(fromMesh).sort(), ['header', 'triangleCount']);
  assert.deepEqual(Object.keys(indexed).sort(), ['triangleCount', 'vertexCount']);
  assert.ok(stl.header instanceof Uint8Array && stl.header.length === 84);
  expectTypeOf(stl).toEqualTypeOf<StreamStlResult>();
  expectTypeOf(fromMesh).toEqualTypeOf<StreamStlResult>();
  expectTypeOf(indexed).toEqualTypeOf<StreamMeshResult>();
  expectTypeOf(stl.header).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
  expectTypeOf<Voxels['streamStl']>().parameter(0).toEqualTypeOf<StlChunkSink>();
  // Misuse the compiler refuses; never called.
  const misuse = () => {
    // @ts-expect-error -- Mesh.streamStl batches nothing: batchLeaves belongs to Voxels.streamStl
    mesh.streamStl(() => {}, { batchLeaves: 4 });
    // @ts-expect-error -- STL streams are millimetres: unit belongs to toStl()
    part.streamStl(() => {}, { unit: 'cm' });
  };
  assert.equal(typeof misuse, 'function');
  mesh.dispose();
});
