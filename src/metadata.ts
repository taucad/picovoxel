// Field metadata table (SG3/SG4). The table rides inside the field's grid and is
// what survives .vdb interchange with desktop PicoGK; the handle here is only an
// accessor view onto it.

import {
  adoptHandle,
  checkedMalloc,
  expectHandle,
  readCString,
  withStrings,
  type SessionContext,
} from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import { EXACT_LANE_SET, parseLaneSet, UNKNOWN_LANE_MEMBER, type LaneSet } from './lanes.ts';
import type { Vec3 } from './types.ts';

export type MetadataType = 'string' | 'float' | 'vector' | 'unknown';
export type MetadataValue = string | number | Vec3;

export interface Metadata {
  /** Number of entries in the table. */
  readonly count: number;
  /** Every entry name, index order. */
  names(): string[];
  typeOf(name: string): MetadataType;
  /** Typed read; `undefined` when the name does not exist. */
  get(name: string): MetadataValue | undefined;
  /** SG3 — reserved names (`PicoGK.*`, `class`, `name`, `file_*`) throw. */
  set(name: string, value: MetadataValue): void;
  /** SG3 guard applies here too. */
  remove(name: string): void;
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed accessors. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * SG3 — upstream's GuardInternalFields (FieldMetadata.cs:349-364): Pico.* is
 * internal, class/name/file_* corrupt OpenVDB's own bookkeeping.
 */
export function assertWritableMetadataName(name: string): void {
  const lower = name.toLowerCase();
  const reason = lower.startsWith('picogk.')
    ? `'PicoGK.*' names are PicoGK-internal`
    : lower.startsWith('picovoxel.')
      ? `'PicoVoxel.*' names are picovoxel-internal (lane provenance)`
      : lower === 'class' || lower === 'name'
        ? `'class' and 'name' are OpenVDB-internal`
        : lower.startsWith('file_')
          ? `'file_*' names are OpenVDB-internal`
          : null;
  if (reason) {
    throw new PicoError('PICO_RESERVED_METADATA', `Cannot set metadata '${name}': ${reason}. Choose another name.`);
  }
}

const TYPE_NAMES: Record<number, MetadataType> = { 0: 'string', 1: 'float', 2: 'vector' };

/**
 * SG4 — every field-creating path tags `PicoGK.Class` so .vdb files interchange
 * with desktop PicoGK. Bypasses the SG3 guard exactly as C#'s internal _SetValue
 * does. The accessor handle is transient — the tag lives on the grid.
 */
export function tagFieldClass(
  ctx: SessionContext,
  metaFrom: (lib: bigint, field: bigint) => bigint,
  fieldHandle: bigint,
  className: 'Voxels' | 'ScalarField' | 'VectorField',
): void {
  const meta = expectHandle('Metadata_hFrom*', metaFrom(ctx.lib, fieldHandle));
  try {
    withStrings(ctx, ['PicoGK.Class', className], (namePtr, valuePtr) =>
      ctx.raw.Metadata_SetStringValue(ctx.lib, meta, namePtr, valuePtr),
    );
  } finally {
    ctx.raw.Metadata_Destroy(ctx.lib, meta);
  }
}

/**
 * SKv2-0 V0.5 — lane provenance (§14.1). The tag rides the field's grid like
 * `PicoGK.Class` does, so it survives copies, `.vdb` interchange and container
 * round-trips with no serializer changes. Absence of the tag IS the exact/L0
 * claim, which keeps every byte-locked exact fixture untouched. Bypasses the
 * SG3-style guard exactly as `tagFieldClass` does (users cannot write
 * `PicoVoxel.*` — provenance must not be forgeable through the public surface).
 *
 * The value is a lane SET in the persisted grammar of `./lanes.ts` (LANES
 * item 4): loads never rewrite it, derived handles carry the union of their
 * inputs' members.
 */
export const LANE_METADATA_NAME = 'PicoVoxel.Lane';

// Every live handle's provenance set, keyed by its wrapper object — the
// public `.lane` is the collapsed enum, and derivations need the full set.
const provenance = new WeakMap<object, LaneSet>();

export function recordProvenance(handle: object, set: LaneSet): void {
  provenance.set(handle, set);
}

/**
 * The provenance set of a Voxels/Mesh/ScalarField/VectorField wrapper. Other
 * same-session wrappers (Lattice, PolyLine, VdbFile) pass `assertSameSession`
 * but carry no value provenance: they are refused here, before any native call.
 */
export function provenanceOf(handle: object): LaneSet {
  const set = provenance.get(handle);
  if (set === undefined) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      'Expected a Voxels, Mesh, ScalarField or VectorField operand — this wrapper carries no geometry provenance.',
    );
  }
  return set;
}

