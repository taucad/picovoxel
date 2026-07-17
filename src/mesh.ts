// Mesh wrapper. Bulk-first: vertices/triangles cross the ABI in two calls (R11's
// ~150×), and every read out of wasm memory is copied — ALLOW_MEMORY_GROWTH detaches
// heap views, so a returned subarray could silently empty later.

import { adoptHandle, TRI_BYTES, VEC3_BYTES, type SessionContext } from './context.ts';
import { assertLive, guard } from './errors.ts';

export interface Mesh {
  /** Vertex positions, xyz triples in mm. A fresh copy; the caller owns it. */
  readonly vertices: Float32Array;
  /** Triangle corner indices, triples. A fresh copy; the caller owns it. */
  readonly triangles: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed meshes. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function wrapMesh(ctx: SessionContext, handle: bigint): Mesh {
  let disposed = false;
  let cached: { vertices: Float32Array; triangles: Uint32Array } | null = null;
  const live = () => {
    assertLive(disposed, 'Mesh');
    return handle;
  };

  const readAll = guard('Mesh_GetVertices/GetTriangles', () => {
    const { module, raw, lib } = ctx;
    const vertexCount = raw.Mesh_nVertexCount(lib, handle);
    const triangleCount = raw.Mesh_nTriangleCount(lib, handle);
    const vertexPointer = module._malloc(vertexCount * VEC3_BYTES);
    const trianglePointer = module._malloc(triangleCount * TRI_BYTES);
    try {
      raw.Mesh_GetVertices(lib, handle, vertexPointer, vertexCount);
      raw.Mesh_GetTriangles(lib, handle, trianglePointer, triangleCount);
      return {
        vertices: new Float32Array(module.HEAPF32.subarray(vertexPointer >> 2, (vertexPointer >> 2) + vertexCount * 3)),
        triangles: new Uint32Array(module.HEAPU32.subarray(trianglePointer >> 2, (trianglePointer >> 2) + triangleCount * 3)),
      };
    } finally {
      module._free(vertexPointer);
      module._free(trianglePointer);
    }
  });

  const mesh = {
    get vertices() {
      live();
      return (cached ??= readAll()).vertices;
    },
    get triangles() {
      live();
      return (cached ??= readAll()).triangles;
    },
    get vertexCount() {
      return ctx.raw.Mesh_nVertexCount(ctx.lib, live());
    },
    get triangleCount() {
      return ctx.raw.Mesh_nTriangleCount(ctx.lib, live());
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // idempotent: double dispose must not double-free (D3)
      disposed = true;
      cached = null;
      ctx.registry.unregister(mesh); // D2: never both GC-free and explicit-free
      if (!ctx.dead.value) ctx.raw.Mesh_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, mesh, handle, ctx.raw.Mesh_Destroy);
  return mesh as Mesh; // adoptHandle added [Symbol.dispose] (D6)
}
