// Session internals shared by every wrapper module. Not exported from the package.
//
// The context owns the wasm module, the Library handle, the scratch buffer, the
// disposal registry, and the raw cwrap table. Wrapper files (voxels/mesh/…) receive
// it and never touch the module directly.

import type { RawTable } from './bindings.ts';
import { DISPOSE } from './dispose.ts';
import { PicoGkError } from './errors.ts';
import type { HandleRegistry } from './registry.ts';
import type { PicoGkWasmModule, SdfFunction, Vec3 } from './types.ts';

export const VEC3_BYTES = 12;
export const TRI_BYTES = 12;
export const BBOX_BYTES = 24; // PKBBox3 = 2 x PKVector3
export const INFO_STRING_BYTES = 255; // PKINFOSTRINGLEN

/** Raw destroy signature the registry frees through. */
export type FreeFn = (lib: bigint, handle: bigint) => void;

export interface SessionContext {
  module: PicoGkWasmModule;
  lib: bigint;
  voxelSize: number;
  raw: RawTable;
  registry: HandleRegistry;
  /** D4 — session teardown wins races; wrappers consult this before freeing. */
  dead: { value: boolean };
  /** BBOX_BYTES of scratch for pointer-taking calls. One per session, reused. */
  scratch: number;
  writeVec3(pointer: number, v: Vec3): void;
  readVec3(pointer: number): Vec3;
  /** Samples PicoGK's own memory counter, warns once past the threshold. */
  maybeWarnMemory(): void;
}

/** Anything the facade hands out: disposable, optionally so (GC is the backstop). */
export interface Disposable {
  dispose(): void;
}

/**
 * D5/D6 — the single registration point. Every wrapper factory calls this exactly
 * once: registers the handle for GC-driven free (token = the wrapper itself, D2)
 * and wires `[Symbol.dispose]` to the public dispose.
 */
export function adoptHandle(ctx: SessionContext, wrapper: Disposable, handle: bigint, free: FreeFn): void {
  ctx.registry.register(wrapper, { lib: ctx.lib, handle, free }, wrapper);
  (wrapper as unknown as Record<symbol, unknown>)[DISPOSE] = wrapper.dispose;
}

/** SG14 — every allocating call is checked; a null handle means allocation failed. */
export function expectHandle(operation: string, handle: bigint): bigint {
  if (!handle) {
    throw new PicoGkError(
      'PICOGK_ALLOC_FAILED',
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
 * call is the difference between slow and unusable (R20: 3–9% total overhead).
 * The slot is removed in finally — addFunction slots leak without it.
 */
export function withSdfPointer<T>(ctx: SessionContext, sdf: unknown, body: (sdfPointer: number) => T): T {
  if (typeof sdf !== 'function') {
    throw new PicoGkError(
      'PICOGK_INVALID_ARGUMENT',
      'sdf must be a function (x, y, z) => number returning signed distance in millimetres.',
    );
  }
  const trampoline = (coordinatePointer: number): number => {
    const f32 = ctx.module.HEAPF32; // re-read per call: memory growth swaps the view
    const i = coordinatePointer >> 2;
    return (sdf as SdfFunction)(f32[i]!, f32[i + 1]!, f32[i + 2]!);
  };
  const pointer = ctx.module.addFunction(trampoline, 'fi'); // float (i32)
  try {
    return body(pointer);
  } finally {
    ctx.module.removeFunction(pointer);
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
        `picogk-js: PicoGK native memory exceeds ${options.memoryWarningBytes} bytes. ` +
          'The GC cannot see wasm-side allocations, so long-lived intermediates may pile up — ' +
          'call dispose() on intermediates or session.dispose() when done ' +
          '(see the README "Memory" section). Raise or disable this warning via ' +
          'createPicoGK({ memoryWarningBytes }).',
      );
    }
  };
}
