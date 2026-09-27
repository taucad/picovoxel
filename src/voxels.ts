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
  checkedMalloc,
  expectHandle,
  VEC3_BYTES,
  withSdfPointer,
  withSdfTape,
  type SessionContext,
} from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import { wrapScalarField, type ScalarField } from './fields.ts';
import { FAST_LANE_SET, laneOf, unionLaneSets, type LaneSet } from './lanes.ts';
import type { Lattice } from './lattice.ts';
import {
  provenanceOf,
  recordProvenance,
  settleProvenance,
  tagFieldClass,
  wrapMetadata,
  type Metadata,
} from './metadata.ts';
import { wrapMesh, type Mesh } from './mesh.ts';
import type { SdfExpression } from './tape.ts';
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
  /** SK-0.8 — see `offset({ fastRenorm })`; applies to every offset this shell runs. */
  fastRenorm?: boolean;
}

/**
 * The opt-in renormalization setting for the offset family: `FIRST_BIAS`
 * (first-order upwind) instead of the LevelSetTracker default `HJWENO5_BIAS`,
 * with upstream's sweep count of 3 kept.
 *
 * Measured on four offset fixtures (bench/results/webgpu-v2/sk-0.8-ab.json):
 * lowering the scheme order keeps |∇φ| inside [0.5, 1.5] per openvdb's
 * `tools::checkLevelSet` and is 3.5–3.9x faster; every sweep count below 3
 * broke that bound on some fixture. `Voxels_OffsetTuned` (raw subpath)
 * reaches both knobs.
 *
 * The library default is the untuned upstream call, pinned by the byte-locked
 * fixtures and test/voxels-offsets.test.ts. Precedence: explicit
 * per-op > session default (`createPico({ fastRenorm })`, set by the `'fast'`
 * lane) > library default false.
 */
