// createPicoSession — the session factory behind both entries (library-api-policy):
//   §1 factories over classes; §3 flat options; §4 one options object per method;
//   §9 lazy init (wasm instantiates on the awaited factory call); §10 escape hatches.
//
// Deliberately glue-free: the Emscripten glue arrives as a factory argument, so the
// serial and pthread variants stay out of each other's module graphs. index.ts binds
// pico.mjs, multi.ts binds pico-multi.mjs; everything downstream is shared.
//
// Two lifetimes (TAU-L1, D31 of the production close-out): a RUNTIME is one
// instantiated wasm module (and, on the multi glue, its pthread pool); a SESSION is
// one PicoGK Library instance on it. The C++ core isolates instances completely —
// each owns its handle managers and voxel size (PicoGKLibraryMgr.h:57-125) and the
// picovoxel TUs hold no mutable globals — so any number of sessions can share one
// runtime. `createPico` is a runtime and a session disposed together.
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
  type ResolvedLane,
  type SessionContext,
} from './context.ts';
import { DISPOSE } from './dispose.ts';
import { PicoError, assertLive, guard } from './errors.ts';
import { assertVoxelsOperand, wrapScalarField, wrapVectorField, type ScalarField, type VectorField } from './fields.ts';
import { EXACT_LANE_SET } from './lanes.ts';
import { wrapLattice, type Lattice } from './lattice.ts';
import { bulkCreateMesh, wrapMesh, type Mesh } from './mesh.ts';
import { provenanceOf, rejectLaneIngest } from './metadata.ts';
import { wrapPolyLine, writeColor, type PolyLine } from './polyline.ts';
import { bindPicoRaw, type PicoRaw } from './raw.generated.ts';
import { createHandleRegistry, type HandleRegistry } from './registry.ts';
import { meshFromStlBytes, type FromStlOptions } from './stl.ts';
import type { SdfExpression } from './tape.ts';
import type { Color, PicoWasmModule, SdfFunction, Vec3 } from './types.ts';
import { withVdbBytes, wrapVdbFile, type VdbFile } from './vdb.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

/** Emscripten module factory — the shape both generated glues export. */
export type PicoGlueFactory = ((overrides?: object) => Promise<PicoWasmModule>) & {
  /**
   * The export names this glue reads from its module (generated per build into
   * `src/<variant>.exports.ts`). When present, a caller's `wasmModule` must carry
   * all of them before it is instantiated.
   */
  wasmExports?: readonly string[];
};

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

/** Options that shape a runtime: how the wasm module is instantiated. */
export interface CreatePicoRuntimeOptions {
  /** Emscripten Module overrides (e.g. locateFile, instantiateWasm) forwarded to instantiation. */
  wasm?: object;
  /**
   * A compiled `WebAssembly.Module` of this entry's wasm (`pico.wasm` for the base
   * entry, `pico-multi.wasm` for `picovoxel/multi`). It is instantiated directly —
   * no fetch, no compile — and on the multi glue it is also the module every pthread
   * worker instantiates. A host that compiles once per worker passes it here.
   * Mutually exclusive with `wasm.instantiateWasm`.
   */
  wasmModule?: WebAssembly.Module;
}

