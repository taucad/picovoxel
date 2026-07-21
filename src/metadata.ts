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
      return ctx.module.HEAPF32[ctx.scratch >> 2]!;
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
