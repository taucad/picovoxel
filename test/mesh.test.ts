// R15 — mesh completion: bulk create ≙ per-element (raw differential), bounds +
// SG15 sentinel, B1-fixed transform, matrix ≙ scale/offset equivalence, mirror,
// merged, toVoxels, SG13 shellVoxels, index validation.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPicoGK, isEmptyBounds, PicoGkError, type PicoGK } from '../src/index.ts';
import { fnv1a } from './helpers.ts';

let pk: PicoGK;
beforeAll(async () => {
  pk = await createPicoGK({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

const TETRA = {
  vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};

test('createMesh (bulk) ≙ per-element raw adds — FNV-identical', () => {
  const viaBulk = pk.createMesh(TETRA);

  // Per-element oracle straight through the raw ABI.
  const { cwrap, _malloc, _free, HEAPF32, HEAP32 } = pk.module;
  const h = 'bigint';
  const meshCreate = cwrap('Mesh_hCreate', h, [h]) as (l: bigint) => bigint;
  const addVertex = cwrap('Mesh_nAddVertex', 'number', [h, h, 'number']) as (l: bigint, m: bigint, p: number) => number;
  const addTriangle = cwrap('Mesh_nAddTriangle', 'number', [h, h, 'number']) as (l: bigint, m: bigint, p: number) => number;
  const destroy = cwrap('Mesh_Destroy', null, [h, h]) as (l: bigint, m: bigint) => void;

  const rawMesh = meshCreate(pk.handle);
  const p = _malloc(12);
  for (let i = 0; i < TETRA.vertices.length; i += 3) {
    HEAPF32.set(TETRA.vertices.slice(i, i + 3), p >> 2);
    addVertex(pk.handle, rawMesh, p);
  }
  for (let i = 0; i < TETRA.triangles.length; i += 3) {
    HEAP32.set(TETRA.triangles.slice(i, i + 3), p >> 2);
    addTriangle(pk.handle, rawMesh, p);
  }
  _free(p);

  // Read the raw mesh back through a facade wrapper for identical readout paths.
  const getV = cwrap('Mesh_GetVertices', 'number', [h, h, 'number', 'number']) as (l: bigint, m: bigint, b: number, n: number) => number;
  const buf = _malloc(4 * 12);
  getV(pk.handle, rawMesh, buf, 4);
  const rawVerts = new Float32Array(pk.module.HEAPF32.subarray(buf >> 2, (buf >> 2) + 12));
  _free(buf);

  assert.equal(fnv1a(viaBulk.vertices), fnv1a(rawVerts), 'bulk-created vertices differ from per-element');
  assert.equal(viaBulk.vertexCount, 4);
  assert.equal(viaBulk.triangleCount, 4);
  destroy(pk.handle, rawMesh);
});

test('bounds: real box for geometry, SG15 sentinel for an empty mesh (never NaN)', () => {
  const mesh = pk.createMesh(TETRA);
  const bounds = mesh.bounds();
  assert.deepEqual(bounds.min, [0, 0, 0]);
  assert.deepEqual(bounds.max, [10, 10, 10]);

  const empty = pk.createMesh({ vertices: [], triangles: [] });
  const emptyBox = empty.bounds();
  assert.ok(isEmptyBounds(emptyBox), 'empty mesh must produce the ±FLT_MAX sentinel');
  for (const v of [...emptyBox.min, ...emptyBox.max]) assert.ok(!Number.isNaN(v), 'never NaN');
});

test('B1 — non-uniform scale applies component-wise to EVERY vertex (hand-computed)', () => {
  const mesh = pk.createMesh(TETRA);
  const scaled = mesh.transform({ scale: [2, 3, 4], offset: [1, 1, 1] });

  // Upstream mshCreateTransformed would have multiplied corner A by 2, corner B
  // by 3, corner C by 4 (each a different UNIFORM scalar). Correct semantics:
  const expected = new Float32Array([
    0 * 2 + 1, 0 * 3 + 1, 0 * 4 + 1,
    10 * 2 + 1, 0 * 3 + 1, 0 * 4 + 1,
    0 * 2 + 1, 10 * 3 + 1, 0 * 4 + 1,
    0 * 2 + 1, 0 * 3 + 1, 10 * 4 + 1,
  ]);
  assert.deepEqual(scaled.vertices, expected, 'component-wise scale per vertex');
  assert.deepEqual(scaled.triangles, mesh.triangles, 'indexing preserved');
  assert.deepEqual(mesh.vertices, new Float32Array(TETRA.vertices), 'source untouched (pure)');
});

test('transform(matrix) ≙ transform(scale/offset) on the equivalent affine', () => {
  const mesh = pk.createMesh(TETRA);
  const viaOptions = mesh.transform({ scale: [2, 3, 4], offset: [5, -6, 7] });
  // Row-vector convention, translation in elements 12–14.
  const viaMatrix = mesh.transform({
    matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, -6, 7, 1],
  });
  assert.deepEqual(viaMatrix.vertices, viaOptions.vertices);
  assert.deepEqual(viaMatrix.triangles, viaOptions.triangles);
});

test('uniform scale number shorthand', () => {
  const mesh = pk.createMesh(TETRA);
  const doubled = mesh.transform({ scale: 2 });
  assert.deepEqual(Array.from(doubled.vertices.slice(3, 6)), [20, 0, 0]);
});

test('mirror: reflection across a plane, hand-computed', () => {
  const mesh = pk.createMesh(TETRA);
  // Mirror across the plane x = 5 (point [5,0,0], normal [1,0,0] — passed unnormalized).
  const mirrored = mesh.mirror({ point: [5, 0, 0], normal: [2, 0, 0] });
  const expected = new Float32Array([
    10, 0, 0,
    0, 0, 0,
    10, 10, 0,
    10, 0, 10,
  ]);
  assert.deepEqual(mirrored.vertices, expected);
  assert.deepEqual(mirrored.triangles, mesh.triangles, 'corner order preserved, as upstream');
});

test('merged: concatenation with re-based indices, no dedup', () => {
  const a = pk.createMesh(TETRA);
  const b = pk.createMesh(TETRA);
  const merged = a.merged(b);
  assert.equal(merged.vertexCount, 8, 'no dedup — duplicate vertices survive');
  assert.equal(merged.triangleCount, 8);
  assert.deepEqual(Array.from(merged.triangles.slice(12)), Array.from(b.triangles).map((i) => i + 4), 'second half re-based');
  assert.equal(a.vertexCount, 4, 'sources untouched');
});

test('toVoxels: a closed tetra voxelizes to its analytic volume', () => {
  const mesh = pk.createMesh(TETRA);
  const voxels = mesh.toVoxels();
  const analytic = 1000 / 6; // tetrahedron with three orthogonal 10mm edges
  assert.ok(Math.abs(voxels.volume - analytic) / analytic < 0.12, `${voxels.volume} vs ${analytic}`);
});

test('SG13 — shellVoxels offsets in ALL directions from an OPEN mesh', () => {
  // A single triangle is not a closed surface — exactly the SG13 case.
  const tri = pk.createMesh({ vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0], triangles: [0, 1, 2] });
  const shell = tri.shellVoxels({ radius: 1 });
  assert.ok(shell.volume > 0, 'open mesh must still shell');
  // Slab-ish volume: area 50 × thickness 2 plus rounded rim.
  assert.ok(shell.volume > 90 && shell.volume < 220, `shell volume ${shell.volume}`);
  assert.equal(shell.isInside([2, 2, 0]), true, 'on the triangle');
  assert.equal(shell.isInside([2, 2, 5]), false, 'well above the slab');
});

test('createMesh validation: out-of-range triangle index is refused in JS', () => {
  try {
    pk.createMesh({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 7] });
    assert.fail('bad index accepted');
  } catch (error) {
    assert.ok(error instanceof PicoGkError);
    assert.equal(error.code, 'PICOGK_INVALID_ARGUMENT');
    assert.match(error.message, /vertex 7/);
  }
});
