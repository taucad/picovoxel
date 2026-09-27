// ScalarField / VectorField wrappers.
//
// Values live at activated positions only: `get` returns null where nothing was set
// (the C# bool/out dual). Traverse callbacks receive scalars, never vector objects —
// the narrow band of a real field is 10^4–10^6 visits (R20's allocation rule).
// The ABI has no VectorField_GetVoxelDimensions/GetSlice, so dimensions/getSlice/
// bounds/signedDistanceAt exist on ScalarField only.

import {
  adoptHandle,
  assertSameSession,
  checkedMalloc,
  expectHandle,
  VEC3_BYTES,
  type SessionContext,
} from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import { laneOf, type LaneSet } from './lanes.ts';
import { recordProvenance, settleProvenance, tagFieldClass, wrapMetadata, type Metadata } from './metadata.ts';
import type { Bounds, Vec3 } from './types.ts';
import type { Voxels } from './voxels.ts';

export interface ScalarFieldSlice {
  width: number;
  height: number;
  /** Raw field values, row-major. A fresh copy; the caller owns it. */
  data: Float32Array;
}

interface FieldBase {
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  readonly memUsage: number;
  readonly metadata: Metadata;
  /** §14.1 value-class provenance, inherited from the source voxels chain. */
  readonly lane: 'exact' | 'fast';
  /** Optional: GC reclaims un-disposed fields. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface ScalarField extends FieldBase {
  /** Sets (and activates) the value at a position in mm. */
  set(position: Vec3, value: number): void;
  /** Value at the position, or null when the position holds no value. */
  get(position: Vec3): number | null;
  remove(position: Vec3): void;
  /** Visits every active value. Callback gets scalars: (x, y, z, value). */
  traverse(callback: (x: number, y: number, z: number, value: number) => void): void;
  /** Field extent in discrete voxel units. */
  dimensions(): { origin: Vec3; size: Vec3 };
  /** One Z slice of raw field values. */
  getSlice(options: { index: number }): ScalarFieldSlice;
  /** Bounding box of active voxels in mm (dims × voxel size, as C# does). */
  bounds(): Bounds;
  /** SG6 — stored values are voxel-unit signed distance: result = value × voxelSize. */
  signedDistanceAt(position: Vec3): number | null;
  clone(): ScalarField;
}

export interface VectorField extends FieldBase {
  set(position: Vec3, value: Vec3): void;
  get(position: Vec3): Vec3 | null;
  remove(position: Vec3): void;
  /** Visits every active value. Callback gets scalars: (x, y, z, vx, vy, vz). */
  traverse(callback: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void): void;
  clone(): VectorField;
}

/** Runs `body` with a wasm callback-table slot; always removes it (slots leak). */
function withCallback<T>(ctx: SessionContext, signature: string, fn: (...args: number[]) => void, body: (pointer: number) => T): T {
  const pointer = ctx.module.addFunction(fn, signature);
  try {
    return body(pointer);
  } finally {
    ctx.module.removeFunction(pointer);
  }
}