const FAST_RENORM_SCHEME = 0; // openvdb::math::FIRST_BIAS (FiniteDifference.h:166)
const FAST_RENORM_COUNT = -1; // < 0 == leave upstream's normCount (LEVEL_SET_HALF_WIDTH = 3)

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
  /**
   * Pure surface offset: positive grows, negative shrinks.
   *
   * `fastRenorm` (SK-0.8, opt-in) runs the renormalization upstream performs after
   * every half-voxel CFL step with a first-order upwind gradient instead of 5th-order
   * HJ-WENO — 3.5–3.9x on the offset family, since renormalization is 94–97% of the
   * offset wall. It CHANGES THE OUTPUT (measured at ≤2.2% volume, ≤0.36 mm peak
   * narrow-band displacement, level set still clean; gate values and the full sweep in
   * bench/results/webgpu-v2/sk-0.8-ab.json), so it is never the library default —
   * a session may default it on (see `CreatePicoOptions.fastRenorm`), and an
   * explicit per-op value always wins.
   */
  offset(options: { distance: number; fastRenorm?: boolean }): Voxels;
  /** Two offsets in sequence (closing/opening when signs differ). */
  doubleOffset(options: { first: number; second: number; fastRenorm?: boolean }): Voxels;
  /** SG9 — in, 2× out, in again: strips detail below the distance threshold. */
  smoothen(options: { distance: number; fastRenorm?: boolean }): Voxels;
  /** SG9 — over-offset composition; fillet-like rounding (C# voxFillet). */
  fillet(options: { rounding: number; finalSurfaceDistance?: number; fastRenorm?: boolean }): Voxels;
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
   * Pure: clone + render the SDF into the clone within bounds. A JS callback
   * runs upstream's serial per-voxel loop; a serialized `SdfExpression` takes
   * the slab-parallel tape path. The two paths produce `equals()`-identical
   * grids with identical `properties()` and STL bytes; only the raw fast
   * `volume` approximation may differ between them (it integrates
   * representation bookkeeping the pruned fill legitimately omits).
   */
  withImplicit(options: { sdf: SdfFunction | SdfExpression; boundsMin: Vec3; boundsMax: Vec3 }): Voxels;
  /**
   * The gyroid-in-sphere idiom: existing voxels re-evaluated under the SDF.
   * Callback = serial upstream loop; `SdfExpression` = parallel tape path
   * — `equals()`-identical results, see `withImplicit` on the fast-volume caveat.
   */
  maskedByImplicit(options: { sdf: SdfFunction | SdfExpression }): Voxels;
  /** Volume in mm³ from the raw grid — fast but approximate after booleans (SG1). */
  readonly volume: number;
  /**
   * SG1 — the correct volume (mm³), surface area (mm²) and bounds, from one
   * native traversal of the mesh → fresh-voxels round-trip (src/pico-props.cpp).
   * Area is openvdb's `levelSetArea` over the same corrected grid; it costs no
   * extra meshing pass.
   */
  properties(): { volume: number; area: number; bounds: Bounds };
  /**
   * The G0 canonical grid hash: representation-normalized XXH3-128 over the level set's exact content
   * (src/pico-hash.cpp). Two grids hash equal iff they classify and value
   * every voxel identically — tile vs dense-leaf encodings of one field hash
   * equal. Index-space only: voxel size is pinned by the tuple's volume/counts.
   */
  gridHash(): { hash: string; activeVoxels: number; insideTiles: number; insideOffVoxels: number };
  /**
   * Oracle test tooling: rewrites the grid as fully dense leaves over its
   * active bounding box — same field, maximally different representation, so
   * `gridHash()` must not move while `memUsage` proves the tree changed.
   * O(bbox volume): small fixtures only.
   */
  densifyInterior(): void;
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
  /**
   * SKv2-0 V0.11 (P8) — N rays over ONE cached intersector and one ABI
   * crossing. Per-ray results are EXACTLY the serial `raycastToSurface`
   * semantics (incl. upstream's integer-voxel hit truncation). `hits` is
   * xyz-triples; entries where `hit[i] === 0` are undefined.
   */
  raycastBatch(options: { origins: ArrayLike<number>; directions: ArrayLike<number> }): {
    hits: Float32Array;
    hit: Uint8Array;
  };
  /**
   * SKv2-0 V0.11 (P8) — N closest-surface-point queries over one index
   * build (openvdb ClosestSurfacePoint): sub-voxel results, C2 by nature.
   * The SDF is its own oracle: |φ(query)| is the true distance.
   */
  closestPointsOnSurface(options: { points: ArrayLike<number> }): { points: Float32Array; found: Uint8Array };
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
  /**
   * §14.1 value-class provenance: least upper bound over this handle's
   * ancestry ('fast' = at least one Class-2 op — e.g. `fastRenorm` — fed it,
   * or it was loaded from bytes tagged with provenance this build treats as
   * fast-like). Persisted on the grid as the `PicoVoxel.Lane` member set, so
   * it survives copies and `.vdb` interchange. See `Mesh.toStl` for what the
   * export boundary does with it.
   */
  readonly lane: 'exact' | 'fast';
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed voxels. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Wraps a raw voxels handle. `provenance` is the lane set a creating or
 * deriving op establishes (`[]` for fresh geometry); omit it only for loads
 * from `.vdb` bytes, where the persisted tag is authoritative (see
 * `settleProvenance`: loads never rewrite the tag, and the exact-session
 * ingest lock applies).
 */
