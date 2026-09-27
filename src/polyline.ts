// PolyLine wrapper. Small vertex counts by nature, so per-element reads are fine. AddArrow/AddCross are viewer decoration — deliberately dropped.

import { adoptHandle, VEC3_BYTES, type SessionContext } from './context.ts';
import { assertLive, guard } from './errors.ts';
import type { Color, Vec3 } from './types.ts';

export interface PolyLine {
  /** Appends one vertex; returns its index. */
  addVertex(position: Vec3): number;
  /** Appends many vertices. */
  addVertices(positions: readonly Vec3[]): void;
  /** All vertices, index order. */
  readonly vertices: Vec3[];
  readonly vertexCount: number;
  /** RGBA, each 0..1, as the line was created. */
  readonly color: readonly [number, number, number, number];
  bounds(): { min: Vec3; max: Vec3 };
  readonly memUsage: number;
  /** Raw ABI handle — escape hatch. */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed polylines. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function wrapPolyLine(ctx: SessionContext, handle: bigint): PolyLine {
  let disposed = false;
  const live = () => {
    assertLive(disposed, 'PolyLine');
    return handle;
  };

  const polyLine = {
    addVertex(position: Vec3): number {
      ctx.writeVec3(ctx.scratch, position);
      return guard('PolyLine_nAddVertex', () => ctx.raw.PolyLine_nAddVertex(ctx.lib, live(), ctx.scratch))();
    },
    addVertices(positions: readonly Vec3[]) {
      for (const position of positions) polyLine.addVertex(position);
    },
    get vertices(): Vec3[] {
      const count = polyLine.vertexCount;
      const result: Vec3[] = [];
      for (let i = 0; i < count; i++) {
        ctx.raw.PolyLine_GetVertex(ctx.lib, handle, i, ctx.scratch);
        result.push(ctx.readVec3(ctx.scratch));
      }
      return result;
    },
    get vertexCount() {
      return guard('PolyLine_nVertexCount', () => ctx.raw.PolyLine_nVertexCount(ctx.lib, live()))();
    },
    get color(): readonly [number, number, number, number] {
      live();
      ctx.raw.PolyLine_GetColor(ctx.lib, handle, ctx.scratch);
      const f32 = ctx.module.HEAPF32;
      const i = ctx.scratch >>> 2;
      return [f32[i]!, f32[i + 1]!, f32[i + 2]!, f32[i + 3]!];
    },
    bounds() {
      live();
      ctx.raw.PolyLine_GetBoundingBox(ctx.lib, handle, ctx.scratch);
      return { min: ctx.readVec3(ctx.scratch), max: ctx.readVec3(ctx.scratch + VEC3_BYTES) };
    },
    get memUsage() {
      return Number(guard('PolyLine_nMemUsage', () => ctx.raw.PolyLine_nMemUsage(ctx.lib, live()))());
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // idempotent
      disposed = true;
      ctx.registry.unregister(polyLine); // never both GC-free and explicit free
      if (!ctx.dead.value) ctx.raw.PolyLine_Destroy(ctx.lib, handle); // teardown already freed it
    },
  };
  adoptHandle(ctx, polyLine, handle, ctx.raw.PolyLine_Destroy);
  return polyLine as PolyLine; // adoptHandle added [Symbol.dispose]
}

/** Writes an RGBA color (alpha defaults 1) into scratch as PKColorFloat. */
export function writeColor(ctx: SessionContext, pointer: number, color: Color): void {
  const [r, g, b, a = 1] = color;
  const i = pointer >>> 2;
  ctx.module.HEAPF32[i] = r;
  ctx.module.HEAPF32[i + 1] = g;
  ctx.module.HEAPF32[i + 2] = b;
  ctx.module.HEAPF32[i + 3] = a;
}
