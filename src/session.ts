// createPicoSession — the session factory behind both entries (library-api-policy):
//   §1 factories over classes; §3 flat options; §4 one options object per method;
//   §9 lazy init (wasm instantiates on the awaited factory call); §10 escape hatches.
//
// Deliberately glue-free: the Emscripten glue arrives as a factory argument, so the
// serial and pthread variants stay out of each other's module graphs. index.ts binds
// pico.mjs, multi.ts binds pico-multi.mjs; everything downstream is shared.
//
// Handles stay BigInt internally and never require consumer management: wrappers are
// GC-reclaimed via the FinalizationRegistry; dispose() is the optional escape hatch;
// session.dispose() is the deterministic full teardown.

import {
  adoptHandle,
  BBOX_BYTES,
  checkedMalloc,
  createMemoryWarning,
  expectHandle,
  INFO_STRING_BYTES,
  VEC3_BYTES,
  withSdfPointer,
  withSdfTape,
  withStrings,
  type SessionContext,
} from './context.ts';
import { PicoError, assertLive, guard } from './errors.ts';
import { assertVoxelsOperand, wrapScalarField, wrapVectorField, type ScalarField, type VectorField } from './fields.ts';
import { wrapLattice, type Lattice } from './lattice.ts';
import { bulkCreateMesh, wrapMesh, type Mesh } from './mesh.ts';
import { wrapPolyLine, writeColor, type PolyLine } from './polyline.ts';
import { bindPicoRaw } from './raw.generated.ts';
import { createHandleRegistry, type HandleRegistry } from './registry.ts';
import { meshFromStlBytes, type FromStlOptions } from './stl.ts';
import type { SdfExpression } from './tape.ts';
import type { Color, PicoWasmModule, SdfFunction, Vec3 } from './types.ts';
import { withVdbBytes, wrapVdbFile, type VdbFile } from './vdb.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

/** Emscripten module factory — the shape both generated glues export. */
export type PicoGlueFactory = (overrides?: object) => Promise<PicoWasmModule>;

export type CreateVoxelsOptions =
  | { shape: 'empty' }
  | { shape: 'sphere'; center?: Vec3; radius: number }
  | { shape: 'beam'; start: Vec3; end: Vec3; radius?: number; startRadius?: number; endRadius?: number }
  /** Alias of 'beam' kept for continuity with the R12 surface. */
  | { shape: 'capsule'; start: Vec3; end: Vec3; radius?: number; startRadius?: number; endRadius?: number }
  /**
   * A JS `sdf` function runs on upstream's serial fill (the callback is only
   * reachable from the main thread). A serializable {@link SdfExpression} is
   * compiled to a tape and filled in parallel in-module — on the /multi build
   * this engages every worker thread.
   */
  | { shape: 'implicit'; boundsMin: Vec3; boundsMax: Vec3; sdf: SdfFunction | SdfExpression };

export type CreateScalarFieldOptions =
  | { from: Voxels; value?: number; sdThreshold?: number }
  | Record<string, never>;

export type CreateVectorFieldOptions =
  | { from: Voxels; value?: Vec3; sdThreshold?: number }
  | Record<string, never>;

export interface MemoryUsage {
  total: number;
  voxels: number;
  meshes: number;
  lattices: number;
  polyLines: number;
  scalarFields: number;
  vectorFields: number;
  vdbFiles: number;
  metadata: number;
}

export type AllocatedCounts = Omit<MemoryUsage, 'total'>;

export interface CreatePicoOptions {
  /** Voxel edge length in millimetres. Cost scales cubically as it shrinks. */
  voxelSize?: number;
  /** Emscripten Module overrides (e.g. locateFile) forwarded to instantiation. */
  wasm?: object;
  /** Native-memory warning threshold in bytes (default 1 GiB); 0 disables. */
  memoryWarningBytes?: number;
  /**
   * Session-wide default for the offset family's `fastRenorm` (SK-0.8
   * first-order renormalization — 3.5–3.9× on offsets, output bounded and
   * gated, see `offset()`). Default false = the byte-locked upstream path.
   * Precedence: an explicit per-op `fastRenorm` always wins over this.
   */
  fastRenorm?: boolean;
  /** @internal test seam — fake disposal registry. */
  registry?: HandleRegistry;
  /** @internal test seam — clock for the warning throttle. */
  now?: () => number;
}