export function wrapVoxels(ctx: SessionContext, handle: bigint, provenance?: LaneSet): Voxels {
  let disposed = false;
  let metadataCache: Metadata | null = null;
  // §14.1 provenance — a non-empty set rides the grid as PicoVoxel.Lane, so it
  // survives copies and .vdb interchange with no serializer work.
  const lane = settleProvenance(
    ctx,
    ctx.raw.Metadata_hFromVoxels,
    handle,
    provenance,
    ctx.raw.Voxels_Destroy,
    'getVoxels',
  );
  const live = () => {
    assertLive(disposed, 'Voxels');
    return handle;
  };

  /** Copy-first derivation (SG11): clone, mutate the clone, wrap the clone. */
  const derive = (name: string, mutate: (copy: bigint) => void, resultLane: LaneSet = lane): Voxels => {
    const copy = expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, live()));
    try {
      guard(name, mutate)(copy);
    } catch (error) {
      ctx.raw.Voxels_Destroy(ctx.lib, copy);
      throw error;
    }
    return wrapVoxels(ctx, copy, resultLane);
  };

  /** §14.1 tighten-only: a Class-2 per-op request inside 'exact' throws. */
  const rejectLoosening = (fastRenorm: boolean | undefined, where: string): void => {
    if (ctx.lane === 'exact' && fastRenorm === true) {
      throw new PicoError(
        'PICO_LANE_LOOSENED',
        `${where}({ fastRenorm: true }) inside a lane: 'exact' session: one Class-2 op would destroy the ` +
          "session's structural exactness claim. Tightening is allowed; loosening requires a 'fast' or " +
          'lane-less session.',
      );
    }
  };

  /**
   * SK-0.8 — one offset sequence under FAST_RENORM_*. Distances carry PicoGK's sign
   * (positive grows) and run on a single LevelSetFilter, exactly as the untuned
   * Offset/DoubleOffset/TripleOffset exports do. ctx.scratch is BBOX_BYTES = 6
   * floats, and the longest sequence in the family is 3.
   */
  const fastOffset = (distancesMM: number[]): Voxels =>
    derive(
      'Voxels_OffsetTuned',
      (copy) => {
        const base = ctx.scratch >>> 2;
        for (let i = 0; i < distancesMM.length; i++) ctx.module.HEAPF32[base + i] = distancesMM[i]!;
        ctx.raw.Voxels_OffsetTuned(
          ctx.lib,
          copy,
          ctx.scratch,
          distancesMM.length,
          FAST_RENORM_SCHEME,
          FAST_RENORM_COUNT,
        );
      },
      unionLaneSets(lane, FAST_LANE_SET), // the one Class-2 producer today — provenance taints here
    );

  const operandHandle = (other: Voxels, what: string): bigint => {
    assertSameSession(ctx, other, what);
    return other.handle;
  };

  /** V0.7 — pairwise chain over a csg*Copy export; intermediates die eagerly. */
  const composeCopy = (
    name: 'Voxels_hBoolAddCopy' | 'Voxels_hBoolSubtractCopy' | 'Voxels_hBoolIntersectCopy',
    what: string,
    others: Voxels[],
  ): Voxels => {
    const resultLane = unionLaneSets(lane, ...others.map(provenanceOf)); // refuses non-geometry operands up front
    let current = live();
    let owned = false; // the receiver is never ours to destroy
    try {
      for (const other of others) {
        const next = expectHandle(
          name,
          guard(name, () => ctx.raw[name](ctx.lib, current, operandHandle(other, what)))(),
        );
        if (owned) ctx.raw.Voxels_Destroy(ctx.lib, current);
        current = next;
        owned = true;
      }
      // Zero operands: stay pure — hand back an independent copy, as before.
      if (!owned) current = expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, current));
      return wrapVoxels(ctx, current, resultLane);
    } catch (error) {
      if (owned) ctx.raw.Voxels_Destroy(ctx.lib, current);
      throw error;
    }
  };

  const requireFinite = (value: number, field: string, where: string): number => {
    if (!Number.isFinite(value)) {
      throw new PicoError(
        'PICO_INVALID_ARGUMENT',
        `${where} needs a finite ${field} in millimetres, got ${value}.`,
      );
    }
    return value;
  };

  const dims = () => {
    const p = checkedMalloc(ctx.module, 24, 'a dimensions scratch buffer');
    try {
      ctx.raw.Voxels_GetVoxelDimensions(ctx.lib, live(), p, p + 4, p + 8, p + 12, p + 16, p + 20);
      const i32 = (offset: number) => ctx.module.HEAP32[(p + offset) >>> 2]!;
      return { origin: [i32(0), i32(4), i32(8)] as Vec3, size: [i32(12), i32(16), i32(20)] as Vec3 };
    } finally {
      ctx.module._free(p);
    }
  };

  /** SG1 — the mesh round-trip both properties() and bounds() are built on. */
  const meshRoundTrip = <T>(body: (meshHandle: bigint) => T): T => {
    const meshHandle = expectHandle(
      'Mesh_hCreateFromVoxels',
      ctx.raw.Mesh_hCreateFromVoxels(ctx.lib, live()),
    );
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
    clone: (): Voxels =>
      wrapVoxels(ctx, expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, live())), lane),

    // SKv2-0 V0.7 — booleans ride the shared-nothing csg*Copy exports: const
    // inputs, exactly ONE fresh grid per pair (the old shape paid a receiver
    // copy in derive() plus upstream's operand deep copy). Variadic forms
    // chain pairwise, destroying intermediates immediately; the mutating
    // exports remain on the raw subpath.
    union: (...others: Voxels[]): Voxels => composeCopy('Voxels_hBoolAddCopy', 'union operand', others),
    subtract: (...others: Voxels[]): Voxels =>
      composeCopy('Voxels_hBoolSubtractCopy', 'subtract operand', others),
    intersect: (other: Voxels): Voxels =>
      composeCopy('Voxels_hBoolIntersectCopy', 'intersect operand', [other]),

    equals(other: Voxels): boolean {
      // T11 (SKv2-0 V0.8): O(stored) sign-set comparison, upstream-verdict-
      // identical; the dense O(bbox³) Voxels_bIsEqual stays on the raw subpath.
      return guard('Voxels_bIsEqualFast', () =>
        ctx.raw.Voxels_bIsEqualFast(ctx.lib, live(), operandHandle(other, 'equals operand')),
      )();
    },
    get isEmpty() {
      return guard('Voxels_bIsEmpty', () => ctx.raw.Voxels_bIsEmpty(ctx.lib, live()))();
    },

    offset(options: { distance: number; fastRenorm?: boolean }) {
      rejectLoosening(options.fastRenorm, 'offset');
      const distance = requireFinite(options.distance, 'distance', 'offset({ distance })');
      if (options.fastRenorm ?? ctx.fastRenorm) return fastOffset([distance]);
      return derive('Voxels_Offset', (copy) => ctx.raw.Voxels_Offset(ctx.lib, copy, distance));
    },
    doubleOffset(options: { first: number; second: number; fastRenorm?: boolean }) {
      rejectLoosening(options.fastRenorm, 'doubleOffset');
      const first = requireFinite(options.first, 'first', 'doubleOffset');
      const second = requireFinite(options.second, 'second', 'doubleOffset');
      if (options.fastRenorm ?? ctx.fastRenorm) return fastOffset([first, second]);
      return derive('Voxels_DoubleOffset', (copy) =>
        ctx.raw.Voxels_DoubleOffset(ctx.lib, copy, first, second),
      );
    },
    smoothen(options: { distance: number; fastRenorm?: boolean }) {
      rejectLoosening(options.fastRenorm, 'smoothen');
      const distance = requireFinite(options.distance, 'distance', 'smoothen');
      // TripleOffset is grow d / shrink 2d / grow d on one filter (PicoGKVdbVoxels.h:310-330).
      if (options.fastRenorm ?? ctx.fastRenorm) return fastOffset([distance, -2 * distance, distance]);
      return derive('Voxels_TripleOffset', (copy) => ctx.raw.Voxels_TripleOffset(ctx.lib, copy, distance));
    },
    fillet(options: { rounding: number; finalSurfaceDistance?: number; fastRenorm?: boolean }) {
      rejectLoosening(options.fastRenorm, 'fillet');
      // C# voxOverOffset composition (Voxels.cs:613-621): DoubleOffset(r, −r + final).
      const rounding = requireFinite(options.rounding, 'rounding', 'fillet');
      const final = requireFinite(options.finalSurfaceDistance ?? 0, 'finalSurfaceDistance', 'fillet');
      if (options.fastRenorm ?? ctx.fastRenorm) return fastOffset([rounding, -rounding + final]);
      return derive('Voxels_DoubleOffset', (copy) =>
        ctx.raw.Voxels_DoubleOffset(ctx.lib, copy, rounding, -rounding + final),
      );
    },
    shell(options: ShellOptions): Voxels {
      rejectLoosening(options.fastRenorm, 'shell');
      const fastRenorm = options.fastRenorm;
      if (options.offset !== undefined) {
        // C# voxShell(float) (Voxels.cs:659-668): sign chooses which side keeps
        // the original dimensions.
        const distance = requireFinite(options.offset, 'offset', 'shell({ offset })');
        const moved = voxels.offset({ distance, fastRenorm });
        const result = distance < 0 ? voxels.subtract(moved) : moved.subtract(voxels as Voxels);
        moved.dispose();
        return result;
      }
      if (options.inner === undefined || options.outer === undefined) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
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
      let innerVoxels = voxels.offset({ distance: inner, fastRenorm });
      if (smoothInner > 0) {
        const smoothed = innerVoxels.smoothen({ distance: smoothInner, fastRenorm });
        innerVoxels.dispose();
        innerVoxels = smoothed;
      }
      const outerVoxels = voxels.offset({ distance: outer, fastRenorm });
      const result = outerVoxels.subtract(innerVoxels);
      innerVoxels.dispose();
      outerVoxels.dispose();
      return result;
    },
    trim(bounds: Bounds): Voxels {
      // C# voxTrim (Voxels.cs:458-474): cube mesh over the box, then intersect
      // — on the V0.7 shared-nothing export like the rest of the boolean family.
      const cube = cubeVoxels(ctx, bounds);
      try {
        const result = expectHandle(
          'Voxels_hBoolIntersectCopy',
          guard('Voxels_hBoolIntersectCopy', () =>
            ctx.raw.Voxels_hBoolIntersectCopy(ctx.lib, live(), cube),
          )(),
        );
        return wrapVoxels(ctx, result, lane);
      } finally {
        ctx.raw.Voxels_Destroy(ctx.lib, cube);
      }
    },
    projectZSlice(options: { startZ: number; endZ: number }) {
      // SKv2-0 V0.9 — the T5×F15 column-culled export with the U2 voxel-unit
      // seal count; upstream's dense mutating export stays on the raw subpath
      // as the differential oracle. At 1.0 mm the seal counts coincide, so
      // 1.0 mm pins are byte-identical; other scales seal CORRECTLY now (the
      // pre-fix geometry was wrong — pins regenerated per the SK-0.4
      // protocol with this cause named).
      const startZ = requireFinite(options.startZ, 'startZ', 'projectZSlice');
      const endZ = requireFinite(options.endZ, 'endZ', 'projectZSlice');
      return derive('Voxels_ProjectZSliceFast', (copy) =>
        ctx.raw.Voxels_ProjectZSliceFast(ctx.lib, copy, startZ, endZ),
      );
    },

    withMesh(mesh: Mesh): Voxels {
      const meshHandle = (() => {
        assertSameSession(ctx, mesh, 'withMesh operand');
        return mesh.handle;
      })();
      return derive(
        'Voxels_RenderMesh',
        (copy) => ctx.raw.Voxels_RenderMesh(ctx.lib, copy, meshHandle),
        unionLaneSets(lane, provenanceOf(mesh)),
      );
    },
    withLattice(lattice: Lattice): Voxels {
      assertSameSession(ctx, lattice, 'withLattice operand');
      const latticeHandle = lattice.handle;
      const renderLattice = ctx.renderLatticeExport;
      return derive(renderLattice, (copy) => ctx.raw[renderLattice](ctx.lib, copy, latticeHandle));
    },
    withImplicit({
      sdf,
      boundsMin,
      boundsMax,
    }: {
      sdf: SdfFunction | SdfExpression;
      boundsMin: Vec3;
      boundsMax: Vec3;
    }): Voxels {
      if (typeof sdf === 'function') {
        return derive('Voxels_RenderImplicit', (copy) =>
          withSdfPointer(ctx, sdf, (sdfPointer) => {
            ctx.writeVec3(ctx.scratch, boundsMin);
            ctx.writeVec3(ctx.scratch + VEC3_BYTES, boundsMax);
            ctx.raw.Voxels_RenderImplicit(ctx.lib, copy, ctx.scratch, sdfPointer);
          }),
        );
      }
      // R9 — compose-into-existing tape path: min(sdf, existing) with upstream
      // semantics, slab-parallel (src/pico-tape.cpp ParallelTapeComposeGrid).
      return derive('Voxels_RenderImplicitTapeCompose', (copy) =>
        withSdfTape(ctx, sdf, (instrPtr, instrCount, constPtr, constCount) => {
          ctx.writeVec3(ctx.scratch, boundsMin);
          ctx.writeVec3(ctx.scratch + VEC3_BYTES, boundsMax);
          ctx.raw.Voxels_RenderImplicitTapeCompose(
            ctx.lib,
            copy,
            ctx.scratch,
            instrPtr,
            instrCount,
            constPtr,
            constCount,
          );
        }),
      );
    },
    maskedByImplicit({ sdf }: { sdf: SdfFunction | SdfExpression }): Voxels {
      // C# voxIntersectImplicit (Voxels.cs:748-753) — the gyroid-sphere idiom.
      // SKv2-0 V0.10 — both paths ride the U1-corrected, F17 support-
      // restricted exports (fresh band = background/voxelSize voxels; the
      // truncated-band originals stay raw-side as oracles). At 1.0 mm the
      // corrected band coincides with upstream's truncation, so 1.0 mm pins
      // hold; finer scales gain the correct narrow band (<1/3 mm was broken).
      if (typeof sdf === 'function') {
        return derive('Voxels_IntersectImplicitFast', (copy) =>
          withSdfPointer(ctx, sdf, (sdfPointer) =>
            ctx.raw.Voxels_IntersectImplicitFast(ctx.lib, copy, sdfPointer),
          ),
        );
      }
      return derive('Voxels_IntersectImplicitTapeFast', (copy) =>
        withSdfTape(ctx, sdf, (instrPtr, instrCount, constPtr, constCount) =>
          ctx.raw.Voxels_IntersectImplicitTapeFast(ctx.lib, copy, instrPtr, instrCount, constPtr, constCount),
        ),
      );
    },

    get volume() {
      return guard('Voxels_fCalculateVolume', () => ctx.raw.Voxels_fCalculateVolume(ctx.lib, live()))();
    },
    properties(): { volume: number; area: number; bounds: Bounds } {
      // C# CalculateProperties (Voxels.cs:812-825): mesh (skips distance-0 surface
      // voxels) -> fresh voxels -> volume of THAT; bounds from the mesh. SK-0.5
      // moved the whole sequence in-module (src/pico-props.cpp) — same floats, one
      // crossing instead of four, and area comes along for free.
      const floats = ctx.scratch;
      const box = ctx.scratch + 8;
      guard('Voxels_GetProperties', () =>
        ctx.raw.Voxels_GetProperties(ctx.lib, live(), floats, floats + 4, box),
      )();
      return {
        volume: ctx.module.HEAPF32[floats >>> 2]!,
        area: ctx.module.HEAPF32[(floats + 4) >>> 2]!,
        bounds: { min: ctx.readVec3(box), max: ctx.readVec3(box + VEC3_BYTES) },
      };
    },
    gridHash(): { hash: string; activeVoxels: number; insideTiles: number; insideOffVoxels: number } {
      // 16-byte digest, then three u64 counts — 40 bytes, inside the 255-byte
      // scratch; scratch is malloc-aligned so the u64 slots at +16 stay 8-aligned.
      const hashAt = ctx.scratch;
      const countsAt = ctx.scratch + 16;
      guard('Voxels_GetGridHash', () =>
        ctx.raw.Voxels_GetGridHash(ctx.lib, live(), hashAt, countsAt, countsAt + 8, countsAt + 16),
      )();
      let hash = '';
      for (let i = 0; i < 4; i++) {
        const word = ctx.module.HEAPU32[(hashAt + 4 * i) >>> 2]!;
        for (let b = 0; b < 4; b++) hash += ((word >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
      }
      // Counts are exact below 2^53 — a wasm32/wasm64 grid cannot reach that.
      const u64 = (at: number) =>
        ctx.module.HEAPU32[at >>> 2]! + ctx.module.HEAPU32[(at + 4) >>> 2]! * 2 ** 32;
      return {
        hash,
        activeVoxels: u64(countsAt),
        insideTiles: u64(countsAt + 8),
        insideOffVoxels: u64(countsAt + 16),
      };
    },
    densifyInterior(): void {
      guard('Voxels_DensifyInterior', () => ctx.raw.Voxels_DensifyInterior(ctx.lib, live()))();
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
      guard('Voxels_GetSurfaceNormal', () =>
        ctx.raw.Voxels_GetSurfaceNormal(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES),
      )();
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
        ctx.raw.Voxels_bRayCastToSurface(
          ctx.lib,
          live(),
          ctx.scratch,
          ctx.scratch + VEC3_BYTES,
          ctx.scratch + 2 * VEC3_BYTES,
        ),
      )();
      return hit ? ctx.readVec3(ctx.scratch + 2 * VEC3_BYTES) : null;
    },
    raycastBatch({ origins, directions }: { origins: ArrayLike<number>; directions: ArrayLike<number> }): {
      hits: Float32Array;
      hit: Uint8Array;
    } {
      live();
      const count = origins.length / 3;
      if (!Number.isInteger(count) || directions.length !== origins.length) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          `raycastBatch needs matching xyz-triple arrays; got ${origins.length}/${directions.length} floats.`,
        );
      }
      const bytes = count * VEC3_BYTES;
      const pointer = checkedMalloc(ctx.module, 2 * bytes + bytes + count, 'a raycast batch buffer');
      try {
        ctx.module.HEAPF32.set(origins, pointer >>> 2);
        ctx.module.HEAPF32.set(directions, (pointer + bytes) >>> 2);
        guard('Voxels_RayCastBatch', () =>
          ctx.raw.Voxels_RayCastBatch(
            ctx.lib,
            handle,
            pointer,
            pointer + bytes,
            count,
            pointer + 2 * bytes,
            pointer + 3 * bytes,
          ),
        )();
        const hits = new Float32Array(
          ctx.module.HEAPF32.subarray((pointer + 2 * bytes) >>> 2, ((pointer + 2 * bytes) >>> 2) + count * 3),
        );
        const hit = new Uint8Array(
          ctx.module.HEAPU8.subarray((pointer + 3 * bytes) >>> 0, ((pointer + 3 * bytes) >>> 0) + count),
        );
        return { hits, hit };
      } finally {
        ctx.module._free(pointer);
      }
    },
    closestPointsOnSurface({ points }: { points: ArrayLike<number> }): {
      points: Float32Array;
      found: Uint8Array;
    } {
      live();
      const count = points.length / 3;
      if (!Number.isInteger(count)) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          `closestPointsOnSurface needs xyz triples; got ${points.length} floats.`,
        );
      }
      const bytes = count * VEC3_BYTES;
      const pointer = checkedMalloc(ctx.module, 2 * bytes + count, 'a closest-point batch buffer');
      try {
        ctx.module.HEAPF32.set(points, pointer >>> 2);
        guard('Voxels_ClosestPointBatch', () =>
          ctx.raw.Voxels_ClosestPointBatch(
            ctx.lib,
            handle,
            pointer,
            count,
            pointer + bytes,
            pointer + 2 * bytes,
          ),
        )();
        const out = new Float32Array(
          ctx.module.HEAPF32.subarray((pointer + bytes) >>> 2, ((pointer + bytes) >>> 2) + count * 3),
        );
        const found = new Uint8Array(
          ctx.module.HEAPU8.subarray((pointer + 2 * bytes) >>> 0, ((pointer + 2 * bytes) >>> 0) + count),
        );
        return { points: out, found };
      } finally {
        ctx.module._free(pointer);
      }
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
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          `getSlice ${interpolated ? 'z' : 'index'} ${at} out of range [0, ${depth})${interpolated ? '' : ' (integer)'} on axis ${axis}.`,
        );
      }

      const buffer = checkedMalloc(ctx.module, width * height * 4, 'a slice image buffer');
      const backgroundPtr = checkedMalloc(ctx.module, 4, 'the slice background value');
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
        const background = ctx.module.HEAPF32[backgroundPtr >>> 2]!;
        const data = new Float32Array(
          ctx.module.HEAPF32.subarray(buffer >>> 2, (buffer >>> 2) + width * height),
        );
        applyMode(data, mode, background);
        return { width, height, data, background };
      } finally {
        ctx.module._free(buffer);
        ctx.module._free(backgroundPtr);
      }
    },

    toMesh(): Mesh {
      return wrapMesh(
        ctx,
        expectHandle(
          'Mesh_hCreateFromVoxels',
          guard('Mesh_hCreateFromVoxels', () => ctx.raw.Mesh_hCreateFromVoxels(ctx.lib, live()))(),
        ),
        lane,
      );
    },
    toScalarField(): ScalarField {
      return wrapScalarField(
        ctx,
        expectHandle(
          'ScalarField_hCreateFromVoxels',
          guard('ScalarField_hCreateFromVoxels', () =>
            ctx.raw.ScalarField_hCreateFromVoxels(ctx.lib, live()),
          )(),
        ),
        lane,
      );
    },
    get metadata(): Metadata {
      live();
      return (metadataCache ??= wrapMetadata(
        ctx,
        expectHandle('Metadata_hFromVoxels', ctx.raw.Metadata_hFromVoxels(ctx.lib, handle)),
      ));
    },
    get memUsage() {
      return Number(guard('Voxels_nMemUsage', () => ctx.raw.Voxels_nMemUsage(ctx.lib, live()))());
    },
    get lane() {
      return laneOf(lane);
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
  recordProvenance(voxels, lane);
  adoptHandle(ctx, voxels, handle, ctx.raw.Voxels_Destroy);
  return voxels as Voxels; // adoptHandle added [Symbol.dispose] (D6)
}

