// OpenVDB container files (SG5). All IO is bytes-in/bytes-out over MEMFS temp
// files — no real filesystem paths cross the API. Field order inside a .vdb is NOT
// stable (upstream VoxelsIo.cs:48-52 documents this), which is why "first
// compatible field wins" is the documented loading semantic.

import { adoptHandle, assertSameSession, expectHandle, withStrings, readCString, type SessionContext } from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import { wrapScalarField, wrapVectorField, type ScalarField, type VectorField } from './fields.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

export type VdbFieldType = 'voxels' | 'scalarField' | 'vectorField' | 'unsupported';

const FIELD_TYPES: Record<number, VdbFieldType> = { 0: 'voxels', 1: 'scalarField', 2: 'vectorField' };

export interface VdbFile {
  readonly fieldCount: number;
  /** Name + type of every field, index order. */
  fields(): Array<{ name: string; type: VdbFieldType }>;
  /** Adds a field under `name`; returns its index. */
  add(field: Voxels | ScalarField | VectorField, name?: string): number;
  getVoxels(indexOrName: number | string): Voxels;
  getScalarField(indexOrName: number | string): ScalarField;
  getVectorField(indexOrName: number | string): VectorField;
  /** Serialises the container to .vdb bytes. */
  toBytes(): Uint8Array;
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed files. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

let temporaryCounter = 0;
/** A unique MEMFS scratch path per operation (sessions may interleave). */
export function temporaryVdbPath(): string {
  return `/pico-tmp-${++temporaryCounter}.vdb`;
}

/** Writes bytes into MEMFS, runs body on the path, always unlinks. */
export function withVdbBytes<T>(ctx: SessionContext, bytes: Uint8Array, body: (path: string) => T): T {
  const path = temporaryVdbPath();
  ctx.module.FS.writeFile(path, bytes);
  try {
    return body(path);
  } finally {
    ctx.module.FS.unlink(path);
  }
}

export function wrapVdbFile(ctx: SessionContext, handle: bigint): VdbFile {
  let disposed = false;
  const live = () => {
    assertLive(disposed, 'VdbFile');
    return handle;
  };

  /* v8 ignore next 2 -- the 'unsupported' arm needs a foreign grid class (e.g. FOG)
     this ABI cannot create; containers we can build only hold types 0/1/2 */
  const typeAt = (index: number): VdbFieldType => FIELD_TYPES[ctx.raw.VdbFile_nFieldType(ctx.lib, handle, index)] ?? 'unsupported';

  const nameAt = (index: number): string => {
    // GetFieldName fills a PKINFOSTRINGLEN buffer; scratch is sized for it.
    ctx.raw.VdbFile_GetFieldName(ctx.lib, handle, index, ctx.scratch);
    return readCString(ctx, ctx.scratch);
  };

  const resolveIndex = (indexOrName: number | string, wantType: VdbFieldType): number => {
    const count = vdb.fieldCount;
    let index: number;
    if (typeof indexOrName === 'number') {
      if (!Number.isInteger(indexOrName) || indexOrName < 0 || indexOrName >= count) {
        throw new PicoError('PICO_INVALID_ARGUMENT', `Field index ${indexOrName} out of range [0, ${count}).`);
      }
      index = indexOrName;
    } else {
      // Name lookup is a linear scan, exactly as C# does.
      index = -1;
      for (let i = 0; i < count; i++) {
        if (nameAt(i) === indexOrName) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          `No field named '${indexOrName}' in this .vdb (has: ${Array.from({ length: count }, (_, i) => nameAt(i)).join(', ') || 'none'}).`,
        );
      }
    }
    const actual = typeAt(index);
    if (actual !== wantType) {
      throw new PicoError(
        'PICO_INVALID_ARGUMENT',
        `Field ${typeof indexOrName === 'string' ? `'${indexOrName}'` : indexOrName} is a ${actual}, not a ${wantType}.`,
      );
    }
    return index;
  };

