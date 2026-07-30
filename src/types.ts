// Public value types (API surface spec, Finding 1). Vec3 stays a readonly tuple:
// JSON-serialisable, spread-friendly, interops with three.js fromArray and gl-matrix
// without adopting either. All lengths are millimetres.

/** A 3D coordinate or direction, `[x, y, z]`, in millimetres unless noted. */
export type Vec3 = readonly [number, number, number];

/** An axis-aligned box in millimetres. See {@link emptyBounds} for the empty sentinel. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** float32 FLT_MAX — the ABI's empty-bounds sentinel component (SG15). */
export const FLOAT_MAX = 3.4028234663852886e38;

/**
 * SG15 — the empty-bounds sentinel the ABI structs use (`BBox3()` default:
 * min = +FLT_MAX, max = −FLT_MAX). Never NaN.
 */
export function emptyBounds(): Bounds {
  return { min: [FLOAT_MAX, FLOAT_MAX, FLOAT_MAX], max: [-FLOAT_MAX, -FLOAT_MAX, -FLOAT_MAX] };
}

/** True for the SG15 sentinel (an empty mesh/field produced it). */
export function isEmptyBounds(bounds: Bounds): boolean {
  return bounds.min[0] === FLOAT_MAX;
}

/** Signed distance in millimetres at (x, y, z) — scalars, never a vector object. */
export type SdfFunction = (x: number, y: number, z: number) => number;

/**
 * 4x4 transform, column-major in System.Numerics order (row-vector convention:
 * translation in elements 12–14).
 */
export type Mat4 = Float32Array | readonly number[];

/** RGBA color, each channel 0..1; alpha defaults to 1. */
export type Color = readonly [number, number, number] | readonly [number, number, number, number];

/**
 * The subset of the Emscripten module the facade touches. The glue itself is
 * generated JS (never typechecked); this interface is the typed boundary.
 */
export interface PicoWasmModule {
  cwrap(name: string, returnType: string | null, argTypes: readonly string[]): (...args: never[]) => unknown;
  ccall(name: string, returnType: string | null, argTypes: readonly string[], args: readonly unknown[]): unknown;
  UTF8ToString(pointer: number): string;
  stringToUTF8(text: string, pointer: number, maxBytes: number): void;
  lengthBytesUTF8(text: string): number;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  removeFunction(pointer: number): void;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPU8: Uint8Array;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    stat(path: string): { size: number };
  };
  wasmTable?: { length: number };
  /** Pthread pool state — present on the multi glue only (exported for observability,
   *  and for the dispose-time pool join — see session.dispose()). */
  PThread?: {
    runningWorkers: readonly unknown[];
    unusedWorkers: readonly unknown[];
    terminateAllThreads(): void;
  };
}
