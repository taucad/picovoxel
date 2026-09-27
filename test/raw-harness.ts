// Tier-1/bulk test harness over the GENERATED raw layer (R21 — replaces the old
// src/raw.mjs shim). Same conveniences (scratch buffers, vec marshalling, bulk
// read/write), but every call goes through raw.generated.ts bindings.

import { loadPicoRaw } from '../src/raw.ts';
import type { PicoRaw } from '../src/raw.generated.ts';
import type { PicoWasmModule } from '../src/types.ts';

const PKINFOSTRINGLEN = 255;
const VEC3_BYTES = 12;
const TRI_BYTES = 12;

export interface RawHarness {
  module: PicoWasmModule;
  raw: PicoRaw;
  name(): string;
  version(): string;
  buildInfo(): string;
  createInstance(voxelSize: number): bigint;
  destroyInstance(lib: bigint): void;
  mmToVoxels(lib: bigint, x: number, y: number, z: number): { x: number; y: number; z: number };
  voxelsToMm(lib: bigint, x: number, y: number, z: number): { x: number; y: number; z: number };
  sphere(lib: bigint, center: readonly [number, number, number], radius: number): bigint;
  capsule(
    lib: bigint,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radiusA: number,
    radiusB: number,
  ): bigint;
  boolAdd(lib: bigint, voxels: bigint, operand: bigint): void;
  boolSubtract(lib: bigint, voxels: bigint, operand: bigint): void;
  offset(lib: bigint, voxels: bigint, distance: number): void;
  volume(lib: bigint, voxels: bigint): number;
  destroyVoxels(lib: bigint, voxels: bigint): void;
  meshCreate(lib: bigint): bigint;
  meshFromVoxels(lib: bigint, voxels: bigint): bigint;
  meshIsValid(lib: bigint, mesh: bigint): boolean;
  addVertex(lib: bigint, mesh: bigint, x: number, y: number, z: number): number;
  addTriangle(lib: bigint, mesh: bigint, a: number, b: number, c: number): number;
  vertexCount(lib: bigint, mesh: bigint): number;
  triangleCount(lib: bigint, mesh: bigint): number;
  destroyMesh(lib: bigint, mesh: bigint): void;
  readMesh(lib: bigint, mesh: bigint): { vertices: Float32Array; indices: Uint32Array };
  readMeshPerElement(lib: bigint, mesh: bigint): { vertices: Float32Array; indices: Uint32Array };
  writeMesh(
    lib: bigint,
    mesh: bigint,
    vertices: Float32Array,
    indices: Uint32Array,
  ): { firstVertex: number; firstTriangle: number };
  allocated(lib: bigint): Record<string, number>;
}

const COUNTERS = [
  'Voxels',
  'Meshes',
  'Lattices',
  'PolyLines',
  'ScalarFields',
  'VectorFields',
  'VdbFiles',
  'VdbMetas',
] as const;

