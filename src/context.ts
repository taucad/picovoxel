// Session internals shared by every wrapper module. Not exported from the package.
//
// The context owns the wasm module, the Library handle, the scratch buffer, the
// disposal registry, and the raw export table. Wrapper files (voxels/mesh/…) receive
// it and never touch the module directly.

import { DISPOSE } from './dispose.ts';
import { PicoError } from './errors.ts';
import type { PicoRaw } from './raw.generated.ts';
import type { LaneSet } from './lanes.ts';
import type { HandleRegistry } from './registry.ts';
import { compileSdfExpression } from './tape.ts';
import type { SdfExpression } from './tape.ts';
import type { PicoWasmModule, SdfFunction, Vec3 } from './types.ts';
import type { Voxels } from './voxels.ts';

/**
 * Which export renders a lattice into voxels. Default: the parallel
 * tube-complex lane (`src/pico-lattice.cpp`, deterministic by construction).
 * `createPico({ serialLattice: true })` routes the facade down the serial
 * C#-identical `Voxels::RenderLattice` loop instead — the escape hatch, and the
 * arm the serial-lattice byte pins certify. The choice is a constructor option,
 * not an environment variable: ambient state that changes geometry breaks cache
 * keys, and a module-scoped read could not differ between two sessions in one
 * process. Both exports share one signature; the arm choice is per-session on
 * `SessionContext`.
 */
type RenderLatticeExport = 'Voxels_RenderLattice' | 'Voxels_RenderLatticeTubes';

/** Resolved session lane (§14.1). `'open'` = no lane requested: library
 * defaults with per-op freedom in both directions — the pre-lane behavior. */
export type ResolvedLane = 'exact' | 'fast' | 'open';
/** Value-class provenance a handle can carry. */
export type PicoLane = 'exact' | 'fast';

export const VEC3_BYTES = 12;
export const TRI_BYTES = 12;
export const BBOX_BYTES = 24; // PKBBox3 = 2 x PKVector3
export const INFO_STRING_BYTES = 255; // PKINFOSTRINGLEN

/**
 * {@link PicoRaw} with every binding typed as a free function. The bindings are
 * direct wasm exports that never read `this`, so detaching one (for example to
 * pass a destroy function to the registry) is safe.
 */
export type SessionRaw = {
  [K in keyof PicoRaw]: (...args: Parameters<PicoRaw[K]>) => ReturnType<PicoRaw[K]>;
};

/** Raw destroy signature the registry frees through. */
export type FreeFn = (lib: bigint, handle: bigint) => void;

export interface SessionContext {
  module: PicoWasmModule;
  lib: bigint;
  voxelSize: number;
  /**
   * SKv2-0 V0.4 — session default for the offset family's `fastRenorm`
   * (§14.1 precedence: explicit per-op > session default > library default
   * false). The `'fast'` lane bundle (V0.5) is what sets this true.
   */
  fastRenorm: boolean;
  /**
   * SKv2-0 V0.5 — the resolved session lane. `'exact'` locks the byte-locked
   * numerics policy (per-op loosening throws); `'fast'` defaults Class-2
   * accelerations on (tighten-only per-op overrides allowed); `'open'` is the
   * no-claim legacy behavior. `'auto'` never appears here — it resolves at
   * construction and `session.lane` reports the resolution.
   */
  lane: ResolvedLane;
  /** SKv2-0 V0.6 — the keyed lattice-arm selection (see RenderLatticeExport). */
  renderLatticeExport: RenderLatticeExport;
  raw: SessionRaw;
  registry: HandleRegistry;
  /** D4 — session teardown wins races; wrappers consult this before freeing. */
  dead: { value: boolean };
  /** BBOX_BYTES of scratch for pointer-taking calls. One per session, reused. */
  scratch: number;
  writeVec3(pointer: number, v: Vec3): void;
  readVec3(pointer: number): Vec3;
  /** Samples PicoGK's own memory counter, warns once past the threshold. */
  maybeWarnMemory(): void;
  /**
   * The Voxels wrapper factory, injected by the session so mesh.ts never
   * imports voxels.ts at run time: voxels.ts imports mesh.ts for `toMesh`, and
   * the build fails on a runtime import cycle.
   */
  wrapVoxels(handle: bigint, provenance?: LaneSet): Voxels;
}

