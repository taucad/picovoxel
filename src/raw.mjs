// R8 — minimal PicoGK loader. Deliberately NOT the policy-conformant API: that is
// R12 (createPicoGK() per library-api-policy, Symbol.dispose, typed errors). This
// exists to make Tier-1 runnable and to prove the ABI crosses into JS intact.
//
// Handles are uint64_t. WASM_BIGINT is default-on in emcc 5.x, so they surface as
// JS BigInt and pass straight through. R9 narrows them to uint32 to drop that
// dependency — until then, every handle here is a BigInt, hence the 0n literals.

import createPicoGKModule from './picogk.mjs';

const PKINFOSTRINGLEN = 255;
const VEC3_BYTES = 12; // PKVector3 = 3 x float32, #pragma pack(1)
const TRI_BYTES = 12; // PKTriangle = 3 x int32

/** Loads the wasm module and returns a thin typed wrapper over the C ABI. */
export async function loadPicoGK(options = {}) {
  const module = await createPicoGKModule(options);
  const { ccall, cwrap, UTF8ToString, _malloc, _free } = module;

  // Scratch buffers for the pointer-taking calls. One allocation per shape,
  // reused — these are hot in mesh readback and must not churn the heap.
  const vecA = _malloc(VEC3_BYTES);
  const vecB = _malloc(VEC3_BYTES);
  const triBuf = _malloc(TRI_BYTES);
  const strBuf = _malloc(PKINFOSTRINGLEN);

  const writeVec3 = (ptr, x, y, z) => {
    module.HEAPF32[(ptr >> 2) + 0] = x;
    module.HEAPF32[(ptr >> 2) + 1] = y;
    module.HEAPF32[(ptr >> 2) + 2] = z;
  };
  const readVec3 = (ptr) => ({
    x: module.HEAPF32[(ptr >> 2) + 0],
    y: module.HEAPF32[(ptr >> 2) + 1],
    z: module.HEAPF32[(ptr >> 2) + 2],
  });
  const readInfoString = (fn) => {
    ccall(fn, null, ['number'], [strBuf]);
    return UTF8ToString(strBuf);
  };

  const h = 'bigint'; // every PKHANDLE crosses as i64
  const fn = {
    createInstance: cwrap('Library_hCreateInstance', h, ['number']),
    destroyInstance: cwrap('Library_DestroyInstance', null, [h]),
    mmToVoxels: cwrap('Library_MmToVoxels', null, [h, 'number', 'number']),
    voxelsToMm: cwrap('Library_VoxelsToMm', null, [h, 'number', 'number']),
    sphere: cwrap('Voxels_hCreateSphere', h, [h, 'number', 'number']),
    capsule: cwrap('Voxels_hCreateCapsule', h, [h, 'number', 'number', 'number', 'number']),
    boolAdd: cwrap('Voxels_BoolAdd', null, [h, h, h]),
    boolSubtract: cwrap('Voxels_BoolSubtract', null, [h, h, h]),
    offset: cwrap('Voxels_Offset', null, [h, h, 'number']),
    volume: cwrap('Voxels_fCalculateVolume', 'number', [h, h]),
    destroyVoxels: cwrap('Voxels_Destroy', null, [h, h]),
    meshCreate: cwrap('Mesh_hCreate', h, [h]),
    meshFromVoxels: cwrap('Mesh_hCreateFromVoxels', h, [h, h]),
    meshIsValid: cwrap('Mesh_bIsValid', 'boolean', [h, h]),
    addVertex: cwrap('Mesh_nAddVertex', 'number', [h, h, 'number']),
    addTriangle: cwrap('Mesh_nAddTriangle', 'number', [h, h, 'number']),
    vertexCount: cwrap('Mesh_nVertexCount', 'number', [h, h]),
    triangleCount: cwrap('Mesh_nTriangleCount', 'number', [h, h]),
    getVertex: cwrap('Mesh_GetVertex', null, [h, h, 'number', 'number']),
    getTriangle: cwrap('Mesh_GetTriangle', null, [h, h, 'number', 'number']),
    destroyMesh: cwrap('Mesh_Destroy', null, [h, h]),
    // R11 bulk exports — picogk-js additions (src/picogk-bulk.cpp), not upstream.
    getVertices: cwrap('Mesh_GetVertices', 'number', [h, h, 'number', 'number']),
    getTriangles: cwrap('Mesh_GetTriangles', 'number', [h, h, 'number', 'number']),
  };

  const counters = [
    'Voxels', 'Meshes', 'Lattices', 'PolyLines', 'ScalarFields', 'VectorFields', 'VdbFiles', 'VdbMetas',
  ];
  // These return int64_t, so under WASM_BIGINT they arrive as BigInt. Handle counts
  // are small and get compared against literals everywhere — surface them as Number.
  const allocated = Object.fromEntries(
    counters.map((c) => [c, cwrap(`Library_n${c}Allocated`, h, [h])]),
  );

  return {
    module,
    name: () => readInfoString('Library_GetName'),
    version: () => readInfoString('Library_GetVersion'),
    buildInfo: () => readInfoString('Library_GetBuildInfo'),

    createInstance: (voxelSizeMm) => fn.createInstance(voxelSizeMm),
    destroyInstance: (lib) => fn.destroyInstance(lib),

    mmToVoxels(lib, x, y, z) {
      writeVec3(vecA, x, y, z);
      fn.mmToVoxels(lib, vecA, vecB);
      return readVec3(vecB);
    },
    voxelsToMm(lib, x, y, z) {
      writeVec3(vecA, x, y, z);
      fn.voxelsToMm(lib, vecA, vecB);
      return readVec3(vecB);
    },

    sphere(lib, [cx, cy, cz], radius) {
      writeVec3(vecA, cx, cy, cz);
      return fn.sphere(lib, vecA, radius);
    },
    capsule(lib, [ax, ay, az], [bx, by, bz], radiusA, radiusB) {
      writeVec3(vecA, ax, ay, az);
      writeVec3(vecB, bx, by, bz);
      return fn.capsule(lib, vecA, vecB, radiusA, radiusB);
    },
    boolAdd: fn.boolAdd,
    boolSubtract: fn.boolSubtract,
    offset: fn.offset,
    volume: fn.volume,
    destroyVoxels: fn.destroyVoxels,

    meshCreate: fn.meshCreate,
    meshFromVoxels: fn.meshFromVoxels,
    meshIsValid: fn.meshIsValid,
    vertexCount: fn.vertexCount,
    triangleCount: fn.triangleCount,
    destroyMesh: fn.destroyMesh,

    addVertex(lib, mesh, x, y, z) {
      writeVec3(vecA, x, y, z);
      return fn.addVertex(lib, mesh, vecA);
    },
    addTriangle(lib, mesh, a, b, c) {
      module.HEAP32[(triBuf >> 2) + 0] = a;
      module.HEAP32[(triBuf >> 2) + 1] = b;
      module.HEAP32[(triBuf >> 2) + 2] = c;
      return fn.addTriangle(lib, mesh, triBuf);
    },

    // R11: two ABI crossings for the whole mesh instead of one per element.
    // The heap buffer is transient — copy out before any wasm call that could grow
    // memory, since growth detaches the backing ArrayBuffer and invalidates views.
    readMesh(lib, mesh) {
      const nv = fn.vertexCount(lib, mesh);
      const nt = fn.triangleCount(lib, mesh);
      const vertBuf = _malloc(nv * VEC3_BYTES);
      const triBufBulk = _malloc(nt * TRI_BYTES);
      try {
        const gotV = fn.getVertices(lib, mesh, vertBuf, nv);
        const gotT = fn.getTriangles(lib, mesh, triBufBulk, nt);
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

    /** Per-element readback. Retained as the differential oracle for R11's bulk path. */
    readMeshPerElement(lib, mesh) {
      const nv = fn.vertexCount(lib, mesh);
      const nt = fn.triangleCount(lib, mesh);
      const vertices = new Float32Array(nv * 3);
      const indices = new Uint32Array(nt * 3);
      for (let i = 0; i < nv; i++) {
        fn.getVertex(lib, mesh, i, vecA);
        vertices.set(module.HEAPF32.subarray(vecA >> 2, (vecA >> 2) + 3), i * 3);
      }
      for (let i = 0; i < nt; i++) {
        fn.getTriangle(lib, mesh, i, triBuf);
        indices.set(module.HEAP32.subarray(triBuf >> 2, (triBuf >> 2) + 3), i * 3);
      }
      return { vertices, indices };
    },

    /** All eight PicoGK allocation counters. Zero after cleanup, or a handle leaked. */
    allocated: (lib) => Object.fromEntries(counters.map((c) => [c, Number(allocated[c](lib))])),
  };
}
