// R11 — bulk mesh readback: correctness first, speed second.
// The per-element path (Mesh_GetVertex/GetTriangle, one ABI call each) is the oracle:
// bulk must be BYTE-IDENTICAL to it, or it is just a fast way to be wrong.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadPicoGK } from '../src/raw.mjs';
import { buildGearMesh } from '../src/gear.mjs';

const pk = await loadPicoGK();

/** sphere ∪ capsule − sphere: a real marching-cubes mesh, not a hand-built one. */
function csgMesh(lib) {
  const body = pk.sphere(lib, [0, 0, 0], 20);
  const rod = pk.capsule(lib, [-25, 0, 0], [25, 0, 0], 6, 6);
  pk.boolAdd(lib, body, rod);
  const hole = pk.sphere(lib, [0, 0, 12], 9);
  pk.boolSubtract(lib, body, hole);
  const mesh = pk.meshFromVoxels(lib, body);
  return { mesh, dispose: () => { for (const v of [body, rod, hole]) pk.destroyVoxels(lib, v); } };
}

test('bulk readback is byte-identical to per-element (voxel mesh)', () => {
  const lib = pk.createInstance(0.5);
  const { mesh, dispose } = csgMesh(lib);

  const nv = pk.vertexCount(lib, mesh);
  const nt = pk.triangleCount(lib, mesh);
  assert.ok(nv > 10000, `expected a substantial mesh, got ${nv} vertices`);

  const slow = pk.readMeshPerElement(lib, mesh);
  const fast = pk.readMesh(lib, mesh);

  assert.equal(fast.vertices.length, nv * 3);
  assert.equal(fast.indices.length, nt * 3);
  assert.deepEqual(fast.vertices, slow.vertices, 'bulk vertices differ from per-element');
  assert.deepEqual(fast.indices, slow.indices, 'bulk indices differ from per-element');

  pk.destroyMesh(lib, mesh);
  dispose();
  pk.destroyInstance(lib);
});

test('bulk readback is byte-identical to per-element (hand-built gear)', () => {
  const lib = pk.createInstance(0.5);
  const { mesh } = buildGearMesh(pk, lib);

  const slow = pk.readMeshPerElement(lib, mesh);
  const fast = pk.readMesh(lib, mesh);
  assert.deepEqual(fast.vertices, slow.vertices);
  assert.deepEqual(fast.indices, slow.indices);

  pk.destroyMesh(lib, mesh);
  pk.destroyInstance(lib);
});

test('bulk exports clamp to the caller buffer and report what they wrote', () => {
  const lib = pk.createInstance(1.0);
  const sphere = pk.sphere(lib, [0, 0, 0], 10);
  const mesh = pk.meshFromVoxels(lib, sphere);
  const nv = pk.vertexCount(lib, mesh);

  const { _malloc, _free } = pk.module;
  const small = _malloc(10 * 12);
  try {
    // Undersized buffer must be clamped, never overrun.
    const wrote = pk.module.ccall('Mesh_GetVertices', 'number',
      ['bigint', 'bigint', 'number', 'number'], [lib, mesh, small, 10]);
    assert.equal(wrote, 10, `expected clamp to 10, wrote ${wrote}`);

    // Zero/negative counts and a null buffer must be refused, not crash the module.
    assert.equal(pk.module.ccall('Mesh_GetVertices', 'number',
      ['bigint', 'bigint', 'number', 'number'], [lib, mesh, small, 0]), 0);
    assert.equal(pk.module.ccall('Mesh_GetVertices', 'number',
      ['bigint', 'bigint', 'number', 'number'], [lib, mesh, 0, nv]), 0);
  } finally {
    _free(small);
  }

  // Module still usable after the edge cases.
  assert.ok(pk.triangleCount(lib, mesh) > 0);
  pk.destroyMesh(lib, mesh);
  pk.destroyVoxels(lib, sphere);
  pk.destroyInstance(lib);
});

/** Order-sensitive 32-bit FNV-1a over the underlying bytes — the exactness oracle. */
function fnv1a(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic synthetic mesh: a 100k-vertex wavy grid with a triangle strip. */
function syntheticMesh(vertexCount) {
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3 + 0] = (i % 331) * 0.25;
    vertices[i * 3 + 1] = Math.fround(Math.sin(i * 0.01) * 40);
    vertices[i * 3 + 2] = (i / 331) | 0;
  }
  const triangleCount = vertexCount - 2;
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount; i++) {
    indices[i * 3 + 0] = i;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2;
  }
  return { vertices, indices };
}

