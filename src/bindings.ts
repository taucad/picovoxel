// Hand-bound cwrap table for the facade, keyed by ABI export name.
//
// R9 replaces this module with the generated raw layer (same names, same shapes,
// generated from abi.json) — call sites are written against ABI names so that swap
// is one import line. Handles are BigInt (WASM_BIGINT); pointers are numbers.

import type { PicoGkWasmModule } from './types.ts';

const h = 'bigint';
const n = 'number';

export function bindRaw(module: PicoGkWasmModule) {
  const cw = <T>(name: string, ret: string | null, args: string[]): T =>
    module.cwrap(name, ret, args) as unknown as T;

  return {
    Library_hCreateInstance: cw<(voxelSize: number) => bigint>('Library_hCreateInstance', h, [n]),
    Library_DestroyInstance: cw<(lib: bigint) => void>('Library_DestroyInstance', null, [h]),
    Library_nTotalMemUsage: cw<(lib: bigint) => bigint>('Library_nTotalMemUsage', h, [h]),

    Voxels_hCreate: cw<(lib: bigint) => bigint>('Voxels_hCreate', h, [h]),
    Voxels_hCreateCopy: cw<(lib: bigint, voxels: bigint) => bigint>('Voxels_hCreateCopy', h, [h, h]),
    Voxels_hCreateSphere: cw<(lib: bigint, centerPtr: number, radius: number) => bigint>('Voxels_hCreateSphere', h, [h, n, n]),
    Voxels_hCreateCapsule: cw<(lib: bigint, aPtr: number, bPtr: number, radiusA: number, radiusB: number) => bigint>('Voxels_hCreateCapsule', h, [h, n, n, n, n]),
    Voxels_RenderImplicit: cw<(lib: bigint, voxels: bigint, bboxPtr: number, sdfPtr: number) => void>('Voxels_RenderImplicit', null, [h, h, n, n]),
    Voxels_BoolAdd: cw<(lib: bigint, voxels: bigint, operand: bigint) => void>('Voxels_BoolAdd', null, [h, h, h]),
    Voxels_BoolSubtract: cw<(lib: bigint, voxels: bigint, operand: bigint) => void>('Voxels_BoolSubtract', null, [h, h, h]),
    Voxels_BoolIntersect: cw<(lib: bigint, voxels: bigint, operand: bigint) => void>('Voxels_BoolIntersect', null, [h, h, h]),
    Voxels_Offset: cw<(lib: bigint, voxels: bigint, distance: number) => void>('Voxels_Offset', null, [h, h, n]),
    Voxels_fCalculateVolume: cw<(lib: bigint, voxels: bigint) => number>('Voxels_fCalculateVolume', n, [h, h]),
    Voxels_Destroy: cw<(lib: bigint, voxels: bigint) => void>('Voxels_Destroy', null, [h, h]),

    Mesh_hCreate: cw<(lib: bigint) => bigint>('Mesh_hCreate', h, [h]),
    Mesh_hCreateFromVoxels: cw<(lib: bigint, voxels: bigint) => bigint>('Mesh_hCreateFromVoxels', h, [h, h]),
    Mesh_nAddVertex: cw<(lib: bigint, mesh: bigint, vecPtr: number) => number>('Mesh_nAddVertex', n, [h, h, n]),
    Mesh_nAddTriangle: cw<(lib: bigint, mesh: bigint, triPtr: number) => number>('Mesh_nAddTriangle', n, [h, h, n]),
    Mesh_nVertexCount: cw<(lib: bigint, mesh: bigint) => number>('Mesh_nVertexCount', n, [h, h]),
    Mesh_nTriangleCount: cw<(lib: bigint, mesh: bigint) => number>('Mesh_nTriangleCount', n, [h, h]),
    Mesh_GetVertices: cw<(lib: bigint, mesh: bigint, bufferPtr: number, count: number) => number>('Mesh_GetVertices', n, [h, h, n, n]),
    Mesh_GetTriangles: cw<(lib: bigint, mesh: bigint, bufferPtr: number, count: number) => number>('Mesh_GetTriangles', n, [h, h, n, n]),
    Mesh_Destroy: cw<(lib: bigint, mesh: bigint) => void>('Mesh_Destroy', null, [h, h]),
  };
}

export type RawTable = ReturnType<typeof bindRaw>;
