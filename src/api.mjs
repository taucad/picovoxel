// R12/R13 — the consumer-facing PicoGK API, per library-api-policy.
//
//   §1  factories over classes   createPicoGK(); wrappers are returned, never constructed
//   §3  flat options             { voxelSize, wasm }; no nested config
//   §4  max 3 params             every method takes one options object
//   §5  naming                   no abbreviations: `vertices` not `verts`, `distance` not `dist`
//   §9  lazy init                wasm instantiates on the awaited factory call
//   §10 escape hatches           `module`/`handle` expose the raw ABI
//   §19 error codes              typed PicoGkError (errors.mjs)
//   resource-cleanup             Symbol.dispose on every handle wrapper
//
// Handles stay BigInt internally and never reach this surface — callers hold objects.
// R9 (narrowing to uint32) was CUT on measurement: 33.6ns/call delta, 0.34ms per 10k
// calls, against multi-second compute. See the blueprint.

import createPicoGKModule from './picogk.mjs';
import { PicoGkError, assertLive, guard } from './errors.ts';

const VEC3_BYTES = 12;
const BBOX_BYTES = 24; // PKBBox3 = 2 x PKVector3

/**
 * @typedef {(x: number, y: number, z: number) => number} SdfFunction
 * @typedef {{ __brand: 'SdfExpression' }} SdfExpression  Designed-in escape hatch (A9), unbuilt.
 * @typedef {SdfFunction | SdfExpression} ImplicitFunction
 */

function requirePositive(value, field, where) {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new PicoGkError('PICOGK_CALL_FAILED',
      `${where} needs a positive ${field} in millimetres, got ${value}.`);
  }
}