/** Loads the wasm module and returns the generated bindings plus test conveniences. */
export async function loadRawHarness(options: object = {}): Promise<RawHarness> {
  const { module, raw } = await loadPicoRaw(options);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Emscripten module functions do not use this
  const { _malloc, _free, UTF8ToString } = module;

  // Scratch buffers for pointer-taking calls. One allocation per shape, reused.
  const vecA = _malloc(VEC3_BYTES);
  const vecB = _malloc(VEC3_BYTES);
  const triBuf = _malloc(TRI_BYTES);
  const strBuf = _malloc(PKINFOSTRINGLEN);

  const writeVec3 = (ptr: number, x: number, y: number, z: number) => {
    module.HEAPF32[(ptr >> 2) + 0] = x;
    module.HEAPF32[(ptr >> 2) + 1] = y;
    module.HEAPF32[(ptr >> 2) + 2] = z;
  };
  const readVec3 = (ptr: number) => ({
    x: module.HEAPF32[(ptr >> 2) + 0]!,
    y: module.HEAPF32[(ptr >> 2) + 1]!,
    z: module.HEAPF32[(ptr >> 2) + 2]!,
  });

  return {
    module,
    raw,
    name: () => (raw.Library_GetName(strBuf), UTF8ToString(strBuf)),
    version: () => (raw.Library_GetVersion(strBuf), UTF8ToString(strBuf)),
    buildInfo: () => (raw.Library_GetBuildInfo(strBuf), UTF8ToString(strBuf)),

    createInstance: (voxelSize) => raw.Library_hCreateInstance(voxelSize),
    destroyInstance: (lib) => raw.Library_DestroyInstance(lib),

    mmToVoxels(lib, x, y, z) {
      writeVec3(vecA, x, y, z);
      raw.Library_MmToVoxels(lib, vecA, vecB);
      return readVec3(vecB);
    },
    voxelsToMm(lib, x, y, z) {
      writeVec3(vecA, x, y, z);
      raw.Library_VoxelsToMm(lib, vecA, vecB);
      return readVec3(vecB);
    },

    sphere(lib, [cx, cy, cz], radius) {
      writeVec3(vecA, cx, cy, cz);
      return raw.Voxels_hCreateSphere(lib, vecA, radius);
    },
    capsule(lib, [ax, ay, az], [bx, by, bz], radiusA, radiusB) {
      writeVec3(vecA, ax, ay, az);
      writeVec3(vecB, bx, by, bz);
      return raw.Voxels_hCreateCapsule(lib, vecA, vecB, radiusA, radiusB);
    },
    boolAdd: (lib, voxels, operand) => raw.Voxels_BoolAdd(lib, voxels, operand),
    boolSubtract: (lib, voxels, operand) => raw.Voxels_BoolSubtract(lib, voxels, operand),
    offset: (lib, voxels, distance) => raw.Voxels_Offset(lib, voxels, distance),
    volume: (lib, voxels) => raw.Voxels_fCalculateVolume(lib, voxels),
    destroyVoxels: (lib, voxels) => raw.Voxels_Destroy(lib, voxels),

    meshCreate: (lib) => raw.Mesh_hCreate(lib),
    meshFromVoxels: (lib, voxels) => raw.Mesh_hCreateFromVoxels(lib, voxels),
    meshIsValid: (lib, mesh) => raw.Mesh_bIsValid(lib, mesh),
    vertexCount: (lib, mesh) => raw.Mesh_nVertexCount(lib, mesh),
    triangleCount: (lib, mesh) => raw.Mesh_nTriangleCount(lib, mesh),
    destroyMesh: (lib, mesh) => raw.Mesh_Destroy(lib, mesh),

    addVertex(lib, mesh, x, y, z) {
      writeVec3(vecA, x, y, z);
      return raw.Mesh_nAddVertex(lib, mesh, vecA);
    },
    addTriangle(lib, mesh, a, b, c) {
      module.HEAP32[(triBuf >> 2) + 0] = a;
      module.HEAP32[(triBuf >> 2) + 1] = b;
      module.HEAP32[(triBuf >> 2) + 2] = c;
      return raw.Mesh_nAddTriangle(lib, mesh, triBuf);
    },

    // Two ABI crossings for the whole mesh. Copy out before anything can grow
    // memory — growth detaches the backing ArrayBuffer and invalidates views.
    readMesh(lib, mesh) {
      const nv = raw.Mesh_nVertexCount(lib, mesh);
      const nt = raw.Mesh_nTriangleCount(lib, mesh);
      const vertBuf = _malloc(nv * VEC3_BYTES);
      const triBufBulk = _malloc(nt * TRI_BYTES);
      try {
        const gotV = raw.Mesh_GetVertices(lib, mesh, vertBuf, nv);
        const gotT = raw.Mesh_GetTriangles(lib, mesh, triBufBulk, nt);
        if (gotV !== nv) throw new Error(`Mesh_GetVertices wrote ${gotV}, expected ${nv}`);
        if (gotT !== nt) throw new Error(`Mesh_GetTriangles wrote ${gotT}, expected ${nt}`);
        return {
          vertices: new Float32Array(module.HEAPF32.subarray(vertBuf >> 2, (vertBuf >> 2) + nv * 3)),
          indices: new Uint32Array(module.HEAPU32.subarray(triBufBulk >> 2, (triBufBulk >> 2) + nt * 3)),
        };
      } finally {
        _free(vertBuf);
        _free(triBufBulk);
      }
    },

    /** Per-element readback. Retained as the differential oracle for the bulk path. */
    readMeshPerElement(lib, mesh) {
      const nv = raw.Mesh_nVertexCount(lib, mesh);
      const nt = raw.Mesh_nTriangleCount(lib, mesh);
      const vertices = new Float32Array(nv * 3);
      const indices = new Uint32Array(nt * 3);
      for (let i = 0; i < nv; i++) {
        raw.Mesh_GetVertex(lib, mesh, i, vecA);
        vertices.set(module.HEAPF32.subarray(vecA >> 2, (vecA >> 2) + 3), i * 3);
      }
      for (let i = 0; i < nt; i++) {
        raw.Mesh_GetTriangle(lib, mesh, i, triBuf);
        indices.set(module.HEAP32.subarray(triBuf >> 2, (triBuf >> 2) + 3), i * 3);
      }
      return { vertices, indices };
    },

    writeMesh(lib, mesh, vertices, indices) {
      const nv = vertices.length / 3;
      const nt = indices.length / 3;
      const vertBuf = _malloc(nv * VEC3_BYTES);
      const triBufBulk = _malloc(nt * TRI_BYTES);
      try {
        module.HEAPF32.set(vertices, vertBuf >> 2);
        const firstVertex = raw.Mesh_AddVertices(lib, mesh, vertBuf, nv);
        module.HEAPU32.set(indices, triBufBulk >> 2);
        const firstTriangle = raw.Mesh_AddTriangles(lib, mesh, triBufBulk, nt);
        return { firstVertex, firstTriangle };
      } finally {
        _free(vertBuf);
        _free(triBufBulk);
      }
    },

    /** All eight PicoGK allocation counters. Zero after cleanup, or a handle leaked. */
    allocated: (lib) =>
      Object.fromEntries(COUNTERS.map((c) => [c, Number(raw[`Library_n${c}Allocated`](lib))])),
  };
}