/** Options that shape a session: one PicoGK Library instance. */
export interface CreatePicoSessionOptions {
  /** Voxel edge length in millimetres. Cost scales cubically as it shrinks. */
  voxelSize?: number;
  /**
   * Native-memory warning threshold in bytes (default 1 GiB); 0 disables. It counts
   * this session's PicoGK objects only: sessions on one runtime share a single wasm
   * heap (and its 4 GB ceiling), which no per-session warning sees in full.
   */
  memoryWarningBytes?: number;
  /**
   * SKv2-0 V0.5 (§14.1) — the named lane bundle; a POLICY claim about every
   * value this session produces.
   * - `'exact'`: the byte-locked numerics policy, LOCKED — session-level or
   *   per-op loosening (e.g. `fastRenorm: true`) throws `PICO_LANE_LOOSENED`,
   *   and so does importing a `.vdb`/STL asset that carries non-exact
   *   provenance (no override: load it in an `'open'` or `'fast'` session).
   *   The claim is the weak, enforceable one — no Class-2 op fed anything in
   *   this session; the L0 *oracle* is specifically this lane on the serial
   *   artifact.
   * - `'fast'`: Class-2 accelerations default on (`fastRenorm` today; T1/T2
   *   when they land). Per-op/session-level *tightening* is allowed. Declaring
   *   it is also the export consent: STL and `.vdb` exports stamp the lane
   *   and never refuse (GLB still refuses until it has a provenance slot).
   * - `'auto'`: resolves to the strongest lane available at construction —
   *   `'fast'` today, adapter-qualified GPU lanes later — and counts as the
   *   same consent. `session.lane` always reports the RESOLUTION, never
   *   `'auto'` (an unresolved `'auto'` is the value that keys identically
   *   while resolving differently).
   * Omitted = `'open'`: unspecified — the pre-lane legacy; library defaults
   * with per-op freedom both ways, and exports of non-exact provenance refuse
   * unless acknowledged per export with `acceptLane: 'fast'`. The consent
   * rules cover today's Class-2 fast lane only; Class-3 (machine-scoped
   * relaxed-math/GPU) export policy is reserved for SK-2.
   */
  lane?: 'exact' | 'fast' | 'auto';
  /**
   * Session-wide default for the offset family's `fastRenorm` (SK-0.8
   * first-order renormalization — 3.5–3.9× on offsets, output bounded and
   * gated, see `offset()`). Default false = the byte-locked upstream path
   * (`lane: 'fast'` flips this default to true). Precedence: an explicit
   * per-op `fastRenorm` always wins over this.
   */
  fastRenorm?: boolean;
  /**
   * SKv2-0 V0.6 — routes lattice rendering down the serial C#-identical
   * `Voxels::RenderLattice` loop instead of the parallel tube-complex lane
   * (both deterministic; they differ at byte level, which is why this is a
   * keyed init option and not ambient state). Replaces the deleted
   * `PICOVOXEL_SERIAL_LATTICE` env read. Default false: tube-complex always —
   * nothing switches arms by size, and no automatic arm will be added without
   * a new charter row (LANES Part 4, ratified 2026-09-27).
   *
   * When to choose `true`: tiny lattices. The tube-complex lane pays a fixed
   * setup cost (spatial bucketing, the deterministic split tree) that is free
   * at 10^5 beams and dominant at ~14: the 14-beam HeatX print web went from
   * 2.9 to 7.3 ms on the tube lane (`bench/results/webgpu-v2/SK-0-EXIT.md` §5).
   * The catch: the serial arm is the defect-carrying one on beams whose end
   * spheres nest (upstream U23 — the round-cone SDF renders the larger ball
   * as something else entirely, -90.7% volume in the SK-0.4 corpus), while
   * the tube lane renders it correctly. In C# that defect is unconditional;
   * here it is opt-in with this flag.
   */
  serialLattice?: boolean;
  /** @internal test seam — fake disposal registry. */
  registry?: HandleRegistry;
  /** @internal test seam — clock for the warning throttle. */
  now?: () => number;
}

/** `createPico` options: a runtime and a session created (and disposed) together. */
export interface CreatePicoOptions extends CreatePicoRuntimeOptions, CreatePicoSessionOptions {}

/**
 * One instantiated wasm module — plus, on `picovoxel/multi`, its warm pthread pool —
 * that any number of sessions share. Each session is its own PicoGK Library
 * instance: voxel size, lane and every object are per session, and disposing a
 * session frees only what it owns. Disposing the runtime disposes every session
 * still open on it, then terminates the pool.
 */