export interface Pico {
  readonly voxelSize: number;
  readonly name: string;
  readonly version: string;
  readonly buildInfo: string;
  /** Convert voxel-index coordinates to world millimetres. */
  voxelToMm(voxel: Vec3): Vec3;
  /** Convert world millimetres to integer voxel indices (fixes upstream B2). */
  mmToVoxel(mm: Vec3): Vec3;
  createVoxels(options: CreateVoxelsOptions): Voxels;
  /** Builds a mesh from vertex/triangle data via the bulk imports (two crossings). */
  createMesh(options: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): Mesh;
  createLattice(): Lattice;
  createPolyLine(options?: { color?: Color }): PolyLine;
  createScalarField(options?: CreateScalarFieldOptions): ScalarField;
  createVectorField(options?: CreateVectorFieldOptions): VectorField;
  /** An empty writable .vdb container. */
  createVdb(): VdbFile;
  /** Opens .vdb bytes as a container for field-level access. */
  openVdb(bytes: Uint8Array): VdbFile;
  /**
   * SG5 handshake — the voxel size recorded in .vdb bytes (mm), 0 when the file
   * carries no PicoGK metadata. Create a session with this size before loading.
   */
  vdbVoxelSize(bytes: Uint8Array): number;
  /** SG5 — first GRID_LEVEL_SET field wins; rich error otherwise. */
  voxelsFromVdb(bytes: Uint8Array): Voxels;
  /** SG7 — binary STL bytes to a mesh (UNITS= header honoured on 'auto'). */
  meshFromStl(bytes: Uint8Array, options?: FromStlOptions): Mesh;
  /** PicoGK-side memory usage in bytes, per object type. */
  readonly memory: MemoryUsage;
  /** PicoGK's own per-type allocation counters — the leak oracle. */
  readonly allocated: AllocatedCounts;
  /** §10 escape hatch: the raw Emscripten module. */
  readonly module: PicoWasmModule;
  /** §10 escape hatch: the raw Library handle. */
  readonly handle: bigint;
  /** Deterministic teardown: frees every object this session owns. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Creates a PicoGK session on the given glue. Internal seam — consumers use
 * `createPico` from the package entry (serial) or `picovoxel/multi` (pthreads),
 * which bind their variant's glue here.
 */
export async function createPicoSession(glue: PicoGlueFactory, options: CreatePicoOptions = {}): Promise<Pico> {
  const { voxelSize = 0.5, wasm, memoryWarningBytes = 2 ** 30, fastRenorm = false, registry, now } = options;

  if (!(voxelSize > 0) || !Number.isFinite(voxelSize)) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `voxelSize must be a positive number of millimetres, got ${voxelSize}. ` +
        'Cost scales cubically as it shrinks — 0.5 is a reasonable default.',
    );
  }

  let module: PicoWasmModule;
  try {
    module = await glue(typeof wasm === 'object' && wasm !== null ? wasm : {});
  } catch (cause) {
    throw new PicoError(
      'PICO_WASM_INIT_FAILED',
      'PicoGK WebAssembly failed to instantiate. Check that the .wasm file is served next to its glue .mjs ' +
        'and that it is returned with Content-Type: application/wasm.',
      { cause },
    );
  }

  const raw = bindPicoRaw(module);
  const lib = expectHandle('Library_hCreateInstance', raw.Library_hCreateInstance(voxelSize));

  const scratch = checkedMalloc(module, Math.max(BBOX_BYTES, INFO_STRING_BYTES), 'the session scratch buffer');
  const ctx: SessionContext = {
    module,
    lib,
    voxelSize,
    fastRenorm,
    raw,
    registry: registry ?? createHandleRegistry(),
    dead: { value: false },
    scratch,
    writeVec3(pointer, [x, y, z]) {
      module.HEAPF32[(pointer >>> 2) + 0] = x;
      module.HEAPF32[(pointer >>> 2) + 1] = y;
      module.HEAPF32[(pointer >>> 2) + 2] = z;
    },
    readVec3(pointer) {
      return [module.HEAPF32[pointer >>> 2]!, module.HEAPF32[(pointer >>> 2) + 1]!, module.HEAPF32[(pointer >>> 2) + 2]!];
    },
    maybeWarnMemory: createMemoryWarning({
      memoryWarningBytes,
      now: now ?? (() => Date.now()),
      totalMemUsage: () => raw.Library_nTotalMemUsage(lib),
    }),
  };

  const readInfo = (fn: 'Library_GetName' | 'Library_GetVersion' | 'Library_GetBuildInfo'): string => {
    raw[fn](scratch);
    return module.UTF8ToString(scratch);
  };

  const beamRadii = (options: { radius?: number; startRadius?: number; endRadius?: number }, where: string): [number, number] => {
    const start = options.startRadius ?? options.radius;
    const end = options.endRadius ?? options.radius;
    if (!(start! > 0) || !(end! > 0) || !Number.isFinite(start!) || !Number.isFinite(end!)) {
      throw new PicoError('PICO_INVALID_ARGUMENT', `${where} needs a positive radius (or startRadius/endRadius pair) in millimetres.`);
    }
    return [start!, end!];
  };

  let disposed = false;
  const liveSession = () => assertLive(disposed, 'PicoGK session');

  const session = {
    get voxelSize() {
      return voxelSize;
    },
    get name() {
      return readInfo('Library_GetName');
    },
    get version() {
      return readInfo('Library_GetVersion');
    },
    get buildInfo() {
      return readInfo('Library_GetBuildInfo');
    },

    voxelToMm(voxel: Vec3): Vec3 {
      liveSession();
      ctx.writeVec3(scratch, voxel);
      raw.Library_VoxelsToMm(lib, scratch, scratch + VEC3_BYTES);
      return ctx.readVec3(scratch + VEC3_BYTES);
    },
    mmToVoxel(mm: Vec3): Vec3 {
      // B2 fix: upstream Library.MmToVoxels calls _VoxelsToMm (Library.cs:276) —
      // the inverse conversion — so there is no working upstream behaviour to match.
      // Bind the real export and round to the NEAREST index (C#'s (int)(v + 0.5f)
      // idiom truncates toward zero and mis-rounds negative coordinates).
      liveSession();
      ctx.writeVec3(scratch, mm);
      raw.Library_MmToVoxels(lib, scratch, scratch + VEC3_BYTES);
      const [x, y, z] = ctx.readVec3(scratch + VEC3_BYTES);
      return [Math.round(x), Math.round(y), Math.round(z)];
    },

    createVoxels(options: CreateVoxelsOptions): Voxels {
      liveSession();
      ctx.maybeWarnMemory();
      switch (options.shape) {
        case 'empty': {
          return wrapVoxels(ctx, expectHandle('Voxels_hCreate', raw.Voxels_hCreate(lib)));
        }
        case 'sphere': {
          const { center = [0, 0, 0], radius } = options;
          if (!(radius > 0) || !Number.isFinite(radius)) {
            throw new PicoError('PICO_INVALID_ARGUMENT', `createVoxels({ shape: "sphere" }) needs a positive radius in millimetres, got ${radius}.`);
          }
          ctx.writeVec3(scratch, center);
          return wrapVoxels(
            ctx,
            expectHandle('Voxels_hCreateSphere', guard('Voxels_hCreateSphere', () => raw.Voxels_hCreateSphere(lib, scratch, radius))()),
          );
        }
        case 'beam':
        case 'capsule': {
          const { start, end } = options;
          if (!start || !end) {
            throw new PicoError(
              'PICO_INVALID_ARGUMENT',
              `createVoxels({ shape: "${options.shape}" }) needs start and end as [x, y, z] in millimetres.`,
            );
          }
          const [startRadius, endRadius] = beamRadii(options, `createVoxels({ shape: "${options.shape}" })`);
          ctx.writeVec3(scratch, start);
          ctx.writeVec3(scratch + VEC3_BYTES, end);
          return wrapVoxels(
            ctx,
            expectHandle(
              'Voxels_hCreateCapsule',
              guard('Voxels_hCreateCapsule', () => raw.Voxels_hCreateCapsule(lib, scratch, scratch + VEC3_BYTES, startRadius, endRadius))(),
            ),
          );
        }
        case 'implicit': {
          const { boundsMin, boundsMax, sdf } = options;
          if (!boundsMin || !boundsMax) {
            throw new PicoError(
              'PICO_INVALID_ARGUMENT',
              'createVoxels({ shape: "implicit" }) needs boundsMin and boundsMax as [x, y, z] in millimetres. ' +
                'The SDF is only sampled inside that box, so it must enclose the shape.',
            );
          }
          const target = expectHandle('Voxels_hCreate', raw.Voxels_hCreate(lib));
          try {
            ctx.writeVec3(scratch, boundsMin);
            ctx.writeVec3(scratch + VEC3_BYTES, boundsMax);
            if (typeof sdf === 'function') {
              // RenderImplicit is a SERIAL triple-nested loop (PicoGKVdbVoxels.h:370-381),
              // so a JS callback is correct under pthreads — and gains zero from them.
              withSdfPointer(ctx, sdf, (sdfPointer) => {
                guard('Voxels_RenderImplicit', () => raw.Voxels_RenderImplicit(lib, target, scratch, sdfPointer))();
              });
            } else {
              // Serialized SDF: compiled to a tape, evaluated in-module by the
              // parallel fill (src/pico-tape.cpp) — every pthread worker engages.
              withSdfTape(ctx, sdf, (instructionPointer, instructionCount, constantPointer, constantCount) => {
                guard('Voxels_RenderImplicitTape', () =>
                  raw.Voxels_RenderImplicitTape(lib, target, scratch, instructionPointer, instructionCount, constantPointer, constantCount),
                )();
              });
            }
          } catch (error) {
            raw.Voxels_Destroy(lib, target); // don't leak the target on a throwing SDF or bad tape
            throw error;
          }
          return wrapVoxels(ctx, target);
        }
        default:
          throw new PicoError(
            'PICO_INVALID_ARGUMENT',
            `Unknown shape "${(options as { shape: string }).shape}". Supported: "empty", "sphere", "beam", "implicit".`,
          );
      }
    },

    createMesh({ vertices, triangles }: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): Mesh {
      liveSession();
      ctx.maybeWarnMemory();
      return wrapMesh(ctx, bulkCreateMesh(ctx, vertices, triangles));
    },

    createLattice(): Lattice {
      liveSession();
      ctx.maybeWarnMemory();
      return wrapLattice(ctx, expectHandle('Lattice_hCreate', raw.Lattice_hCreate(lib)));
    },

    createPolyLine(options: { color?: Color } = {}): PolyLine {
      liveSession();
      ctx.maybeWarnMemory();
      writeColor(ctx, scratch, options.color ?? [1, 1, 1, 1]);
      return wrapPolyLine(ctx, expectHandle('PolyLine_hCreate', raw.PolyLine_hCreate(lib, scratch)));
    },

    createScalarField(options: CreateScalarFieldOptions = {}): ScalarField {
      liveSession();
      ctx.maybeWarnMemory();
      if ('from' in options && options.from) {
        const from = assertVoxelsOperand(ctx, options.from, 'createScalarField from');
        if (options.value !== undefined) {
          return wrapScalarField(
            ctx,
            expectHandle(
              'ScalarField_hBuildFromVoxels',
              guard('ScalarField_hBuildFromVoxels', () => raw.ScalarField_hBuildFromVoxels(lib, from, options.value!, options.sdThreshold ?? 0.5))(),
            ),
          );
        }
        return wrapScalarField(
          ctx,
          expectHandle('ScalarField_hCreateFromVoxels', guard('ScalarField_hCreateFromVoxels', () => raw.ScalarField_hCreateFromVoxels(lib, from))()),
        );
      }
      return wrapScalarField(ctx, expectHandle('ScalarField_hCreate', raw.ScalarField_hCreate(lib)));
    },

    createVectorField(options: CreateVectorFieldOptions = {}): VectorField {
      liveSession();
      ctx.maybeWarnMemory();
      if ('from' in options && options.from) {
        const from = assertVoxelsOperand(ctx, options.from, 'createVectorField from');
        if (options.value !== undefined) {
          ctx.writeVec3(scratch, options.value);
          return wrapVectorField(
            ctx,
            expectHandle(
              'VectorField_hBuildFromVoxels',
              guard('VectorField_hBuildFromVoxels', () => raw.VectorField_hBuildFromVoxels(lib, from, scratch, options.sdThreshold ?? 0.5))(),
            ),
          );
        }
        return wrapVectorField(
          ctx,
          expectHandle('VectorField_hCreateFromVoxels', guard('VectorField_hCreateFromVoxels', () => raw.VectorField_hCreateFromVoxels(lib, from))()),
        );
      }
      return wrapVectorField(ctx, expectHandle('VectorField_hCreate', raw.VectorField_hCreate(lib)));
    },

    createVdb(): VdbFile {
      liveSession();
      return wrapVdbFile(ctx, expectHandle('VdbFile_hCreate', raw.VdbFile_hCreate(lib)));
    },

    openVdb(bytes: Uint8Array): VdbFile {
      liveSession();
      return withVdbBytes(ctx, bytes, (path) =>
        wrapVdbFile(
          ctx,
          expectHandle(
            'VdbFile_hCreateFromFile',
            withStrings(ctx, [path], (pathPtr) => guard('VdbFile_hCreateFromFile', () => raw.VdbFile_hCreateFromFile(lib, pathPtr))()),
          ),
        ),
      );
    },

    vdbVoxelSize(bytes: Uint8Array): number {
      liveSession();
      // C# libCreateCompatibleLibraryFor (OpenVdbFile.cs:86-97): a scratch instance
      // reads field 0's 'PicoGK.VoxelSize' metadata (stored in metres — ×1000).
      const scratchLib = expectHandle('Library_hCreateInstance', raw.Library_hCreateInstance(10));
      try {
        return withVdbBytes(ctx, bytes, (path) => {
          const file = withStrings(ctx, [path], (pathPtr) => raw.VdbFile_hCreateFromFile(scratchLib, pathPtr));
          try {
            if (raw.VdbFile_nFieldCount(scratchLib, file) < 1) return 0;
            const type = raw.VdbFile_nFieldType(scratchLib, file, 0);
            /* v8 ignore next 9 -- the ": 0n" arm needs a foreign .vdb whose first grid
               is neither levelset nor scalar nor vector (e.g. a FOG grid); our ABI
               cannot produce such bytes to test with */
            const field =
              type === 0
                ? raw.VdbFile_hGetVoxels(scratchLib, file, 0)
                : type === 1
                  ? raw.VdbFile_hGetScalarField(scratchLib, file, 0)
                  : type === 2
                    ? raw.VdbFile_hGetVectorField(scratchLib, file, 0)
                    : 0n;
            /* v8 ignore next -- reachable only via the foreign-grid arm above */
            if (!field) return 0;
            const meta =
              type === 0
                ? raw.Metadata_hFromVoxels(scratchLib, field)
                : type === 1
                  ? raw.Metadata_hFromScalarField(scratchLib, field)
                  : raw.Metadata_hFromVectorField(scratchLib, field);
            const found = withStrings(ctx, ['PicoGK.VoxelSize'], (namePtr) =>
              raw.Metadata_bGetFloatAt(scratchLib, meta, namePtr, scratch),
            );
            const size = found ? module.HEAPF32[scratch >>> 2]! : 0;
            return size > 0 ? size * 1000 : 0; // stored in metres
          } finally {
            raw.VdbFile_Destroy(scratchLib, file);
          }
        });
      } finally {
        // Destroying the scratch instance frees every object it allocated.
        raw.Library_DestroyInstance(scratchLib);
      }
    },

    voxelsFromVdb(bytes: Uint8Array): Voxels {
      liveSession();
      ctx.maybeWarnMemory();
      // SG5 (VoxelsIo.cs:60-83): first GRID_LEVEL_SET field wins; anything else is
      // reported, not guessed at.
      const file = session.openVdb(bytes);
      try {
        const fields = file.fields();
        if (fields.length === 0) {
          throw new PicoError('PICO_VDB_NO_COMPATIBLE_FIELD', 'No fields contained in the OpenVDB bytes.');
        }
        const first = fields.findIndex((f) => f.type === 'voxels');
        if (first === -1) {
          const listing = fields.map((f) => `- ${f.name} (${f.type})`).join('\n');
          throw new PicoError(
            'PICO_VDB_NO_COMPATIBLE_FIELD',
            `No voxel field (openvdb::GRID_LEVEL_SET) found in the VDB bytes.\nFields found:\n${listing}`,
          );
        }
        return file.getVoxels(first);
      } finally {
        file.dispose();
      }
    },

    meshFromStl(bytes: Uint8Array, options: FromStlOptions = {}): Mesh {
      liveSession();
      ctx.maybeWarnMemory();
      const { vertices, triangles } = meshFromStlBytes(bytes, options);
      return wrapMesh(ctx, bulkCreateMesh(ctx, vertices, triangles));
    },

    get memory(): MemoryUsage {
      liveSession();
      return {
        total: Number(raw.Library_nTotalMemUsage(lib)),
        voxels: Number(raw.Library_nVoxelsMemUsage(lib)),
        meshes: Number(raw.Library_nMeshesMemUsage(lib)),
        lattices: Number(raw.Library_nLatticesMemUsage(lib)),
        polyLines: Number(raw.Library_nPolyLinesMemUsage(lib)),
        scalarFields: Number(raw.Library_nScalarFieldsMemUsage(lib)),
        vectorFields: Number(raw.Library_nVectorFieldsMemUsage(lib)),
        vdbFiles: Number(raw.Library_nVdbFilesMemUsage(lib)),
        metadata: Number(raw.Library_nVdbMetasMemUsage(lib)),
      };
    },

    get allocated(): AllocatedCounts {
      liveSession();
      return {
        voxels: Number(raw.Library_nVoxelsAllocated(lib)),
        meshes: Number(raw.Library_nMeshesAllocated(lib)),
        lattices: Number(raw.Library_nLatticesAllocated(lib)),
        polyLines: Number(raw.Library_nPolyLinesAllocated(lib)),
        scalarFields: Number(raw.Library_nScalarFieldsAllocated(lib)),
        vectorFields: Number(raw.Library_nVectorFieldsAllocated(lib)),
        vdbFiles: Number(raw.Library_nVdbFilesAllocated(lib)),
        metadata: Number(raw.Library_nVdbMetasAllocated(lib)),
      };
    },

    get module() {
      return module;
    },
    get handle() {
      return lib;
    },

    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.dead.value = true; // D4: teardown wins — wrappers stop freeing individually
      ctx.registry.unregister(session); // D2
      module._free(scratch);
      raw.Library_DestroyInstance(lib);
      // Join the module's pthread pool (multi glue only — absent on the serial glue).
      // Nothing ever joined the em-pthread workers, so they outlive every JS reference
      // to this module, and at process teardown V8 can free the wasm backing store
      // while a worker is still executing in it — SIGILL, timing-dependent (observed
      // as vitest fork crashes; crash reports show an em-pthread faulting under a
      // main-thread BackingStore free. SK-0.4.md §10). Each session instantiates its
      // own module, so its pool dies with it and no other session is affected.
      module.PThread?.terminateAllThreads();
    },
  };
  adoptHandle(ctx, session, lib, raw.Library_DestroyInstance);
  return session as unknown as Pico; // adoptHandle added [Symbol.dispose] (D6)
}