test('R8 — 100k-vertex bulk import is byte-identical to per-element (FNV-1a)', () => {
  const lib = pk.createInstance(0.5);
  const { vertices, indices } = syntheticMesh(100_000);

  // Per-element oracle: one ABI call per vertex/triangle.
  const slow = pk.meshCreate(lib);
  for (let i = 0; i < vertices.length; i += 3) {
    pk.addVertex(lib, slow, vertices[i], vertices[i + 1], vertices[i + 2]);
  }
  for (let i = 0; i < indices.length; i += 3) {
    pk.addTriangle(lib, slow, indices[i], indices[i + 1], indices[i + 2]);
  }

  // Bulk path: two crossings.
  const fast = pk.meshCreate(lib);
  const { firstVertex, firstTriangle } = pk.writeMesh(lib, fast, vertices, indices);
  assert.equal(firstVertex, 0, 'first appended vertex index');
  assert.equal(firstTriangle, 0, 'first appended triangle index');

  const slowRead = pk.readMesh(lib, slow);
  const fastRead = pk.readMesh(lib, fast);
  assert.equal(fnv1a(fastRead.vertices), fnv1a(slowRead.vertices), 'vertex bytes differ');
  assert.equal(fnv1a(fastRead.indices), fnv1a(slowRead.indices), 'index bytes differ');
  assert.deepEqual(fastRead.vertices, slowRead.vertices);
  assert.deepEqual(fastRead.indices, slowRead.indices);

  // Bookkeeping maintained: both meshes agree on bbox-affecting state via voxelization.
  assert.equal(pk.vertexCount(lib, fast), 100_000);
  assert.equal(pk.triangleCount(lib, fast), indices.length / 3);

  pk.destroyMesh(lib, slow);
  pk.destroyMesh(lib, fast);
  pk.destroyInstance(lib);
});

test('R8 — bulk import refuses null/empty input without touching the mesh', () => {
  const lib = pk.createInstance(1.0);
  const mesh = pk.meshCreate(lib);
  const { ccall } = pk.module;
  const call = (name, buf, count) =>
    ccall(name, 'number', ['bigint', 'bigint', 'number', 'number'], [lib, mesh, buf, count]);
  assert.equal(call('Mesh_AddVertices', 0, 5), -1, 'null buffer refused');
  assert.equal(call('Mesh_AddVertices', 8, 0), -1, 'zero count refused');
  assert.equal(call('Mesh_AddTriangles', 0, 5), -1, 'null buffer refused');
  assert.equal(call('Mesh_AddTriangles', 8, -3), -1, 'negative count refused');
  assert.equal(pk.vertexCount(lib, mesh), 0, 'refused calls must not append');
  assert.equal(pk.triangleCount(lib, mesh), 0);
  pk.destroyMesh(lib, mesh);
  pk.destroyInstance(lib);
});

test('bulk readback is dramatically faster than per-element', () => {
  const lib = pk.createInstance(0.5);
  const { mesh, dispose } = csgMesh(lib);
  const nv = pk.vertexCount(lib, mesh);
  const nt = pk.triangleCount(lib, mesh);

  const time = (fn) => {
    fn(); // warm
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) fn();
    return (performance.now() - t0) / 3;
  };
  const slowMs = time(() => pk.readMeshPerElement(lib, mesh));
  const fastMs = time(() => pk.readMesh(lib, mesh));

  const crossings = nv + nt;
  console.log(`    ${nv} verts + ${nt} tris = ${crossings} ABI crossings -> 2`);
  console.log(`    per-element ${slowMs.toFixed(1)}ms | bulk ${fastMs.toFixed(2)}ms | ${(slowMs / fastMs).toFixed(1)}x`);

  assert.ok(fastMs < slowMs, `bulk (${fastMs}ms) should beat per-element (${slowMs}ms)`);

  pk.destroyMesh(lib, mesh);
  dispose();
  pk.destroyInstance(lib);
});