/** Anything the facade hands out: disposable, optionally so (GC is the backstop). */
export interface Disposable {
  // Property form: the dispose function is detached and re-attached as `[Symbol.dispose]`.
  dispose: () => void;
}

/** Which session a wrapper belongs to — the SG10 cross-instance guard's memory. */
const WRAPPER_SESSION = new WeakMap<object, SessionContext>();

/**
 * D5/D6 — the single registration point. Every wrapper factory calls this exactly
 * once: registers the handle for GC-driven free (token = the wrapper itself, D2),
 * wires `[Symbol.dispose]` to the public dispose, and records session ownership.
 */
export function adoptHandle(ctx: SessionContext, wrapper: Disposable, handle: bigint, free: FreeFn): void {
  ctx.registry.register(wrapper, { lib: ctx.lib, handle, free }, wrapper);
  (wrapper as unknown as Record<symbol, unknown>)[DISPOSE] = wrapper.dispose;
  WRAPPER_SESSION.set(wrapper, ctx);
}

/** SG10 — operands from another Library instance corrupt nothing; they throw. */
export function assertSameSession(ctx: SessionContext, other: object, what: string): void {
  if (WRAPPER_SESSION.get(other) !== ctx) {
    throw new PicoError(
      'PICO_SESSION_MISMATCH',
      `${what} belongs to a different PicoGK session (or is not a picovoxel wrapper). ` +
        'Objects cannot cross Library instances — recreate it in this session.',
    );
  }
}

/**
 * `_malloc` that fails LOUDLY: near the wasm32 4 GB linear-memory ceiling
 * malloc returns 0, and unchecked writes then surface as bare RangeErrors
 * from `HEAP*.set` (seen on a fine-voxel probe at 0.3 mm). A
 * zero-byte request may legitimately return 0.
 *
 * Pointers this returns routinely exceed 2 GiB on fine-cell work (a 0.5 mm
 * HeatX mesh stages 120 MB at ~2.5 GiB). Index every heap view with `>>>`, never
 * `>>`: a signed shift turns such a pointer into a negative index, and
 * `subarray` *clamps* negatives instead of throwing, so the read silently
 * returns a window 1–2 GiB away (SK-0.10).
 */
export function checkedMalloc(module: PicoWasmModule, bytes: number, what: string): number {
  const pointer = module._malloc(bytes);
  if (pointer === 0 && bytes > 0) {
    throw new PicoError(
      'PICO_OUT_OF_MEMORY',
      `Failed to allocate ${bytes} bytes of wasm memory for ${what}. ` +
        'The wasm32 linear-memory ceiling is 4 GB — raise voxelSize, shrink the bounds, ' +
        'or dispose() intermediates sooner.',
    );
  }
  return pointer;
}

/**
 * Runs `body` with NUL-terminated UTF-8 copies of `texts` in wasm memory.
 * Buffers are freed on the way out; copy results before returning.
 */
export function withStrings<T>(
  ctx: SessionContext,
  texts: readonly string[],
  body: (...pointers: number[]) => T,
): T {
  const { module } = ctx;
  const pointers = texts.map((text) => {
    const bytes = module.lengthBytesUTF8(text) + 1;
    const pointer = checkedMalloc(module, bytes, 'a string argument');
    module.stringToUTF8(text, pointer, bytes);
    return pointer;
  });
  try {
    return body(...pointers);
  } finally {
    for (const pointer of pointers) module._free(pointer);
  }
}

/** Reads the NUL-terminated C string a call wrote into `pointer`. */
export function readCString(ctx: SessionContext, pointer: number): string {
  return ctx.module.UTF8ToString(pointer);
}

