// R22 — picovoxel/three: headless BufferGeometry bridge with the gear as the
// geometry oracle and an FNV round-trip through the bulk import path.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Mesh, type Pico } from '../src/index.ts';
import { buildGearMesh, GEAR_DEFAULTS } from '../examples/pico/gear.ts';
import { meshFromBufferGeometry, toBufferGeometry } from '../src/three.ts';
import { fnv1a } from './helpers.ts';

let pk: Pico;
let gear: Mesh;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
  // Build the gear through the raw ABI helpers the gear port expects.
  const raw = pk.module;
  const builder = {
    meshCreate: (lib: bigint) =>
      (raw.cwrap('Mesh_hCreate', 'bigint', ['bigint']) as (l: bigint) => bigint)(lib),
    addVertex: (() => {
      const add = raw.cwrap('Mesh_nAddVertex', 'number', ['bigint', 'bigint', 'number']) as (
        l: bigint,
        m: bigint,
        p: number,
      ) => number;
      const ptr = raw._malloc(12);
      return (lib: bigint, mesh: bigint, x: number, y: number, z: number) => {
        raw.HEAPF32.set([x, y, z], ptr >> 2);
        return add(lib, mesh, ptr);
      };
    })(),
    addTriangle: (() => {
      const add = raw.cwrap('Mesh_nAddTriangle', 'number', ['bigint', 'bigint', 'number']) as (
        l: bigint,
        m: bigint,
        p: number,
      ) => number;
      const ptr = raw._malloc(12);
      return (lib: bigint, mesh: bigint, a: number, b: number, c: number) => {
        raw.HEAP32.set([a, b, c], ptr >> 2);
        return add(lib, mesh, ptr);
      };
    })(),
  };
  const { mesh: gearHandle } = buildGearMesh(builder, pk.handle);
  // Adopt the raw handle through a facade wrapper via merged-with-nothing trick:
  // createMesh from its read-back arrays (bulk) — keeps everything facade-side.
  const readV = raw.cwrap('Mesh_GetVertices', 'number', ['bigint', 'bigint', 'number', 'number']) as (
    l: bigint,
    m: bigint,
    b: number,
    n: number,
  ) => number;
  const readT = raw.cwrap('Mesh_GetTriangles', 'number', ['bigint', 'bigint', 'number', 'number']) as (
    l: bigint,
    m: bigint,
    b: number,
    n: number,
  ) => number;
  const nv = (
    raw.cwrap('Mesh_nVertexCount', 'number', ['bigint', 'bigint']) as (l: bigint, m: bigint) => number
  )(pk.handle, gearHandle);
  const nt = (
    raw.cwrap('Mesh_nTriangleCount', 'number', ['bigint', 'bigint']) as (l: bigint, m: bigint) => number
  )(pk.handle, gearHandle);
  const vb = raw._malloc(nv * 12);
  const tb = raw._malloc(nt * 12);
  readV(pk.handle, gearHandle, vb, nv);
  readT(pk.handle, gearHandle, tb, nt);
  const vertices = new Float32Array(raw.HEAPF32.subarray(vb >> 2, (vb >> 2) + nv * 3));
  const triangles = new Uint32Array(raw.HEAPU32.subarray(tb >> 2, (tb >> 2) + nt * 3));
  raw._free(vb);
  raw._free(tb);
  (raw.cwrap('Mesh_Destroy', null, ['bigint', 'bigint']) as (l: bigint, m: bigint) => void)(
    pk.handle,
    gearHandle,
  );
  gear = pk.createMesh({ vertices, triangles });
});
afterAll(() => pk.dispose());

test('gear -> BufferGeometry: counts and bounding volume match', () => {
  const geometry = toBufferGeometry(gear);
  assert.equal(geometry.getAttribute('position').count, gear.vertexCount, 'position count = vertex count');
  assert.equal(geometry.getIndex()!.count, gear.triangleCount * 3, 'index count = 3 × triangle count');
  assert.ok(geometry.getAttribute('normal'), 'normals computed by default');

  geometry.computeBoundingSphere();
  const outerRadius = GEAR_DEFAULTS.module * (GEAR_DEFAULTS.teeth / 2 + 1);
  const expected = Math.hypot(outerRadius, GEAR_DEFAULTS.width / 2);
  assert.ok(
    Math.abs(geometry.boundingSphere!.radius - expected) < 0.5,
    `bounding sphere ${geometry.boundingSphere!.radius} vs ${expected}`,
  );
});

test('round-trip: meshFromBufferGeometry(toBufferGeometry(mesh)) is FNV-identical', () => {
  const geometry = toBufferGeometry(gear);
  const back = meshFromBufferGeometry(pk, geometry);
  assert.equal(back.vertexCount, gear.vertexCount);
  assert.equal(back.triangleCount, gear.triangleCount);
  assert.equal(fnv1a(back.vertices), fnv1a(gear.vertices), 'vertex bytes must survive the round trip');
  assert.equal(fnv1a(back.triangles), fnv1a(gear.triangles), 'index bytes must survive the round trip');
});

test('computeNormals: false leaves the geometry normal-free', () => {
  const geometry = toBufferGeometry(gear, { computeNormals: false });
  assert.equal(geometry.getAttribute('normal'), undefined);
});

test('non-indexed geometry is rejected with the documented remediation', () => {
  const geometry = toBufferGeometry(gear).toNonIndexed();
  try {
    meshFromBufferGeometry(pk, geometry);
    assert.fail('non-indexed geometry accepted');
  } catch (error) {
    assert.equal((error as { code: string }).code, 'PICO_INVALID_ARGUMENT');
    assert.match((error as Error).message, /mergeVertices/);
  }
});