export interface PicoRuntime {
  /** Opens a session on this runtime. Takes session options only — no wasm overrides. */
  createPico(options?: CreatePicoSessionOptions): Promise<Pico>;
  /** Disposes every open session, then terminates the pthread pool. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface Pico {
  readonly voxelSize: number;
  /** SKv2-0 V0.5 — the RESOLVED session lane (never `'auto'`; see `CreatePicoOptions.lane`). */
  readonly lane: 'exact' | 'fast' | 'open';
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

/** Session options after lane resolution and validation. */
interface ResolvedSessionOptions {
  voxelSize: number;
  lane: ResolvedLane;
  fastRenorm: boolean;
  memoryWarningBytes: number;
  serialLattice: boolean;
  registry: HandleRegistry | undefined;
  now: (() => number) | undefined;
}

/** Validates session options. Runs before any instantiation, so bad options cost nothing. */
function resolveSessionOptions(options: CreatePicoSessionOptions): ResolvedSessionOptions {
  const { voxelSize = 0.5, memoryWarningBytes = 2 ** 30, serialLattice = false, registry, now } = options;

  // §14.1 lane resolution — 'auto' resolves NOW (the resolved value is what
  // sessions report and what cache keys must see); 'exact' rejects loosening
  // at construction; 'fast' flips the fastRenorm default on.
  const lane: ResolvedLane = options.lane === 'auto' ? 'fast' : (options.lane ?? 'open');
  if (lane === 'exact' && options.fastRenorm === true) {
    throw new PicoError(
      'PICO_LANE_LOOSENED',
      "createPico({ lane: 'exact', fastRenorm: true }) is contradictory: 'exact' claims the byte-locked " +
        "numerics policy and fastRenorm is a Class-2 acceleration. Use lane: 'fast' (or omit the lane) instead.",
    );
  }
  const fastRenorm = options.fastRenorm ?? (lane === 'fast');

  if (!(voxelSize > 0) || !Number.isFinite(voxelSize)) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `voxelSize must be a positive number of millimetres, got ${voxelSize}. ` +
        'Cost scales cubically as it shrinks — 0.5 is a reasonable default.',
    );
  }
  return { voxelSize, lane, fastRenorm, memoryWarningBytes, serialLattice, registry, now };
}

/** Instantiates the glue, from a caller-compiled module when one is given. */
async function instantiate(glue: PicoGlueFactory, { wasm, wasmModule }: CreatePicoRuntimeOptions): Promise<PicoWasmModule> {
  const overrides: Record<string, unknown> = typeof wasm === 'object' && wasm !== null ? { ...wasm } : {};
  let failed: Promise<never> | undefined;
  if (wasmModule !== undefined) {
    if (overrides['instantiateWasm'] !== undefined) {
      throw new PicoError(
        'PICO_INVALID_ARGUMENT',
        'Pass either wasmModule or wasm.instantiateWasm, not both: each one decides how the module is instantiated.',
      );
    }
    if (!(wasmModule instanceof WebAssembly.Module)) {
      throw new PicoError('PICO_INVALID_ARGUMENT', 'wasmModule must be a compiled WebAssembly.Module.');
    }
    // Pre-flight: a module from another build or variant must fail HERE. Past
    // instantiation the multi glue defers run() behind its pool, so a missing export
    // surfaces there as an unhandled rejection and the promise never settles.
    const present = new Set(WebAssembly.Module.exports(wasmModule).map(({ name }) => name));
    const missing = (glue.wasmExports ?? []).filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new PicoError(
        'PICO_WASM_INIT_FAILED',
        `wasmModule is not this entry's build: it lacks ${missing.length} of the ${glue.wasmExports!.length} exports ` +
          'its glue reads. Compile the .wasm shipped next to this entry (pico.wasm for picovoxel, pico-multi.wasm ' +
          'for picovoxel/multi) from the same picovoxel version.',
      );
    }
    // The glue never gives instantiateWasm a way to reject (it resolves from the
    // callback only), so a failed instantiation is raced in beside it instead of
    // leaving the returned promise pending forever. The module goes to the
    // callback too: the multi glue hands exactly that module to every pthread.
    let fail!: (cause: unknown) => void;
    failed = new Promise<never>((_, reject) => (fail = reject));
    overrides['instantiateWasm'] = (
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      WebAssembly.instantiate(wasmModule, imports)
        .then((instance) => receive(instance, wasmModule))
        .catch(fail);
      return {};
    };
  }
  try {
    const loading = glue(overrides);
    return await (failed ? Promise.race([loading, failed]) : loading);
  } catch (cause) {
    // The multi glue starts its pthread pool (PThread.initMainThread) before the
    // module is even instantiated and publishes it on the overrides object it was
    // given. Nothing else will ever terminate those workers, and in Node they hold
    // the process open, so a failed instantiation joins them here.
    (overrides['PThread'] as PicoWasmModule['PThread'])?.terminateAllThreads();
    throw new PicoError(
      'PICO_WASM_INIT_FAILED',
      'PicoGK WebAssembly failed to instantiate. Check that the .wasm file is served next to its glue .mjs ' +
        'and that it is returned with Content-Type: application/wasm (or, with wasmModule, that it was ' +
        "compiled from this entry's .wasm).",
      { cause },
    );
  }
}