/** SG14 — every allocating call is checked; a null handle means allocation failed. */
export function expectHandle(operation: string, handle: bigint): bigint {
  if (!handle) {
    throw new PicoError(
      'PICO_ALLOC_FAILED',
      `${operation} returned a null handle — PicoGK could not allocate the object. ` +
        'On wasm32 this usually means the 4GB linear-memory ceiling is near; ' +
        'raise voxelSize or dispose intermediates sooner.',
    );
  }
  return handle;
}

/**
 * Runs `body` with a wasm function-table pointer for a JS SDF callback.
 * The C signature is float(*)(const PKVector3*): the trampoline reads the struct and
 * hands the author three scalars — at ~10^7 samples, allocating a vector object per
 * call is the difference between slow and unusable (measured at 3–9% total overhead).
 * The slot is removed in finally — addFunction slots leak without it.
 */
export function withSdfPointer<T>(ctx: SessionContext, sdf: unknown, body: (sdfPointer: number) => T): T {
  if (typeof sdf !== 'function') {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      'sdf must be a function (x, y, z) => number returning signed distance in millimetres.',
    );
  }
  const trampoline = (coordinatePointer: number): number => {
    const f32 = ctx.module.HEAPF32; // re-read per call: memory growth swaps the view
    const i = coordinatePointer >>> 2;
    return (sdf as SdfFunction)(f32[i]!, f32[i + 1]!, f32[i + 2]!);
  };
  const pointer = ctx.module.addFunction(trampoline, 'fi'); // float (i32)
  try {
    return body(pointer);
  } finally {
    ctx.module.removeFunction(pointer);
  }
}

/**
 * Runs `body` with a compiled SDF tape copied into wasm memory — the
 * serialized counterpart of {@link withSdfPointer}, evaluated in-module by
 * src/pico-tape.cpp on every thread. Buffers are freed on the way out.
 */
export function withSdfTape<T>(
  ctx: SessionContext,
  expression: SdfExpression,
  body: (
    instructionPointer: number,
    instructionCount: number,
    constantPointer: number,
    constantCount: number,
  ) => T,
): T {
  const { instructions, constants } = compileSdfExpression(expression);
  const { module } = ctx;
  const instructionPointer = checkedMalloc(module, instructions.byteLength, 'the SDF tape instructions');
  // Never malloc(0): a constant-free tape still needs a valid pointer.
  const constantPointer = checkedMalloc(module, Math.max(constants.byteLength, 8), 'the SDF tape constants');
  try {
    module.HEAPU32.set(instructions, instructionPointer >>> 2);
    module.HEAPF64.set(constants, constantPointer >>> 3);
    return body(instructionPointer, instructions.length / 2, constantPointer, constants.length);
  } finally {
    module._free(constantPointer);
    module._free(instructionPointer);
  }
}

export interface MemoryWarningOptions {
  /** Bytes of PicoGK-owned memory that trigger the one-time warning; 0 disables. */
  memoryWarningBytes: number;
  now: () => number;
  totalMemUsage: () => bigint;
}

/**
 * The JS analogue of C# PicoGK's GC.AddMemoryPressure timer (Library.cs:340-363):
 * we cannot push the GC, but we refuse to fail silently at 4 GB. Sampled from
 * factory calls at most once per second; warns once per session.
 */
export function createMemoryWarning(options: MemoryWarningOptions): () => void {
  let lastCheck = 0;
  let warned = false;
  return () => {
    if (warned || options.memoryWarningBytes <= 0) return;
    const t = options.now();
    if (t - lastCheck < 1000) return;
    lastCheck = t;
    if (Number(options.totalMemUsage()) > options.memoryWarningBytes) {
      warned = true;
      console.warn(
        `picovoxel: Pico native memory exceeds ${options.memoryWarningBytes} bytes. ` +
          'The GC cannot see wasm-side allocations, so long-lived intermediates may pile up — ' +
          'call dispose() on intermediates or session.dispose() when done ' +
          '(see the README "Memory" section). Raise or disable this warning via ' +
          'createPico({ memoryWarningBytes }).',
      );
    }
  };
}