/**
 * Writes a non-empty provenance set onto a field's grid in canonical form.
 * Removes any inherited entry first: OpenVDB refuses to overwrite metadata
 * with a value of another type (a copy of a float-tagged foreign grid).
 */
export function writeLaneTag(
  ctx: SessionContext,
  metaFrom: (lib: bigint, field: bigint) => bigint,
  fieldHandle: bigint,
  set: LaneSet,
): void {
  const meta = expectHandle('Metadata_hFrom*', metaFrom(ctx.lib, fieldHandle));
  try {
    withStrings(ctx, [LANE_METADATA_NAME, set.join(',')], (namePtr, valuePtr) => {
      ctx.raw.MetaData_RemoveValue(ctx.lib, meta, namePtr);
      ctx.raw.Metadata_SetStringValue(ctx.lib, meta, namePtr, valuePtr);
    });
  } finally {
    ctx.raw.Metadata_Destroy(ctx.lib, meta);
  }
}

/**
 * Reads the persisted lane tag off a field's grid by VALUE (LANES defect 1 —
 * it used to test presence only, collapsing unknown strings to `'fast'` and
 * float-typed tags to `'exact'`). `null` = untagged. The ABI's type query
 * reports absence and exotic foreign types (int, double) alike, so those read
 * as untagged.
 * ponytail: distinguishing them needs a names() scan per load; add it when a
 * foreign writer is seen emitting a non-string/float/vector PicoVoxel.Lane.
 */
export function readLaneTag(
  ctx: SessionContext,
  metaFrom: (lib: bigint, field: bigint) => bigint,
  fieldHandle: bigint,
): LaneSet | null {
  const meta = expectHandle('Metadata_hFrom*', metaFrom(ctx.lib, fieldHandle));
  try {
    const type = TYPE_NAMES[withStrings(ctx, [LANE_METADATA_NAME], (n) => ctx.raw.Metadata_nTypeAt(ctx.lib, meta, n))];
    if (type === undefined) return null;
    if (type !== 'string') return [UNKNOWN_LANE_MEMBER]; // float/vector: not our format, fast-like
    const length = withStrings(ctx, [LANE_METADATA_NAME], (n) => ctx.raw.Metadata_nStringLengthAt(ctx.lib, meta, n)) + 1;
    const buffer = checkedMalloc(ctx.module, length, 'a metadata string buffer');
    try {
      withStrings(ctx, [LANE_METADATA_NAME], (n) => ctx.raw.Metadata_bGetStringAt(ctx.lib, meta, n, buffer, length));
      return parseLaneSet(readCString(ctx, buffer));
    } finally {
      ctx.module._free(buffer);
    }
  } finally {
    ctx.raw.Metadata_Destroy(ctx.lib, meta);
  }
}

/**
 * LANES defect 5 — the ingest lock. Importing fast-provenance content into a
 * `lane: 'exact'` session throws: the session claims no Class-2 op fed
 * anything in it, and a fast import falsifies that. No override exists (an
 * escape hatch would create exactly the handle the claim rules out).
 */
export function rejectLaneIngest(ctx: SessionContext, set: LaneSet, where: string): void {
  if (ctx.lane === 'exact' && set.length > 0) {
    throw new PicoError(
      'PICO_LANE_LOOSENED',
      `${where}: this asset carries non-exact provenance (${LANE_METADATA_NAME}=${set.join(',')}), and importing it ` +
        "into a lane: 'exact' session would falsify the session's claim that no Class-2 op fed anything in it. " +
        "Load it in an 'open' session (omit lane) or a lane: 'fast' session instead.",
    );
  }
}

/**
 * Settles a field wrapper's provenance. `given` = a derivation: the set is
 * explicit, and a non-empty one is written onto the grid so it rides copies
 * and `.vdb` bytes (fresh creations pass `[]` and skip the read entirely).
 * `undefined` = a load from `.vdb` bytes: the persisted tag is authoritative
 * and is NEVER rewritten (foreign tags pass through untouched; untagged stays
 * untagged), and the ingest lock applies — on refusal the handle is freed.
 */
