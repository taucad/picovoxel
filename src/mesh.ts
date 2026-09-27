// Mesh wrapper. Bulk-first: vertices/triangles cross the ABI in two calls each way
// (R11/R8), and every read out of wasm memory is copied — ALLOW_MEMORY_GROWTH
// detaches heap views, so a returned subarray could silently empty later.
// Geometry transforms (transform/mirror/merged) run in TS over the bulk arrays and
// write back through the bulk imports, preserving indexing — and fixing upstream B1
// (mshCreateTransformed scales each triangle corner by a DIFFERENT axis component).

import { adoptHandle, assertSameSession, checkedMalloc, expectHandle, TRI_BYTES, VEC3_BYTES, type SessionContext } from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import { createGlb } from './glb.ts';
import { assertLaneExport, EXACT_LANE_SET, laneOf, unionLaneSets, type LaneSet } from './lanes.ts';
import { provenanceOf, recordProvenance } from './metadata.ts';
import { writeStlBytes, type ToStlOptions } from './stl.ts';
import type { Bounds, Mat4, Vec3 } from './types.ts';
import type { Voxels } from './voxels.ts';

export type TransformOptions =
  | { matrix: Mat4 }
  | { scale: number | Vec3; offset?: Vec3 };

export interface Mesh {
  /** Vertex positions, xyz triples in mm. A fresh copy; the caller owns it. */
  readonly vertices: Float32Array;
  /** Triangle corner indices, triples. A fresh copy; the caller owns it. */
  readonly triangles: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Bounding box; the SG15 sentinel (±FLT_MAX) for an empty mesh, never NaN. */
  bounds(): Bounds;
  /**
   * Pure transformed copy. `scale` is component-wise (`Vec3`) or uniform (number),
   * applied before `offset` — every vertex gets the same scale (fixes upstream B1).
   * `matrix` follows System.Numerics row-vector convention (translation in 12–14).
   */
  transform(options: TransformOptions): Mesh;
  /** Pure mirrored copy across the plane through `point` with `normal`. */
  mirror(options: { point: Vec3; normal: Vec3 }): Mesh;
  /** Pure concatenation — no dedup, no boolean (as upstream Append documents). */
  merged(other: Mesh): Mesh;
  /** Voxelizes the (closed) mesh. */
  toVoxels(): Voxels;
  /** SG13 — offset in ALL directions from a not-necessarily-closed mesh. */
  shellVoxels(options: { radius: number }): Voxels;
  /**
   * SG7 — binary STL bytes with the UNITS= header convention.
   *
   * §14.1 export boundary, keyed by the session's claim (LANES item 1, the
   * D2+D3 hybrid ratified 2026-09-27; Class-2 provenance only — Class-3
   * policy is reserved for SK-2): exact provenance always exports with the
   * historical header. Non-exact provenance is stamped into the 80-byte
   * header (`LANE=fast`, read back by `meshFromStl`) and
   * - in a `lane: 'fast'` session (explicit, or resolved from `'auto'` —
   *   choosing "best available" is choosing acceleration) exports without
   *   asking when every member is `fast`: declaring the lane was the consent;
   * - otherwise — a session that declared no lane (`'open'`), or any member
   *   outside Class 2 (`gpu-l1`, `unknown`, …) in any session — refuses with
   *   `PICO_LANE_EXPORT` unless acknowledged with `{ acceptLane: 'fast' }`.
   * A `lane: 'exact'` session never holds non-exact geometry. The stamp is a
   * best-effort audit, not security: third-party tools rewrite STL headers.
   */
  toStl(options?: ToStlOptions): Uint8Array;
  /**
   * GLB container (positions + indices). GLB has no provenance slot until
   * V0.18, so non-exact provenance refuses with `PICO_LANE_EXPORT` in EVERY
   * session — including `lane: 'fast'` — unless acknowledged with
   * `{ acceptLane: 'fast' }`, and the acknowledged bytes record nothing.
   */
  toGlb(options?: { acceptLane?: 'fast' }): Uint8Array;
  /** §14.1 value-class provenance, inherited from the producing voxels/mesh chain. */
  readonly lane: 'exact' | 'fast';
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed meshes. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Writes vertex/triangle arrays into a fresh raw mesh via the R8 bulk imports. */
export function bulkCreateMesh(ctx: SessionContext, vertices: ArrayLike<number>, triangles: ArrayLike<number>): bigint {
  const vertexCount = vertices.length / 3;
  const triangleCount = triangles.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(triangleCount)) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `createMesh needs xyz/index triples: got ${vertices.length} vertex floats, ${triangles.length} indices.`,
    );
  }
  for (let i = 0; i < triangles.length; i++) {
    const index = triangles[i]!;
    if (!(index >= 0 && index < vertexCount) || !Number.isInteger(index)) {
      throw new PicoError(
        'PICO_INVALID_ARGUMENT',
        `Triangle corner ${i} references vertex ${index}, outside [0, ${vertexCount}). ` +
          'The native side does not range-check in release builds — this would corrupt geometry silently.',
      );
    }
  }

  const { module, raw, lib } = ctx;
  const mesh = expectHandle('Mesh_hCreate', raw.Mesh_hCreate(lib));
  if (vertexCount > 0) {
    const vertexPointer = checkedMalloc(module, vertexCount * VEC3_BYTES, 'mesh vertices');
    try {
      module.HEAPF32.set(vertices as ArrayLike<number> & { length: number }, vertexPointer >>> 2);
      raw.Mesh_AddVertices(lib, mesh, vertexPointer, vertexCount);
    } finally {
      module._free(vertexPointer);
    }
  }
  if (triangleCount > 0) {
    const trianglePointer = checkedMalloc(module, triangleCount * TRI_BYTES, 'mesh triangles');
    try {
      module.HEAPU32.set(triangles as ArrayLike<number> & { length: number }, trianglePointer >>> 2);
      raw.Mesh_AddTriangles(lib, mesh, trianglePointer, triangleCount);
    } finally {
      module._free(trianglePointer);
    }
  }
  return mesh;
}