export function wrapScalarField(ctx: SessionContext, handle: bigint, provenance?: LaneSet): ScalarField {
  let disposed = false;
  let metadataCache: Metadata | null = null;
  // §14.1 provenance — same persisted-set scheme as wrapVoxels (omit = a .vdb load).
  const lane = settleProvenance(
    ctx,
    ctx.raw.Metadata_hFromScalarField,
    handle,
    provenance,
    ctx.raw.ScalarField_Destroy,
    'getScalarField',
  );
  const live = () => {
    assertLive(disposed, 'ScalarField');
    return handle;
  };
  const dims = () => {
    const p = checkedMalloc(ctx.module, 24, 'a dimensions scratch buffer');
    try {
      ctx.raw.ScalarField_GetVoxelDimensions(ctx.lib, live(), p, p + 4, p + 8, p + 12, p + 16, p + 20);
      const i32 = (offset: number) => ctx.module.HEAP32[(p + offset) >>> 2]!;
      return { origin: [i32(0), i32(4), i32(8)] as Vec3, size: [i32(12), i32(16), i32(20)] as Vec3 };
    } finally {
      ctx.module._free(p);
    }
  };

  const field = {
    set(position: Vec3, value: number) {
      ctx.writeVec3(ctx.scratch, position);
      guard('ScalarField_SetValue', () => ctx.raw.ScalarField_SetValue(ctx.lib, live(), ctx.scratch, value))();
    },
    get(position: Vec3): number | null {
      ctx.writeVec3(ctx.scratch, position);
      const out = ctx.scratch + VEC3_BYTES;
      const found = guard('ScalarField_bGetValue', () => ctx.raw.ScalarField_bGetValue(ctx.lib, live(), ctx.scratch, out))();
      return found ? ctx.module.HEAPF32[out >>> 2]! : null;
    },
    remove(position: Vec3) {
      ctx.writeVec3(ctx.scratch, position);
      guard('ScalarField_RemoveValue', () => ctx.raw.ScalarField_RemoveValue(ctx.lib, live(), ctx.scratch))();
    },
    traverse(callback: (x: number, y: number, z: number, value: number) => void) {
      live();
      // C signature: void(const PKVector3*, float) — 'vif'.
      withCallback(ctx, 'vif', (positionPointer: number, value: number) => {
        const f32 = ctx.module.HEAPF32;
        const i = positionPointer! >>> 2;
        callback(f32[i]!, f32[i + 1]!, f32[i + 2]!, value!);
      }, (pointer) => guard('ScalarField_TraverseActive', () => ctx.raw.ScalarField_TraverseActive(ctx.lib, handle, pointer))());
    },
    dimensions: () => dims(),
    getSlice({ index }: { index: number }) {
      const { size } = dims();
      const [width, height, depth] = [size[0], size[1], size[2]];
      if (!Number.isInteger(index) || index < 0 || index >= depth) {
        throw new PicoError('PICO_INVALID_ARGUMENT', `getSlice index ${index} out of range [0, ${depth}).`);
      }
      const buffer = checkedMalloc(ctx.module, width * height * 4, 'a slice image buffer');
      try {
        ctx.raw.ScalarField_GetSlice(ctx.lib, handle, index, buffer);
        return { width, height, data: new Float32Array(ctx.module.HEAPF32.subarray(buffer >>> 2, (buffer >>> 2) + width * height)) };
      } finally {
        ctx.module._free(buffer);
      }
    },
    bounds(): Bounds {
      const { origin, size } = dims();
      const toMm = (i: number, j: number, k: number): Vec3 => {
        ctx.writeVec3(ctx.scratch, [i, j, k]);
        ctx.raw.Library_VoxelsToMm(ctx.lib, ctx.scratch, ctx.scratch + VEC3_BYTES);
        return ctx.readVec3(ctx.scratch + VEC3_BYTES);
      };
      return {
        min: toMm(origin[0], origin[1], origin[2]),
        max: toMm(origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]),
      };
    },
    signedDistanceAt(position: Vec3): number | null {
      const value = field.get(position);
      return value === null ? null : value * ctx.voxelSize; // SG6
    },
    clone(): ScalarField {
      return wrapScalarField(ctx, expectHandle('ScalarField_hCreateCopy', ctx.raw.ScalarField_hCreateCopy(ctx.lib, live())), lane);
    },
    get lane() {
      return laneOf(lane);
    },
    get memUsage() {
      return Number(guard('ScalarField_nMemUsage', () => ctx.raw.ScalarField_nMemUsage(ctx.lib, live()))());
    },
    get metadata(): Metadata {
      live();
      return (metadataCache ??= wrapMetadata(
        ctx,
        expectHandle('Metadata_hFromScalarField', ctx.raw.Metadata_hFromScalarField(ctx.lib, handle)),
      ));
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      metadataCache?.dispose();
      ctx.registry.unregister(field); // D2
      if (!ctx.dead.value) ctx.raw.ScalarField_Destroy(ctx.lib, handle); // D4
    },
  };
  tagFieldClass(ctx, ctx.raw.Metadata_hFromScalarField, handle, 'ScalarField'); // SG4
  recordProvenance(field, lane);
  adoptHandle(ctx, field, handle, ctx.raw.ScalarField_Destroy);
  return field as ScalarField; // adoptHandle added [Symbol.dispose] (D6)
}