export function settleProvenance(
  ctx: SessionContext,
  metaFrom: (lib: bigint, field: bigint) => bigint,
  fieldHandle: bigint,
  given: LaneSet | undefined,
  destroy: (lib: bigint, field: bigint) => void,
  where: string,
): LaneSet {
  if (given !== undefined) {
    if (given.length > 0) writeLaneTag(ctx, metaFrom, fieldHandle, given);
    return given;
  }
  const persisted = readLaneTag(ctx, metaFrom, fieldHandle) ?? EXACT_LANE_SET;
  try {
    rejectLaneIngest(ctx, persisted, where);
  } catch (error) {
    destroy(ctx.lib, fieldHandle);
    throw error;
  }
  return persisted;
}

export function wrapMetadata(ctx: SessionContext, handle: bigint): Metadata {
  let disposed = false;
  const live = () => {
    assertLive(disposed, 'Metadata');
    return handle;
  };

  // Note: the try-style bGet*At duals cannot fail once nTypeAt confirmed the type —
  // single-threaded, no removal can interleave — so their results are not branched on.
  const readValue = (name: string): MetadataValue | undefined => {
    const type = TYPE_NAMES[withStrings(ctx, [name], (n) => ctx.raw.Metadata_nTypeAt(ctx.lib, handle, n))];
    if (type === 'string') {
      const length = withStrings(ctx, [name], (n) => ctx.raw.Metadata_nStringLengthAt(ctx.lib, handle, n)) + 1;
      const buffer = checkedMalloc(ctx.module, length, 'a metadata string buffer');
      try {
        withStrings(ctx, [name], (n) => ctx.raw.Metadata_bGetStringAt(ctx.lib, handle, n, buffer, length));
        return readCString(ctx, buffer);
      } finally {
        ctx.module._free(buffer);
      }
    }
    if (type === 'float') {
      withStrings(ctx, [name], (n) => ctx.raw.Metadata_bGetFloatAt(ctx.lib, handle, n, ctx.scratch));
      return ctx.module.HEAPF32[ctx.scratch >>> 2]!;
    }
    if (type === 'vector') {
      withStrings(ctx, [name], (n) => ctx.raw.Metadata_bGetVectorAt(ctx.lib, handle, n, ctx.scratch));
      return ctx.readVec3(ctx.scratch);
    }
    return undefined;
  };

  const metadata = {
    get count() {
      return guard('Metadata_nCount', () => ctx.raw.Metadata_nCount(ctx.lib, live()))();
    },
    names() {
      const count = metadata.count;
      const result: string[] = [];
      for (let i = 0; i < count; i++) {
        const length = ctx.raw.Metadata_nNameLengthAt(ctx.lib, handle, i) + 1;
        const buffer = checkedMalloc(ctx.module, length, 'a metadata string buffer');
        try {
          ctx.raw.Metadata_bGetNameAt(ctx.lib, handle, i, buffer, length); // i < count: cannot fail
          result.push(readCString(ctx, buffer));
        } finally {
          ctx.module._free(buffer);
        }
      }
      return result;
    },
    typeOf(name: string): MetadataType {
      live();
      return TYPE_NAMES[withStrings(ctx, [name], (n) => ctx.raw.Metadata_nTypeAt(ctx.lib, handle, n))] ?? 'unknown';
    },
    get(name: string) {
      live();
      return readValue(name);
    },
    set(name: string, value: MetadataValue) {
      live();
      assertWritableMetadataName(name);
      if (typeof value === 'string') {
        withStrings(ctx, [name, value], (n, v) => ctx.raw.Metadata_SetStringValue(ctx.lib, handle, n, v));
      } else if (typeof value === 'number') {
        withStrings(ctx, [name], (n) => ctx.raw.Metadata_SetFloatValue(ctx.lib, handle, n, value));
      } else if (Array.isArray(value) && value.length === 3) {
        ctx.writeVec3(ctx.scratch, value as Vec3);
        withStrings(ctx, [name], (n) => ctx.raw.Metadata_SetVectorValue(ctx.lib, handle, n, ctx.scratch));
      } else {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          `Metadata values are strings, numbers, or [x, y, z] vectors — got ${typeof value}.`,
        );
      }
    },
    remove(name: string) {
      live();
      assertWritableMetadataName(name);
      // Capital D is upstream's header typo — the export really is MetaData_RemoveValue.
      withStrings(ctx, [name], (n) => ctx.raw.MetaData_RemoveValue(ctx.lib, handle, n));
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.registry.unregister(metadata); // D2
      if (!ctx.dead.value) ctx.raw.Metadata_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, metadata, handle, ctx.raw.Metadata_Destroy);
  return metadata as Metadata; // adoptHandle added [Symbol.dispose] (D6)
}