/** Meshes carry provenance TS-side only (the ABI has no mesh metadata slot). */
export function wrapMesh(ctx: SessionContext, handle: bigint, lane: LaneSet = EXACT_LANE_SET): Mesh {
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
    const vertexPointer = checkedMalloc(module, vertexCount * VEC3_BYTES, 'mesh vertices');
    const trianglePointer = checkedMalloc(module, triangleCount * TRI_BYTES, 'mesh triangles');
    try {
      raw.Mesh_GetVertices(lib, handle, vertexPointer, vertexCount);
      raw.Mesh_GetTriangles(lib, handle, trianglePointer, triangleCount);
      return {
        vertices: new Float32Array(module.HEAPF32.subarray(vertexPointer >>> 2, (vertexPointer >>> 2) + vertexCount * 3)),
        triangles: new Uint32Array(module.HEAPU32.subarray(trianglePointer >>> 2, (trianglePointer >>> 2) + triangleCount * 3)),
      };
    } finally {
      module._free(vertexPointer);
      module._free(trianglePointer);
    }
  });

  /** Pure vertex-remap derivation: same triangles, transformed vertex array. */
  const deriveVertices = (remap: (x: number, y: number, z: number, out: Float32Array, at: number) => void): Mesh => {
    live();
    const source = cached ?? readAll();
    const transformed = new Float32Array(source.vertices.length);
    for (let i = 0; i < source.vertices.length; i += 3) {
      remap(source.vertices[i]!, source.vertices[i + 1]!, source.vertices[i + 2]!, transformed, i);
    }
    return wrapMesh(ctx, bulkCreateMesh(ctx, transformed, source.triangles), lane);
  };

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
    bounds(): Bounds {
      live();
      ctx.raw.Mesh_GetBoundingBox(ctx.lib, handle, ctx.scratch);
      return { min: ctx.readVec3(ctx.scratch), max: ctx.readVec3(ctx.scratch + VEC3_BYTES) };
    },
    transform(options: TransformOptions): Mesh {
      if ('matrix' in options) {
        const m = options.matrix;
        if (m.length !== 16) {
          throw new PicoError('PICO_INVALID_ARGUMENT', `transform matrix needs 16 elements, got ${m.length}.`);
        }
        return deriveVertices((x, y, z, out, at) => {
          out[at] = x * (m[0] as number) + y * (m[4] as number) + z * (m[8] as number) + (m[12] as number);
          out[at + 1] = x * (m[1] as number) + y * (m[5] as number) + z * (m[9] as number) + (m[13] as number);
          out[at + 2] = x * (m[2] as number) + y * (m[6] as number) + z * (m[10] as number) + (m[14] as number);
        });
      }
      const { scale, offset = [0, 0, 0] } = options;
      const [sx, sy, sz] = typeof scale === 'number' ? [scale, scale, scale] : scale;
      // B1 fix: component-wise scale applied to EVERY vertex — upstream multiplied
      // corner A by scale.X, B by scale.Y, C by scale.Z (Mesh.cs:86-88).
      return deriveVertices((x, y, z, out, at) => {
        out[at] = x * sx + offset[0];
        out[at + 1] = y * sy + offset[1];
        out[at + 2] = z * sz + offset[2];
      });
    },
    mirror({ point, normal }: { point: Vec3; normal: Vec3 }): Mesh {
      const length = Math.hypot(normal[0], normal[1], normal[2]);
      if (!(length > 0)) {
        throw new PicoError('PICO_INVALID_ARGUMENT', 'mirror needs a non-zero plane normal.');
      }
      const [nx, ny, nz] = [normal[0] / length, normal[1] / length, normal[2] / length];
      // Winding is preserved as upstream does (mshCreateMirrored keeps corner order),
      // so the mirrored surface's orientation flips — matches C# behaviour.
      return deriveVertices((x, y, z, out, at) => {
        const d = 2 * ((x - point[0]) * nx + (y - point[1]) * ny + (z - point[2]) * nz);
        out[at] = x - d * nx;
        out[at + 1] = y - d * ny;
        out[at + 2] = z - d * nz;
      });
    },
    merged(other: Mesh): Mesh {
      live();
      assertSameSession(ctx, other, 'merged operand');
      const resultLane = unionLaneSets(lane, provenanceOf(other)); // throws on a non-mesh operand
      const a = cached ?? readAll();
      const b = { vertices: other.vertices, triangles: other.triangles };
      const vertices = new Float32Array(a.vertices.length + b.vertices.length);
      vertices.set(a.vertices, 0);
      vertices.set(b.vertices, a.vertices.length);
      const offset = a.vertices.length / 3;
      const triangles = new Uint32Array(a.triangles.length + b.triangles.length);
      triangles.set(a.triangles, 0);
      for (let i = 0; i < b.triangles.length; i++) triangles[a.triangles.length + i] = b.triangles[i]! + offset;
      return wrapMesh(ctx, bulkCreateMesh(ctx, vertices, triangles), resultLane);
    },
    toVoxels(): Voxels {
      const target = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
      guard('Voxels_RenderMesh', () => ctx.raw.Voxels_RenderMesh(ctx.lib, target, live()))();
      return ctx.wrapVoxels(target, lane);
    },
    shellVoxels({ radius }: { radius: number }): Voxels {
      if (!(radius > 0)) {
        throw new PicoError('PICO_INVALID_ARGUMENT', `shellVoxels needs a positive radius in millimetres, got ${radius}.`);
      }
      return ctx.wrapVoxels(
        expectHandle('Voxels_hCreateMeshShell', guard('Voxels_hCreateMeshShell', () => ctx.raw.Voxels_hCreateMeshShell(ctx.lib, live(), radius))()),
        lane,
      );
    },
    toStl(options: ToStlOptions = {}): Uint8Array {
      live();
      assertLaneExport('toStl', 'a mesh', lane, ctx.lane, options.acceptLane);
      const data = cached ?? readAll();
      return writeStlBytes(data.vertices, data.triangles, options, lane);
    },
    toGlb(options: { acceptLane?: 'fast' } = {}): Uint8Array {
      live();
      if (lane.length > 0 && options.acceptLane !== 'fast') {
        throw new PicoError(
          'PICO_LANE_EXPORT',
          `toGlb() on a mesh with non-exact provenance (${lane.join(',')}): GLB has no provenance slot yet, so ` +
            "the export cannot record the lane — it refuses in every session, including lane: 'fast'. Acknowledge " +
            "with toGlb({ acceptLane: 'fast' }) (the bytes record nothing), export STL (which stamps the lane), or " +
            "rebuild the chain in a lane: 'exact' session.",
        );
      }
      const data = cached ?? readAll();
      return createGlb(data.vertices, data.triangles);
    },
    get lane() {
      return laneOf(lane);
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
  recordProvenance(mesh, lane);
  adoptHandle(ctx, mesh, handle, ctx.raw.Mesh_Destroy);
  return mesh as Mesh; // adoptHandle added [Symbol.dispose] (D6)
}