/**
 * Voxelized axis-aligned box via a 12-triangle cube mesh (C# Utils.mshCreateCube),
 * the internal helper trim() is built on. Returns a raw handle the caller destroys.
 */
function cubeVoxels(ctx: SessionContext, bounds: Bounds): bigint {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const corners: Vec3[] = [
    [minX, minY, minZ],
    [minX, minY, maxZ],
    [minX, maxY, minZ],
    [minX, maxY, maxZ],
    [maxX, minY, minZ],
    [maxX, minY, maxZ],
    [maxX, maxY, minZ],
    [maxX, maxY, maxZ],
  ];
  // Faces exactly as Utils.mshCreateCube orders them.
  const faces = [
    [0, 1, 3],
    [0, 3, 2], // front (x-)
    [4, 6, 7],
    [4, 7, 5], // back (x+)
    [0, 2, 6],
    [0, 6, 4], // left
    [1, 5, 7],
    [1, 7, 3], // right
    [2, 3, 7],
    [2, 7, 6], // top
    [0, 4, 5],
    [0, 5, 1], // bottom
  ];
  const meshHandle = expectHandle('Mesh_hCreate', ctx.raw.Mesh_hCreate(ctx.lib));
  try {
    for (const corner of corners) {
      ctx.writeVec3(ctx.scratch, corner);
      ctx.raw.Mesh_nAddVertex(ctx.lib, meshHandle, ctx.scratch);
    }
    for (const [a, b, c] of faces) {
      ctx.module.HEAP32[(ctx.scratch >>> 2) + 0] = a!;
      ctx.module.HEAP32[(ctx.scratch >>> 2) + 1] = b!;
      ctx.module.HEAP32[(ctx.scratch >>> 2) + 2] = c!;
      ctx.raw.Mesh_nAddTriangle(ctx.lib, meshHandle, ctx.scratch);
    }
    const target = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
    ctx.raw.Voxels_RenderMesh(ctx.lib, target, meshHandle);
    return target;
  } finally {
    ctx.raw.Mesh_Destroy(ctx.lib, meshHandle);
  }
}