  const vdb = {
    get fieldCount() {
      return guard('VdbFile_nFieldCount', () => ctx.raw.VdbFile_nFieldCount(ctx.lib, live()))();
    },
    fields() {
      const count = vdb.fieldCount;
      return Array.from({ length: count }, (_, i) => ({ name: nameAt(i), type: typeAt(i) }));
    },
    add(field: Voxels | ScalarField | VectorField, name = ''): number {
      live();
      assertSameSession(ctx, field, 'vdb.add field');
      const kind = fieldKind(ctx, field);
      return withStrings(ctx, [name], (namePtr) => {
        if (kind === 'voxels') return ctx.raw.VdbFile_nAddVoxels(ctx.lib, handle, namePtr, field.handle);
        if (kind === 'scalarField') return ctx.raw.VdbFile_nAddScalarField(ctx.lib, handle, namePtr, field.handle);
        return ctx.raw.VdbFile_nAddVectorField(ctx.lib, handle, namePtr, field.handle);
      });
    },
    getVoxels(indexOrName: number | string): Voxels {
      const index = resolveIndex(indexOrName, 'voxels');
      return wrapVoxels(ctx, expectHandle('VdbFile_hGetVoxels', ctx.raw.VdbFile_hGetVoxels(ctx.lib, handle, index)));
    },
    getScalarField(indexOrName: number | string): ScalarField {
      const index = resolveIndex(indexOrName, 'scalarField');
      return wrapScalarField(ctx, expectHandle('VdbFile_hGetScalarField', ctx.raw.VdbFile_hGetScalarField(ctx.lib, handle, index)));
    },
    getVectorField(indexOrName: number | string): VectorField {
      const index = resolveIndex(indexOrName, 'vectorField');
      return wrapVectorField(ctx, expectHandle('VdbFile_hGetVectorField', ctx.raw.VdbFile_hGetVectorField(ctx.lib, handle, index)));
    },
    toBytes(): Uint8Array {
      live();
      stampPicoMetadata(ctx, handle);
      const path = temporaryVdbPath();
      const saved = withStrings(ctx, [path], (pathPtr) => ctx.raw.VdbFile_bSaveToFile(ctx.lib, handle, pathPtr));
      /* v8 ignore next 3 -- defensive: MEMFS writes at / cannot fail short of OOM,
         and the save path is not injectable through the facade */
      if (!saved) {
        throw new PicoError('PICO_CALL_FAILED', 'VdbFile_bSaveToFile failed — the container could not be serialised.');
      }
      try {
        return ctx.module.FS.readFile(path);
      } finally {
        ctx.module.FS.unlink(path);
      }
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.registry.unregister(vdb); // D2
      if (!ctx.dead.value) ctx.raw.VdbFile_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, vdb, handle, ctx.raw.VdbFile_Destroy);
  return vdb as VdbFile; // adoptHandle added [Symbol.dispose] (D6)
}

/**
 * The C# SaveToFile contract (OpenVdbFile.cs:165-181): before serialising, every
 * field gets PicoGK.Library / PicoGK.Version / PicoGK.VoxelSize stamped into its
 * metadata (SI units — voxel size in METRES). This is what makes the SG5 voxel-size
 * handshake work when the bytes reach desktop PicoGK or come back to us.
 */
function stampPicoMetadata(ctx: SessionContext, vdbHandle: bigint): void {
  const { raw, lib, module } = ctx;
  raw.Library_GetName(ctx.scratch);
  const libraryName = readCString(ctx, ctx.scratch);
  raw.Library_GetVersion(ctx.scratch);
  const libraryVersion = readCString(ctx, ctx.scratch);

  const count = raw.VdbFile_nFieldCount(lib, vdbHandle);
  for (let i = 0; i < count; i++) {
    const type = raw.VdbFile_nFieldType(lib, vdbHandle, i);
    /* v8 ignore next 9 -- the ": 0n" arm needs a foreign grid type (e.g. FOG) that
       this ABI cannot create; containers we build only hold types 0/1/2 */
    const field =
      type === 0
        ? raw.VdbFile_hGetVoxels(lib, vdbHandle, i)
        : type === 1
          ? raw.VdbFile_hGetScalarField(lib, vdbHandle, i)
          : type === 2
            ? raw.VdbFile_hGetVectorField(lib, vdbHandle, i)
            : 0n;
    /* v8 ignore next -- reachable only via the foreign-grid arm above */
    if (!field) continue; // unsupported field types are saved untouched
    const meta =
      type === 0
        ? raw.Metadata_hFromVoxels(lib, field)
        : type === 1
          ? raw.Metadata_hFromScalarField(lib, field)
          : raw.Metadata_hFromVectorField(lib, field);
    try {
      withStrings(ctx, ['PicoGK.Library', libraryName], (n, v) => raw.Metadata_SetStringValue(lib, meta, n, v));
      withStrings(ctx, ['PicoGK.Version', libraryVersion], (n, v) => raw.Metadata_SetStringValue(lib, meta, n, v));
      withStrings(ctx, ['PicoGK.VoxelSize'], (n) => raw.Metadata_SetFloatValue(lib, meta, n, ctx.voxelSize / 1000));
    } finally {
      raw.Metadata_Destroy(lib, meta);
      const destroyField = type === 0 ? raw.Voxels_Destroy : type === 1 ? raw.ScalarField_Destroy : raw.VectorField_Destroy;
      destroyField(lib, field);
    }
  }
  void module;
}

/** Discriminates a field wrapper by its surface (structural, no brands on the API). */
export function fieldKind(ctx: SessionContext, field: object): 'voxels' | 'scalarField' | 'vectorField' {
  if ('isEmpty' in field && 'union' in field) return 'voxels';
  if ('signedDistanceAt' in field) return 'scalarField';
  if ('traverse' in field) return 'vectorField';
  throw new PicoError('PICO_INVALID_ARGUMENT', 'Expected a Voxels, ScalarField, or VectorField wrapper.');
}
