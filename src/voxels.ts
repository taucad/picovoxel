// Voxels wrapper — the heart of the surface.
//
// PicoGK's booleans and offsets mutate the receiver in the ABI (SG11) — every
// derived op copies first via Voxels_hCreateCopy so the fluent form is pure and
// `a.subtract(b)` never silently destroys `a`. Two soundness rules ride along:
// emptiness is `isEmpty` (SG2 — a−a keeps ~5% narrow-band "volume"), and correct
// volume/bounds after booleans need the mesh round-trip (SG1 — OpenVDB retains
// distance-0 surface voxels).

import {
  adoptHandle,
  assertSameSession,
  expectHandle,
  VEC3_BYTES,
  withSdfPointer,
  type SessionContext,
} from './context.ts';
import { assertLive, guard, PicoGkError } from './errors.ts';
import { wrapScalarField, type ScalarField } from './fields.ts';
import type { Lattice } from './lattice.ts';
import { tagFieldClass, wrapMetadata, type Metadata } from './metadata.ts';
import { wrapMesh, type Mesh } from './mesh.ts';
import type { Bounds, SdfFunction, Vec3 } from './types.ts';

export type SliceAxis = 'x' | 'y' | 'z';
/** SG8 — modes are pure post-processing over the native narrow-band floats. */
export type SliceMode = 'sdf' | 'bw' | 'antialiased';

export interface VoxelSlice {
  width: number;
  height: number;
  /** Row-major samples. A fresh copy; the caller owns it. */
  data: Float32Array;
  /** The native background (outside-narrow-band) value of the raw sdf data. */
  background: number;
}

export type GetSliceOptions =
  | { index: number; axis?: SliceAxis; mode?: SliceMode }
  | { z: number; interpolated: true; mode?: SliceMode };

export interface ShellOptions {
  offset?: number;
  inner?: number;
  outer?: number;
  smoothInner?: number;
}