/** What a runtime lends each session it opens. */
interface RuntimeParts {
  module: PicoWasmModule;
  raw: PicoRaw;
  /** One FinalizationRegistry per loaded module (registry.ts), shared by its sessions. */
  registry: HandleRegistry;
  /** Release closures of the open sessions — never the session wrappers (D1). */
  open: Set<() => void>;
}

/** A runtime plus its internal session opener; the opener can hand the session the runtime's teardown. */
interface StartedRuntime {
  runtime: PicoRuntime;
  openSession(options: ResolvedSessionOptions, disposeRuntime?: () => void): Pico;
}

/**
 * Instantiates once, runs `warm` (the multi entry's pool warm-up), and returns the
 * runtime. A failed warm-up tears the runtime down before rethrowing, so nothing
 * leaves a pool running (SK-0.4 §10).
 */
async function startRuntime(
  glue: PicoGlueFactory,
  options: CreatePicoRuntimeOptions,
  warm?: (runtime: PicoRuntime) => Promise<void>,
): Promise<StartedRuntime> {
  const module = await instantiate(glue, options);
  const parts: RuntimeParts = { module, raw: bindPicoRaw(module), registry: createHandleRegistry(), open: new Set() };
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // Teardown order: every open session first (a Set iterator tolerates the
    // deletions each release makes), then the pool.
    for (const release of parts.open) release();
    // Join the module's pthread pool (multi glue only — absent on the serial glue).
    // Nothing else ever joins the em-pthread workers, so they outlive every JS
    // reference to this module, and at process teardown V8 can free the wasm backing
    // store while a worker is still executing in it — SIGILL, timing-dependent
    // (observed as vitest fork crashes; crash reports show an em-pthread faulting
    // under a main-thread BackingStore free. SK-0.4.md §10). The pool belongs to the
    // runtime, so it dies here and never with a single session.
    module.PThread?.terminateAllThreads();
  };

  const openSession = (resolved: ResolvedSessionOptions, disposeRuntime?: () => void): Pico => {
    assertLive(disposed, 'PicoGK runtime');
    return openPicoSession(parts, resolved, disposeRuntime);
  };

  const runtime = {
    async createPico(sessionOptions: CreatePicoSessionOptions = {}): Promise<Pico> {
      if ('wasm' in sessionOptions || 'wasmModule' in sessionOptions) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          'runtime.createPico() takes session options only: the module is already instantiated. ' +
            'Pass wasm / wasmModule to createPicoRuntime() instead.',
        );
      }
      return openSession(resolveSessionOptions(sessionOptions));
    },
    dispose,
  };
  (runtime as unknown as Record<symbol, unknown>)[DISPOSE] = dispose;

  if (warm) {
    try {
      await warm(runtime as unknown as PicoRuntime);
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return { runtime: runtime as unknown as PicoRuntime, openSession };
}

/**
 * Creates a runtime on the given glue. Internal seam — consumers use
 * `createPicoRuntime` from the package entry (serial) or `picovoxel/multi`.
 */
export async function openPicoRuntime(
  glue: PicoGlueFactory,
  options: CreatePicoRuntimeOptions = {},
  warm?: (runtime: PicoRuntime) => Promise<void>,
): Promise<PicoRuntime> {
  const misplaced = Object.keys(options).filter((key) => Object.hasOwn(SESSION_OPTION_KEYS, key));
  if (misplaced.length > 0) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `createPicoRuntime() takes runtime options only (wasm, wasmModule); ${misplaced.join(', ')} ` +
        'belong to each session: pass them to runtime.createPico(options).',
    );
  }
  return (await startRuntime(glue, options, warm)).runtime;
}

/** Every session option key — a Record so the compiler flags a key added to the interface but not here. */
const SESSION_OPTION_KEYS: Record<keyof CreatePicoSessionOptions, true> = {
  voxelSize: true,
  memoryWarningBytes: true,
  lane: true,
  fastRenorm: true,
  serialLattice: true,
  registry: true,
  now: true,
};

/**
 * Creates a PicoGK session on the given glue: a runtime and a session that
 * dispose together. Internal seam — consumers use `createPico` from the package
 * entry (serial) or `picovoxel/multi` (pthreads), which bind their variant's glue here.
 */