export function wrapVectorField(ctx: SessionContext, handle: bigint, provenance?: LaneSet): VectorField {
  let disposed = false;
  let metadataCache: Metadata | null = null;
  // §14.1 provenance — same persisted-set scheme as wrapVoxels (omit = a .vdb load).
  const lane = settleProvenance(
    ctx,
    ctx.raw.Metadata_hFromVectorField,
    handle,
    provenance,
    ctx.raw.VectorField_Destroy,
    'getVectorField',
  );
  const live = () => {
    assertLive(disposed, 'VectorField');
    return handle;
  };

  const field = {
    set(position: Vec3, value: Vec3) {
      ctx.writeVec3(ctx.scratch, position);
      ctx.writeVec3(ctx.scratch + VEC3_BYTES, value);
      guard('VectorField_SetValue', () => ctx.raw.VectorField_SetValue(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES))();
    },
    get(position: Vec3): Vec3 | null {
      ctx.writeVec3(ctx.scratch, position);
      const out = ctx.scratch + VEC3_BYTES;
      const found = guard('VectorField_bGetValue', () => ctx.raw.VectorField_bGetValue(ctx.lib, live(), ctx.scratch, out))();
      return found ? ctx.readVec3(out) : null;
    },
    remove(position: Vec3) {
      ctx.writeVec3(ctx.scratch, position);
      guard('VectorField_RemoveValue', () => ctx.raw.VectorField_RemoveValue(ctx.lib, live(), ctx.scratch))();
    },
    traverse(callback: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void) {
      live();
      // C signature: void(const PKVector3*, const PKVector3*) — 'vii'.
      withCallback(ctx, 'vii', (positionPointer: number, valuePointer: number) => {
        const f32 = ctx.module.HEAPF32;
        const i = positionPointer! >>> 2;
        const j = valuePointer! >>> 2;
        callback(f32[i]!, f32[i + 1]!, f32[i + 2]!, f32[j]!, f32[j + 1]!, f32[j + 2]!);
      }, (pointer) => guard('VectorField_TraverseActive', () => ctx.raw.VectorField_TraverseActive(ctx.lib, handle, pointer))());
    },
    clone(): VectorField {
      return wrapVectorField(ctx, expectHandle('VectorField_hCreateCopy', ctx.raw.VectorField_hCreateCopy(ctx.lib, live())), lane);
    },
    get lane() {
      return laneOf(lane);
    },
    get memUsage() {
      return Number(guard('VectorField_nMemUsage', () => ctx.raw.VectorField_nMemUsage(ctx.lib, live()))());
    },
    get metadata(): Metadata {
      live();
      return (metadataCache ??= wrapMetadata(
        ctx,
        expectHandle('Metadata_hFromVectorField', ctx.raw.Metadata_hFromVectorField(ctx.lib, handle)),
      ));
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      metadataCache?.dispose();
      ctx.registry.unregister(field); // D2
      if (!ctx.dead.value) ctx.raw.VectorField_Destroy(ctx.lib, handle); // D4
    },
  };
  tagFieldClass(ctx, ctx.raw.Metadata_hFromVectorField, handle, 'VectorField'); // SG4
  recordProvenance(field, lane);
  adoptHandle(ctx, field, handle, ctx.raw.VectorField_Destroy);
  return field as VectorField; // adoptHandle added [Symbol.dispose] (D6)
}

/** SG10 guard used by session factories taking a `from` voxels. */
export function assertVoxelsOperand(ctx: SessionContext, voxels: Voxels, what: string): bigint {
  assertSameSession(ctx, voxels, what);
  return voxels.handle;
}