export interface Voxels {
  /** An independent copy of this field. */
  clone(): Voxels;
  /** Pure union; variadic form aggregates into one clone (perf ≙ C# voxBoolAddAll). */
  union(...others: Voxels[]): Voxels;
  /** Pure subtraction of every operand. */
  subtract(...others: Voxels[]): Voxels;
  /** Pure intersection. */
  intersect(other: Voxels): Voxels;
  /** Content equality (SG10-guarded). */
  equals(other: Voxels): boolean;
  /** SG2 — THE emptiness oracle. Never test volume ≈ 0. */
  readonly isEmpty: boolean;
  /** Pure surface offset: positive grows, negative shrinks. */
  offset(options: { distance: number }): Voxels;
  /** Two offsets in sequence (closing/opening when signs differ). */
  doubleOffset(options: { first: number; second: number }): Voxels;
  /** SG9 — in, 2× out, in again: strips detail below the distance threshold. */
  smoothen(options: { distance: number }): Voxels;
  /** SG9 — over-offset composition; fillet-like rounding (C# voxFillet). */
  fillet(options: { rounding: number; finalSurfaceDistance?: number }): Voxels;
  /** Shell: one-offset form ({offset}) or two-offset form ({inner, outer, smoothInner}). */
  shell(options: ShellOptions): Voxels;
  /** Everything outside the box is trimmed away (cube-mesh intersect, as C#). */
  trim(bounds: Bounds): Voxels;
  /** Projects the slice at startZ through endZ (mm). */
  projectZSlice(options: { startZ: number; endZ: number }): Voxels;
  /** Pure: clone + render the mesh into the clone. */
  withMesh(mesh: Mesh): Voxels;
  /** Pure: clone + render the lattice into the clone. */
  withLattice(lattice: Lattice): Voxels;
  /**
   * Pure: clone + render the SDF into the clone within bounds. Callback-only:
   * the parallel tape fill needs an empty target, so serialized SdfExpressions
   * go through `createVoxels({ shape: 'implicit' })` instead.
   */
  withImplicit(options: { sdf: SdfFunction; boundsMin: Vec3; boundsMax: Vec3 }): Voxels;
  /** The gyroid-in-sphere idiom: existing voxels re-evaluated under the SDF. */
  maskedByImplicit(options: { sdf: SdfFunction }): Voxels;
  /** Volume in mm³ from the raw grid — fast but approximate after booleans (SG1). */
  readonly volume: number;
  /** SG1 — the correct volume+bounds: mesh → fresh voxels round-trip. */
  properties(): { volume: number; bounds: Bounds };
  /** SG1 — bounding box via the intermediate mesh (the only accurate way). */
  bounds(): Bounds;
  /** True if the point is at or below the surface. */
  isInside(position: Vec3): boolean;
  /** Surface normal at a point on the surface (use after closest/raycast). */
  surfaceNormal(surfacePoint: Vec3): Vec3;
  /** Closest surface point, or null when the field is empty. */
  closestPointOnSurface(position: Vec3): Vec3 | null;
  /** Ray-surface intersection, or null on a miss. */
  raycastToSurface(position: Vec3, direction: Vec3): Vec3 | null;
  /** Field extent in discrete voxel units. */
  dimensions(): { origin: Vec3; size: Vec3 };
  /** Number of Z slices. */
  readonly sliceCount: number;
  /** Real-world origin of slice `index` in mm. */
  sliceOrigin(index?: number): Vec3;
  /** One slice image; SG8 modes; interpolated form takes a fractional Z index. */
  getSlice(options: GetSliceOptions): VoxelSlice;
  toMesh(): Mesh;
  toScalarField(): ScalarField;
  readonly metadata: Metadata;
  readonly memUsage: number;
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed voxels. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function wrapVoxels(ctx: SessionContext, handle: bigint): Voxels {
  let disposed = false;
  let metadataCache: Metadata | null = null;
  const live = () => {
    assertLive(disposed, 'Voxels');
    return handle;
  };

  /** Copy-first derivation (SG11): clone, mutate the clone, wrap the clone. */
  const derive = (name: string, mutate: (copy: bigint) => void): Voxels => {
    const copy = expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, live()));
    try {
      guard(name, mutate)(copy);
    } catch (error) {
      ctx.raw.Voxels_Destroy(ctx.lib, copy);
      throw error;
    }
    return wrapVoxels(ctx, copy);
  };

  const operandHandle = (other: Voxels, what: string): bigint => {
    assertSameSession(ctx, other, what);
    return other.handle;
  };

  const requireFinite = (value: number, field: string, where: string): number => {
    if (!Number.isFinite(value)) {
      throw new PicoGkError('PICOGK_INVALID_ARGUMENT', `${where} needs a finite ${field} in millimetres, got ${value}.`);
    }
    return value;
  };

  const dims = () => {
    const p = ctx.module._malloc(24);
    try {
      ctx.raw.Voxels_GetVoxelDimensions(ctx.lib, live(), p, p + 4, p + 8, p + 12, p + 16, p + 20);
      const i32 = (offset: number) => ctx.module.HEAP32[(p + offset) >> 2]!;
      return { origin: [i32(0), i32(4), i32(8)] as Vec3, size: [i32(12), i32(16), i32(20)] as Vec3 };
    } finally {
      ctx.module._free(p);
    }
  };

  /** SG1 — the mesh round-trip both properties() and bounds() are built on. */
  const meshRoundTrip = <T>(body: (meshHandle: bigint) => T): T => {
    const meshHandle = expectHandle('Mesh_hCreateFromVoxels', ctx.raw.Mesh_hCreateFromVoxels(ctx.lib, live()));
    try {
      return body(meshHandle);
    } finally {
      ctx.raw.Mesh_Destroy(ctx.lib, meshHandle);
    }
  };

  const readBoundsFrom = (meshHandle: bigint): Bounds => {
    ctx.raw.Mesh_GetBoundingBox(ctx.lib, meshHandle, ctx.scratch);
    return { min: ctx.readVec3(ctx.scratch), max: ctx.readVec3(ctx.scratch + VEC3_BYTES) };
  };

  const applyMode = (data: Float32Array, mode: SliceMode, background: number): void => {
    if (mode === 'bw') {
      for (let i = 0; i < data.length; i++) data[i] = data[i]! <= 0 ? 0 : 1;
    } else if (mode === 'antialiased') {
      for (let i = 0; i < data.length; i++) {
        const value = data[i]!;
        // Outside-band samples equal background exactly (never exceed it), so the
        // clamp arm is >=: identical output, honest reachability.
        data[i] = value <= 0 ? 0 : value >= background ? 1 : value / background;
      }
    }
  };

  const voxels = {
    clone: (): Voxels => wrapVoxels(ctx, expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, live()))),

    union: (...others: Voxels[]): Voxels =>
      derive('Voxels_BoolAdd', (copy) => {
        for (const other of others) ctx.raw.Voxels_BoolAdd(ctx.lib, copy, operandHandle(other, 'union operand'));
      }),
    subtract: (...others: Voxels[]): Voxels =>
      derive('Voxels_BoolSubtract', (copy) => {
        for (const other of others) ctx.raw.Voxels_BoolSubtract(ctx.lib, copy, operandHandle(other, 'subtract operand'));
      }),
    intersect: (other: Voxels): Voxels =>
      derive('Voxels_BoolIntersect', (copy) => ctx.raw.Voxels_BoolIntersect(ctx.lib, copy, operandHandle(other, 'intersect operand'))),

    equals(other: Voxels): boolean {
      return guard('Voxels_bIsEqual', () => ctx.raw.Voxels_bIsEqual(ctx.lib, live(), operandHandle(other, 'equals operand')))();
    },
    get isEmpty() {
      return guard('Voxels_bIsEmpty', () => ctx.raw.Voxels_bIsEmpty(ctx.lib, live()))();
    },

    offset(options: { distance: number }) {
      const distance = requireFinite(options.distance, 'distance', 'offset({ distance })');
      return derive('Voxels_Offset', (copy) => ctx.raw.Voxels_Offset(ctx.lib, copy, distance));
    },
    doubleOffset(options: { first: number; second: number }) {
      const first = requireFinite(options.first, 'first', 'doubleOffset');
      const second = requireFinite(options.second, 'second', 'doubleOffset');
      return derive('Voxels_DoubleOffset', (copy) => ctx.raw.Voxels_DoubleOffset(ctx.lib, copy, first, second));
    },
    smoothen(options: { distance: number }) {
      const distance = requireFinite(options.distance, 'distance', 'smoothen');
      return derive('Voxels_TripleOffset', (copy) => ctx.raw.Voxels_TripleOffset(ctx.lib, copy, distance));
    },
    fillet(options: { rounding: number; finalSurfaceDistance?: number }) {
      // C# voxOverOffset composition (Voxels.cs:613-621): DoubleOffset(r, −r + final).
      const rounding = requireFinite(options.rounding, 'rounding', 'fillet');
      const final = requireFinite(options.finalSurfaceDistance ?? 0, 'finalSurfaceDistance', 'fillet');
      return derive('Voxels_DoubleOffset', (copy) => ctx.raw.Voxels_DoubleOffset(ctx.lib, copy, rounding, -rounding + final));
    },
    shell(options: ShellOptions): Voxels {
      if (options.offset !== undefined) {
        // C# voxShell(float) (Voxels.cs:659-668): sign chooses which side keeps
        // the original dimensions.
        const distance = requireFinite(options.offset, 'offset', 'shell({ offset })');
        const moved = voxels.offset({ distance });
        const result = distance < 0 ? voxels.subtract(moved) : moved.subtract(voxels as Voxels);
        moved.dispose();
        return result;
      }
      if (options.inner === undefined || options.outer === undefined) {
        throw new PicoGkError(
          'PICOGK_INVALID_ARGUMENT',
          'shell() takes { offset } or { inner, outer, smoothInner? } — both offsets are required in the two-offset form.',
        );
      }
      // C# voxShell(neg, pos, smooth) (Voxels.cs:680-700) semantic port. Upstream
      // calls the COPY forms as if they mutated, so its smoothing and subtraction
      // are silently discarded (upstream bug B4, do-not-port) — this implements the
      // documented intent: outer offset minus (optionally smoothed) inner offset.
      let inner = requireFinite(options.inner, 'inner', 'shell');
      let outer = requireFinite(options.outer, 'outer', 'shell');
      const smoothInner = requireFinite(options.smoothInner ?? 0, 'smoothInner', 'shell');
      if (inner > outer) [inner, outer] = [outer, inner];
      let innerVoxels = voxels.offset({ distance: inner });
      if (smoothInner > 0) {
        const smoothed = innerVoxels.smoothen({ distance: smoothInner });
        innerVoxels.dispose();
        innerVoxels = smoothed;
      }
      const outerVoxels = voxels.offset({ distance: outer });
      const result = outerVoxels.subtract(innerVoxels);
      innerVoxels.dispose();
      outerVoxels.dispose();
      return result;
    },
    trim(bounds: Bounds): Voxels {
      // C# voxTrim (Voxels.cs:458-474): cube mesh over the box, then intersect.
      const cube = cubeVoxels(ctx, bounds);
      try {
        return derive('Voxels_BoolIntersect', (copy) => ctx.raw.Voxels_BoolIntersect(ctx.lib, copy, cube));
      } finally {
        ctx.raw.Voxels_Destroy(ctx.lib, cube);
      }
    },
    projectZSlice(options: { startZ: number; endZ: number }) {
      const startZ = requireFinite(options.startZ, 'startZ', 'projectZSlice');
      const endZ = requireFinite(options.endZ, 'endZ', 'projectZSlice');
      return derive('Voxels_ProjectZSlice', (copy) => ctx.raw.Voxels_ProjectZSlice(ctx.lib, copy, startZ, endZ));
    },

    withMesh(mesh: Mesh): Voxels {
      const meshHandle = (() => {
        assertSameSession(ctx, mesh, 'withMesh operand');
        return mesh.handle;
      })();
      return derive('Voxels_RenderMesh', (copy) => ctx.raw.Voxels_RenderMesh(ctx.lib, copy, meshHandle));
    },
    withLattice(lattice: Lattice): Voxels {
      assertSameSession(ctx, lattice, 'withLattice operand');
      const latticeHandle = lattice.handle;
      return derive('Voxels_RenderLattice', (copy) => ctx.raw.Voxels_RenderLattice(ctx.lib, copy, latticeHandle));
    },
    withImplicit({ sdf, boundsMin, boundsMax }: { sdf: SdfFunction; boundsMin: Vec3; boundsMax: Vec3 }): Voxels {
      return derive('Voxels_RenderImplicit', (copy) =>
        withSdfPointer(ctx, sdf, (sdfPointer) => {
          ctx.writeVec3(ctx.scratch, boundsMin);
          ctx.writeVec3(ctx.scratch + VEC3_BYTES, boundsMax);
          ctx.raw.Voxels_RenderImplicit(ctx.lib, copy, ctx.scratch, sdfPointer);
        }),
      );
    },
    maskedByImplicit({ sdf }: { sdf: SdfFunction }): Voxels {
      // C# voxIntersectImplicit (Voxels.cs:748-753) — the gyroid-sphere idiom.
      return derive('Voxels_IntersectImplicit', (copy) =>
        withSdfPointer(ctx, sdf, (sdfPointer) => ctx.raw.Voxels_IntersectImplicit(ctx.lib, copy, sdfPointer)),
      );
    },

    get volume() {
      return guard('Voxels_fCalculateVolume', () => ctx.raw.Voxels_fCalculateVolume(ctx.lib, live()))();
    },
    properties(): { volume: number; bounds: Bounds } {
      // C# CalculateProperties (Voxels.cs:812-825): mesh (skips distance-0 surface
      // voxels) -> fresh voxels -> volume of THAT; bounds from the mesh.
      return meshRoundTrip((meshHandle) => {
        const bounds = readBoundsFrom(meshHandle);
        const fresh = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
        try {
          ctx.raw.Voxels_RenderMesh(ctx.lib, fresh, meshHandle);
          return { volume: ctx.raw.Voxels_fCalculateVolume(ctx.lib, fresh), bounds };
        } finally {
          ctx.raw.Voxels_Destroy(ctx.lib, fresh);
        }
      });
    },
    bounds(): Bounds {
      return meshRoundTrip(readBoundsFrom);
    },

    isInside(position: Vec3): boolean {
      ctx.writeVec3(ctx.scratch, position);
      return guard('Voxels_bIsInside', () => ctx.raw.Voxels_bIsInside(ctx.lib, live(), ctx.scratch))();
    },
    surfaceNormal(surfacePoint: Vec3): Vec3 {
      ctx.writeVec3(ctx.scratch, surfacePoint);
      guard('Voxels_GetSurfaceNormal', () => ctx.raw.Voxels_GetSurfaceNormal(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES))();
      return ctx.readVec3(ctx.scratch + VEC3_BYTES);
    },
    closestPointOnSurface(position: Vec3): Vec3 | null {
      ctx.writeVec3(ctx.scratch, position);
      const found = guard('Voxels_bClosestPointOnSurface', () =>
        ctx.raw.Voxels_bClosestPointOnSurface(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES),
      )();
      return found ? ctx.readVec3(ctx.scratch + VEC3_BYTES) : null;
    },
    raycastToSurface(position: Vec3, direction: Vec3): Vec3 | null {
      ctx.writeVec3(ctx.scratch, position);
      ctx.writeVec3(ctx.scratch + VEC3_BYTES, direction);
      const hit = guard('Voxels_bRayCastToSurface', () =>
        ctx.raw.Voxels_bRayCastToSurface(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES, ctx.scratch + 2 * VEC3_BYTES),
      )();
      return hit ? ctx.readVec3(ctx.scratch + 2 * VEC3_BYTES) : null;
    },

    dimensions: () => dims(),
    get sliceCount() {
      return dims().size[2];
    },
    sliceOrigin(index = 0): Vec3 {
      const { origin } = dims();
      ctx.writeVec3(ctx.scratch, [origin[0], origin[1], origin[2] + index]);
      ctx.raw.Library_VoxelsToMm(ctx.lib, ctx.scratch, ctx.scratch + VEC3_BYTES);
      return ctx.readVec3(ctx.scratch + VEC3_BYTES);
    },
    getSlice(options: GetSliceOptions): VoxelSlice {
      const mode: SliceMode = options.mode ?? 'sdf';
      const { size } = dims();
      const interpolated = 'interpolated' in options;
      const axis: SliceAxis = interpolated ? 'z' : ((options as { axis?: SliceAxis }).axis ?? 'z');
      const [width, height] =
        axis === 'z' ? [size[0], size[1]] : axis === 'y' ? [size[0], size[2]] : [size[1], size[2]];
      const depth = axis === 'z' ? size[2] : axis === 'y' ? size[1] : size[0];

      const at = interpolated ? (options as { z: number }).z : (options as { index: number }).index;
      if (!Number.isFinite(at) || at < 0 || at >= depth || (!interpolated && !Number.isInteger(at))) {
        throw new PicoGkError(
          'PICOGK_INVALID_ARGUMENT',
          `getSlice ${interpolated ? 'z' : 'index'} ${at} out of range [0, ${depth})${interpolated ? '' : ' (integer)'} on axis ${axis}.`,
        );
      }

      const buffer = ctx.module._malloc(width * height * 4);
      const backgroundPtr = ctx.module._malloc(4);
      try {
        if (interpolated) {
          ctx.raw.Voxels_GetInterpolatedZSlice(ctx.lib, handle, at, buffer, backgroundPtr);
        } else if (axis === 'z') {
          ctx.raw.Voxels_GetZSlice(ctx.lib, handle, at, buffer, backgroundPtr);
        } else if (axis === 'y') {
          ctx.raw.Voxels_GetYSlice(ctx.lib, handle, at, buffer, backgroundPtr);
        } else {
          ctx.raw.Voxels_GetXSlice(ctx.lib, handle, at, buffer, backgroundPtr);
        }
        const background = ctx.module.HEAPF32[backgroundPtr >> 2]!;
        const data = new Float32Array(ctx.module.HEAPF32.subarray(buffer >> 2, (buffer >> 2) + width * height));
        applyMode(data, mode, background);
        return { width, height, data, background };
      } finally {
        ctx.module._free(buffer);
        ctx.module._free(backgroundPtr);
      }
    },

    toMesh(): Mesh {
      return wrapMesh(ctx, expectHandle('Mesh_hCreateFromVoxels', guard('Mesh_hCreateFromVoxels', () => ctx.raw.Mesh_hCreateFromVoxels(ctx.lib, live()))()));
    },
    toScalarField(): ScalarField {
      return wrapScalarField(
        ctx,
        expectHandle('ScalarField_hCreateFromVoxels', guard('ScalarField_hCreateFromVoxels', () => ctx.raw.ScalarField_hCreateFromVoxels(ctx.lib, live()))()),
      );
    },
    get metadata(): Metadata {
      live();
      return (metadataCache ??= wrapMetadata(ctx, expectHandle('Metadata_hFromVoxels', ctx.raw.Metadata_hFromVoxels(ctx.lib, handle))));
    },
    get memUsage() {
      return Number(guard('Voxels_nMemUsage', () => ctx.raw.Voxels_nMemUsage(ctx.lib, live()))());
    },

    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      metadataCache?.dispose();
      ctx.registry.unregister(voxels); // D2
      if (!ctx.dead.value) ctx.raw.Voxels_Destroy(ctx.lib, handle); // D4
    },
  };
  tagFieldClass(ctx, ctx.raw.Metadata_hFromVoxels, handle, 'Voxels'); // SG4
  adoptHandle(ctx, voxels, handle, ctx.raw.Voxels_Destroy);
  return voxels as Voxels; // adoptHandle added [Symbol.dispose] (D6)
}