/** Creates a PicoGK session. Resolves once the wasm module is instantiated. */
export async function createPicoGK(options = {}) {
  const { voxelSize = 0.5, wasm } = options;

  if (!(voxelSize > 0) || !Number.isFinite(voxelSize)) {
    throw new PicoGkError('PICOGK_CALL_FAILED',
      `voxelSize must be a positive number of millimetres, got ${voxelSize}. ` +
      'Cost scales cubically as it shrinks — 0.5 is a reasonable default.');
  }

  let module;
  try {
    module = await createPicoGKModule(typeof wasm === 'object' && wasm !== null ? wasm : {});
  } catch (cause) {
    throw new PicoGkError('PICOGK_WASM_INIT_FAILED',
      'PicoGK WebAssembly failed to instantiate. Check that picogk.wasm is served next to picogk.mjs ' +
      'and that it is returned with Content-Type: application/wasm.', { cause });
  }

  const { cwrap, ccall, UTF8ToString, _malloc, _free, addFunction, removeFunction } = module;
  const h = 'bigint';
  const raw = {
    createInstance: cwrap('Library_hCreateInstance', h, ['number']),
    destroyInstance: cwrap('Library_DestroyInstance', null, [h]),
    sphere: cwrap('Voxels_hCreateSphere', h, [h, 'number', 'number']),
    capsule: cwrap('Voxels_hCreateCapsule', h, [h, 'number', 'number', 'number', 'number']),
    emptyVoxels: cwrap('Voxels_hCreate', h, [h]),
    renderImplicit: cwrap('Voxels_RenderImplicit', null, [h, h, 'number', 'number']),
    boolAdd: cwrap('Voxels_BoolAdd', null, [h, h, h]),
    boolSubtract: cwrap('Voxels_BoolSubtract', null, [h, h, h]),
    boolIntersect: cwrap('Voxels_BoolIntersect', null, [h, h, h]),
    offset: cwrap('Voxels_Offset', null, [h, h, 'number']),
    volume: cwrap('Voxels_fCalculateVolume', 'number', [h, h]),
    destroyVoxels: cwrap('Voxels_Destroy', null, [h, h]),
    meshFromVoxels: cwrap('Mesh_hCreateFromVoxels', h, [h, h]),
    meshCreate: cwrap('Mesh_hCreate', h, [h]),
    addVertex: cwrap('Mesh_nAddVertex', 'number', [h, h, 'number']),
    addTriangle: cwrap('Mesh_nAddTriangle', 'number', [h, h, 'number']),
    vertexCount: cwrap('Mesh_nVertexCount', 'number', [h, h]),
    triangleCount: cwrap('Mesh_nTriangleCount', 'number', [h, h]),
    getVertices: cwrap('Mesh_GetVertices', 'number', [h, h, 'number', 'number']),
    getTriangles: cwrap('Mesh_GetTriangles', 'number', [h, h, 'number', 'number']),
    destroyMesh: cwrap('Mesh_Destroy', null, [h, h]),
  };

  const COUNTERS = ['Voxels', 'Meshes', 'Lattices', 'PolyLines', 'ScalarFields', 'VectorFields', 'VdbFiles', 'VdbMetas'];
  const rawAllocated = Object.fromEntries(COUNTERS.map((c) => [c, cwrap(`Library_n${c}Allocated`, h, [h])]));

  const lib = raw.createInstance(voxelSize);
  if (!lib) {
    throw new PicoGkError('PICOGK_WASM_INIT_FAILED',
      `Library_hCreateInstance(${voxelSize}) returned a null handle.`);
  }

  const scratch = _malloc(BBOX_BYTES);
  const writeVec3 = (pointer, [x, y, z]) => {
    module.HEAPF32[(pointer >> 2) + 0] = x;
    module.HEAPF32[(pointer >> 2) + 1] = y;
    module.HEAPF32[(pointer >> 2) + 2] = z;
  };
  const readInfo = (fn) => {
    ccall(fn, null, ['number'], [scratch]);
    return UTF8ToString(scratch);
  };

  const readMesh = guard('Mesh_GetVertices/GetTriangles', (meshHandle) => {
    const vertexCount = raw.vertexCount(lib, meshHandle);
    const triangleCount = raw.triangleCount(lib, meshHandle);
    const vertexPointer = _malloc(vertexCount * VEC3_BYTES);
    const trianglePointer = _malloc(triangleCount * VEC3_BYTES);
    try {
      raw.getVertices(lib, meshHandle, vertexPointer, vertexCount);
      raw.getTriangles(lib, meshHandle, trianglePointer, triangleCount);
      // Copied, not viewed: ALLOW_MEMORY_GROWTH detaches HEAPF32's ArrayBuffer when
      // memory grows, so a returned view could silently empty later.
      return {
        vertices: new Float32Array(module.HEAPF32.subarray(vertexPointer >> 2, (vertexPointer >> 2) + vertexCount * 3)),
        triangles: new Uint32Array(module.HEAPU32.subarray(trianglePointer >> 2, (trianglePointer >> 2) + triangleCount * 3)),
      };
    } finally {
      _free(vertexPointer);
      _free(trianglePointer);
    }
  });

  function wrapMesh(handle) {
    let disposed = false;
    let cached = null;
    const mesh = {
      get vertices() { assertLive(disposed, 'Mesh'); return (cached ??= readMesh(handle)).vertices; },
      get triangles() { assertLive(disposed, 'Mesh'); return (cached ??= readMesh(handle)).triangles; },
      get vertexCount() { assertLive(disposed, 'Mesh'); return raw.vertexCount(lib, handle); },
      get triangleCount() { assertLive(disposed, 'Mesh'); return raw.triangleCount(lib, handle); },
      get handle() { return handle; },
      dispose() {
        if (disposed) return; // idempotent: double dispose must not double-free
        disposed = true;
        cached = null;
        raw.destroyMesh(lib, handle);
      },
    };
    mesh[Symbol.dispose] = mesh.dispose;
    return mesh;
  }

  function wrapVoxels(handle) {
    let disposed = false;
    const live = () => { assertLive(disposed, 'Voxels'); return handle; };

    // PicoGK's booleans mutate the left operand in place. Copy first so the fluent
    // form is pure and `a.subtract(b)` never silently destroys `a`.
    const derive = (operation, other, name) => {
      const copy = raw.emptyVoxels(lib);
      raw.boolAdd(lib, copy, live());
      guard(name, () => operation(lib, copy, other.handle))();
      return wrapVoxels(copy);
    };

    const voxels = {
      add: (other) => derive(raw.boolAdd, other, 'Voxels_BoolAdd'),
      subtract: (other) => derive(raw.boolSubtract, other, 'Voxels_BoolSubtract'),
      intersect: (other) => derive(raw.boolIntersect, other, 'Voxels_BoolIntersect'),
      offset({ distance }) {
        if (!Number.isFinite(distance)) {
          throw new PicoGkError('PICOGK_CALL_FAILED',
            `offset({ distance }) needs a finite number of millimetres, got ${distance}. Negative shells inward.`);
        }
        const copy = raw.emptyVoxels(lib);
        raw.boolAdd(lib, copy, live());
        guard('Voxels_Offset', () => raw.offset(lib, copy, distance))();
        return wrapVoxels(copy);
      },
      /** Volume in cubic millimetres. */
      get volume() { return guard('Voxels_fCalculateVolume', () => raw.volume(lib, live()))(); },
      toMesh: () => wrapMesh(guard('Mesh_hCreateFromVoxels', () => raw.meshFromVoxels(lib, live()))()),
      get handle() { return handle; },
      dispose() {
        if (disposed) return;
        disposed = true;
        raw.destroyVoxels(lib, handle);
      },
    };
    voxels[Symbol.dispose] = voxels.dispose;
    return voxels;
  }

  // R13 — the implicit path, the reason PicoGK exists.
  // The C callback is float(*)(const PKVector3*), so this trampoline reads the struct
  // and hands the author three scalars (A6): at ~10^7 samples, allocating a vector
  // object per call is the difference between slow and unusable.
  // RenderImplicit is a SERIAL triple-nested loop (PicoGKVdbVoxels.h:370-381), so a JS
  // callback is correct under pthreads — and gains exactly zero from them.
  function renderImplicit(target, sdf, boundsMin, boundsMax) {
    if (typeof sdf !== 'function') {
      throw new PicoGkError('PICOGK_CALL_FAILED',
        'sdf must be a function (x, y, z) => number returning signed distance in millimetres. ' +
        'SdfExpression (a compiled DSL) is reserved in the type surface but not implemented — pass a function.');
    }
    const trampoline = (coordinatePointer) => {
      const i = coordinatePointer >> 2;
      return sdf(module.HEAPF32[i], module.HEAPF32[i + 1], module.HEAPF32[i + 2]);
    };
    const pointer = addFunction(trampoline, 'fi'); // float (i32)
    try {
      writeVec3(scratch, boundsMin);
      writeVec3(scratch + VEC3_BYTES, boundsMax);
      guard('Voxels_RenderImplicit', () => raw.renderImplicit(lib, target, scratch, pointer))();
    } finally {
      removeFunction(pointer); // function-table slots leak without this
    }
  }

  let disposed = false;
  const picogk = {
    get voxelSize() { return voxelSize; },
    get name() { return readInfo('Library_GetName'); },
    get version() { return readInfo('Library_GetVersion'); },
    get buildInfo() { return readInfo('Library_GetBuildInfo'); },

    createVoxels(options) {
      assertLive(disposed, 'PicoGK session');
      const { shape } = options;
      switch (shape) {
        case 'sphere': {
          const { center = [0, 0, 0], radius } = options;
          requirePositive(radius, 'radius', 'createVoxels({ shape: "sphere" })');
          writeVec3(scratch, center);
          return wrapVoxels(guard('Voxels_hCreateSphere', () => raw.sphere(lib, scratch, radius))());
        }
        case 'capsule': {
          const { start, end, radius } = options;
          requirePositive(radius, 'radius', 'createVoxels({ shape: "capsule" })');
          if (!start || !end) {
            throw new PicoGkError('PICOGK_CALL_FAILED',
              'createVoxels({ shape: "capsule" }) needs start and end as [x, y, z] in millimetres.');
          }
          writeVec3(scratch, start);
          writeVec3(scratch + VEC3_BYTES, end);
          return wrapVoxels(
            guard('Voxels_hCreateCapsule', () => raw.capsule(lib, scratch, scratch + VEC3_BYTES, radius, radius))(),
          );
        }
        case 'implicit': {
          const { boundsMin, boundsMax, sdf } = options;
          if (!boundsMin || !boundsMax) {
            throw new PicoGkError('PICOGK_CALL_FAILED',
              'createVoxels({ shape: "implicit" }) needs boundsMin and boundsMax as [x, y, z] in millimetres. ' +
              'The SDF is only sampled inside that box, so it must enclose the shape.');
          }
          const target = raw.emptyVoxels(lib);
          renderImplicit(target, sdf, boundsMin, boundsMax);
          return wrapVoxels(target);
        }
        default:
          throw new PicoGkError('PICOGK_CALL_FAILED',
            `Unknown shape "${shape}". Supported: "sphere", "capsule", "implicit".`);
      }
    },

    /** Builds a mesh directly from vertex/triangle data — no voxels involved. */
    createMesh({ vertices, triangles }) {
      assertLive(disposed, 'PicoGK session');
      const mesh = raw.meshCreate(lib);
      for (let i = 0; i < vertices.length; i += 3) {
        writeVec3(scratch, [vertices[i], vertices[i + 1], vertices[i + 2]]);
        raw.addVertex(lib, mesh, scratch);
      }
      for (let i = 0; i < triangles.length; i += 3) {
        module.HEAP32[(scratch >> 2) + 0] = triangles[i];
        module.HEAP32[(scratch >> 2) + 1] = triangles[i + 1];
        module.HEAP32[(scratch >> 2) + 2] = triangles[i + 2];
        raw.addTriangle(lib, mesh, scratch);
      }
      return wrapMesh(mesh);
    },

    /** PicoGK's own per-type allocation counters — the leak oracle. */
    get allocated() {
      return Object.fromEntries(COUNTERS.map((c) => [c, Number(rawAllocated[c](lib))]));
    },

    /** §10 escape hatches: the raw Emscripten module and Library handle. */
    get module() { return module; },
    get handle() { return lib; },

    dispose() {
      if (disposed) return;
      disposed = true;
      _free(scratch);
      raw.destroyInstance(lib);
    },
  };
  picogk[Symbol.dispose] = picogk.dispose;
  return picogk;
}

export { PicoGkError };