export async function createPicoSession(
  glue: PicoGlueFactory,
  options: CreatePicoOptions = {},
  warm?: (runtime: PicoRuntime) => Promise<void>,
): Promise<Pico> {
  const resolved = resolveSessionOptions(options);
  const { runtime, openSession } = await startRuntime(glue, options, warm);
  try {
    return openSession(resolved, runtime.dispose);
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}

/**
 * Frees what one session owns on the shared module — its scratch buffer and its
 * Library instance (which frees every object the instance holds) — and nothing else.
 * Idempotent through the dead flag, so session dispose, runtime dispose and a late
 * GC callback can race in any order. It doubles as the session's GC free, so it must
 * not reach the session wrapper (D1) — not even through a shared closure scope: V8
 * gives every closure in a function one context, and the session's own methods
 * capture `session`. Hence a factory of its own, closing over primitives, the dead
 * flag and the runtime parts only.
 */
function createSessionRelease(parts: RuntimeParts, dead: { value: boolean }, lib: bigint, scratch: number): () => void {
  const release = () => {
    if (dead.value) return;
    dead.value = true; // D4: teardown wins — wrappers stop freeing individually
    parts.open.delete(release);
    parts.module._free(scratch);
    parts.raw.Library_DestroyInstance(lib);
  };
  parts.open.add(release);
  return release;
}

/** Opens one Library instance on a runtime's module. */
function openPicoSession(parts: RuntimeParts, options: ResolvedSessionOptions, disposeRuntime?: () => void): Pico {
  const { module, raw } = parts;
  const { voxelSize, lane, fastRenorm, memoryWarningBytes, serialLattice, registry, now } = options;
  const lib = expectHandle('Library_hCreateInstance', raw.Library_hCreateInstance(voxelSize));

  let scratch: number;
  try {
    scratch = checkedMalloc(module, Math.max(BBOX_BYTES, INFO_STRING_BYTES), 'the session scratch buffer');
  } catch (error) {
    raw.Library_DestroyInstance(lib); // the runtime outlives this failure; don't leak the instance on it
    throw error;
  }
  const ctx: SessionContext = {
    module,
    lib,
    voxelSize,
    fastRenorm,
    lane,
    renderLatticeExport: serialLattice ? 'Voxels_RenderLattice' : 'Voxels_RenderLatticeTubes',
    raw,
    registry: registry ?? parts.registry,
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
    wrapVoxels: (handle, provenance) => wrapVoxels(ctx, handle, provenance),
  };

  const release = createSessionRelease(parts, ctx.dead, lib, scratch);

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

  const liveSession = () => assertLive(ctx.dead.value, 'PicoGK session');

  const session = {
    get voxelSize() {
      return voxelSize;
    },
    get lane() {
      return lane;
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
          return wrapVoxels(ctx, expectHandle('Voxels_hCreate', raw.Voxels_hCreate(lib)), EXACT_LANE_SET);
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
            EXACT_LANE_SET,
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
            EXACT_LANE_SET,
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
          return wrapVoxels(ctx, target, EXACT_LANE_SET);
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
        const lane = provenanceOf(options.from); // refuses a non-geometry operand before the native call
        if (options.value !== undefined) {
          return wrapScalarField(
            ctx,
            expectHandle(
              'ScalarField_hBuildFromVoxels',
              guard('ScalarField_hBuildFromVoxels', () => raw.ScalarField_hBuildFromVoxels(lib, from, options.value!, options.sdThreshold ?? 0.5))(),
            ),
            lane,
          );
        }
        return wrapScalarField(
          ctx,
          expectHandle('ScalarField_hCreateFromVoxels', guard('ScalarField_hCreateFromVoxels', () => raw.ScalarField_hCreateFromVoxels(lib, from))()),
          lane,
        );
      }
      return wrapScalarField(ctx, expectHandle('ScalarField_hCreate', raw.ScalarField_hCreate(lib)), EXACT_LANE_SET);
    },

    createVectorField(options: CreateVectorFieldOptions = {}): VectorField {
      liveSession();
      ctx.maybeWarnMemory();
      if ('from' in options && options.from) {
        const from = assertVoxelsOperand(ctx, options.from, 'createVectorField from');
        const lane = provenanceOf(options.from); // refuses a non-geometry operand before the native call
        if (options.value !== undefined) {
          ctx.writeVec3(scratch, options.value);
          return wrapVectorField(
            ctx,
            expectHandle(
              'VectorField_hBuildFromVoxels',
              guard('VectorField_hBuildFromVoxels', () => raw.VectorField_hBuildFromVoxels(lib, from, scratch, options.sdThreshold ?? 0.5))(),
            ),
            lane,
          );
        }
        return wrapVectorField(
          ctx,
          expectHandle('VectorField_hCreateFromVoxels', guard('VectorField_hCreateFromVoxels', () => raw.VectorField_hCreateFromVoxels(lib, from))()),
          lane,
        );
      }
      return wrapVectorField(ctx, expectHandle('VectorField_hCreate', raw.VectorField_hCreate(lib)), EXACT_LANE_SET);
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
      const { vertices, triangles, provenance } = meshFromStlBytes(bytes, options);
      rejectLaneIngest(ctx, provenance, 'meshFromStl'); // LANES defect 5 — before any native allocation
      return wrapMesh(ctx, bulkCreateMesh(ctx, vertices, triangles), provenance);
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
      if (ctx.dead.value) return; // D3 (also after the runtime disposed this session)
      ctx.registry.unregister(session); // D2
      release();
      // A session from the entry's createPico owns its runtime: they go together,
      // pool included (SK-0.4 §10). A session opened on a shared runtime leaves the
      // pool running for its siblings — runtime.dispose() joins it.
      disposeRuntime?.();
    },
  };
  adoptHandle(ctx, session, lib, release);
  return session as unknown as Pico; // adoptHandle added [Symbol.dispose] (D6)
}

