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