/**
 * Voxelized axis-aligned box via a 12-triangle cube mesh (C# Utils.mshCreateCube),
 * the internal helper trim() is built on. Returns a raw handle the caller destroys.
 */
export function cubeVoxels(ctx: SessionContext, bounds: Bounds): bigint {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const corners: Vec3[] = [
    [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, minZ], [minX, maxY, maxZ],
    [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, minZ], [maxX, maxY, maxZ],
  ];
  // Faces exactly as Utils.mshCreateCube orders them.
  const faces = [
    [0, 1, 3], [0, 3, 2], // front (x-)
    [4, 6, 7], [4, 7, 5], // back (x+)
    [0, 2, 6], [0, 6, 4], // left
    [1, 5, 7], [1, 7, 3], // right
    [2, 3, 7], [2, 7, 6], // top
    [0, 4, 5], [0, 5, 1], // bottom
  ];
  const meshHandle = expectHandle('Mesh_hCreate', ctx.raw.Mesh_hCreate(ctx.lib));
  try {
    for (const corner of corners) {
      ctx.writeVec3(ctx.scratch, corner);
      ctx.raw.Mesh_nAddVertex(ctx.lib, meshHandle, ctx.scratch);
    }
    for (const [a, b, c] of faces) {
      ctx.module.HEAP32[(ctx.scratch >> 2) + 0] = a!;
      ctx.module.HEAP32[(ctx.scratch >> 2) + 1] = b!;
      ctx.module.HEAP32[(ctx.scratch >> 2) + 2] = c!;
      ctx.raw.Mesh_nAddTriangle(ctx.lib, meshHandle, ctx.scratch);
    }
    const target = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
    ctx.raw.Voxels_RenderMesh(ctx.lib, target, meshHandle);
    return target;
  } finally {
    ctx.raw.Mesh_Destroy(ctx.lib, meshHandle);
  }
}