// ── The multi entry's pool warm-up (glue-free, so it lives beside the runtime) ──

/**
 * PV-W1 — the warm-up op is sized in VOXELS, not millimetres, so its work (CFL
 * steps ∝ offset/voxelSize, band voxels ∝ (radius/voxelSize)²) is the same at every
 * voxel size. It used to be a 2 mm sphere offset by 0.5 mm at the session's voxel
 * size: 4 and 1 voxels at the 0.5 mm default, but ≈1 M band voxels and 50 CFL steps
 * at 0.02 mm, all before the pool engaged. These are those default-size numbers.
 */
export const WARM_RADIUS_VOXELS = 4;
export const WARM_OFFSET_VOXELS = 1;
/** The warm-up's scratch session voxel size (mm). Any value does the same work; this is the old default. */
const WARM_VOXEL_SIZE = 0.5;

/** The warm-up op on `pk`: a sphere offset outward, both sized in voxels. The caller disposes the result. */
export function warmUpOp(pk: Pico): Voxels {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: WARM_RADIUS_VOXELS * pk.voxelSize });
  try {
    return sphere.offset({ distance: WARM_OFFSET_VOXELS * pk.voxelSize });
  } finally {
    sphere.dispose();
  }
}

/**
 * Warms a multi runtime's pool once, on a scratch session of its own.
 *
 * The warmup matters: oneTBB launches its workers on the first parallel region,
 * and the launch handshake only completes while the main thread is off the wasm
 * stack. Without it, back-to-back synchronous calls run single-threaded forever
 * (measured: identical-to-serial timings, and a livelock under memory growth).
 * One tiny op + one yield turns that into full parallelism (measured 5–6× on
 * offsets at 12 threads). The workers then stay launched for every later
 * session on the runtime, so this runs once per runtime, not once per session.
 */
export async function warmPool(runtime: PicoRuntime): Promise<void> {
  const scratch = await runtime.createPico({ voxelSize: WARM_VOXEL_SIZE });
  // No fallback: PThread is unconditionally present in the -pthread glue the
  // multi entry binds, the only caller.
  const pool = scratch.module.PThread!;
  try {
    warmUpOp(scratch).dispose();
  } finally {
    scratch.dispose();
  }
  // The yielding is load-bearing (the handshake needs the main thread off the
  // wasm stack) but the *duration* never was: poll the pool instead of sleeping
  // a flat 100 ms. TBB wants one worker per core besides this thread, and a
  // 12-core machine gets there in 2–4 ms. The deadline is the old constant, so
  // a slow host — or one whose browser caps workers below hardwareConcurrency —
  // is never worse off than it was, it just stops being the common case.
  // No fallback on navigator.hardwareConcurrency: it exists in every supported
  // engine (Node >=21, all three gated browsers).
  const wanted = navigator.hardwareConcurrency - 1;
  const deadline = Date.now() + 100;
  while (pool.runningWorkers.length < wanted && Date.now() < deadline) {
    await new Promise((resume) => setTimeout(resume, 0));
  }
}
