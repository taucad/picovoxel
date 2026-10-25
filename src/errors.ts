// Typed errors at the C ABI boundary.
//
// PicoGK throws std::out_of_range from HandleManager::roGet (PicoGKHandleManager.h:79)
// and PicoGKLibrary.cpp has zero try/catch in 1,798 lines. Under -fwasm-exceptions
// that exception does cross extern "C" — MEASURED (2026-07-18), it surfaces in JS as
// a WebAssembly.Exception (opaque tag+payload, no usable message; under the old JS-EH
// -fexceptions build it was a bare Number), and the module stays usable afterwards.
//
// So this layer exists for legibility, not survival: an opaque WebAssembly.Exception
// tells a caller nothing. One higher-order wrapper beats 140 C++ try/catch blocks.
//
// Heap exhaustion crosses the same way. The module grows memory on demand, so at the
// 4 GiB ceiling malloc returns null and operator new throws std::bad_alloc, which also
// arrives as a WebAssembly.Exception. Only the module that threw it can read its type,
// so each runtime registers a probe (Library_nExceptionKind in src/pico-bulk.cpp) and
// guard() asks the probes before it falls back to PICO_INVALID_HANDLE.

/**
 * The `code` of a {@link PicoError}. `PICO_OUT_OF_MEMORY` means the wasm heap is
 * exhausted: an allocation failed at the 4 GiB wasm32 limit, in the facade or in
 * native code. `PICO_INVALID_HANDLE` means a native call was given a handle its
 * Library instance does not hold.
 */
export type PicoErrorCode =
  | 'PICO_INVALID_HANDLE'
  | 'PICO_WASM_INIT_FAILED'
  | 'PICO_OUT_OF_MEMORY'
  | 'PICO_DISPOSED'
  | 'PICO_CALL_FAILED'
  | 'PICO_INVALID_ARGUMENT'
  | 'PICO_SESSION_MISMATCH'
  | 'PICO_ALLOC_FAILED'
  | 'PICO_RESERVED_METADATA'
  | 'PICO_VDB_NO_COMPATIBLE_FIELD'
  | 'PICO_LANE_LOOSENED'
  | 'PICO_LANE_EXPORT'
  | 'PICO_NOT_IMPLEMENTED';

export class PicoError extends Error {
  code: PicoErrorCode;

  constructor(code: PicoErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PicoError';
    this.code = code;
  }
}

/**
 * Asks one wasm module whether a native exception is its C++ `std::bad_alloc`.
 * Returns false for an exception the module did not throw.
 */
export type OutOfMemoryProbe = (exception: WebAssembly.Exception) => boolean;

// Weak, so a runtime that is garbage collected without dispose() leaves nothing
// behind: the owner keeps its probe alive, and the set only refers to it.
const probes = new Set<WeakRef<OutOfMemoryProbe>>();
const probeOwners = new WeakMap<object, OutOfMemoryProbe>();

/**
 * Registers `owner`'s probe for guard() to consult while `owner` is alive.
 * Returns the function that unregisters it.
 */
export function registerOutOfMemoryProbe(owner: object, probe: OutOfMemoryProbe): () => void {
  probeOwners.set(owner, probe);
  const reference = new WeakRef(probe);
  probes.add(reference);
  return () => {
    probes.delete(reference);
  };
}

/** True when a registered module identifies `exception` as its own `std::bad_alloc`. */
function isNativeOutOfMemory(exception: WebAssembly.Exception): boolean {
  for (const reference of probes) {
    const probe = reference.deref();
    if (probe === undefined) {
      probes.delete(reference);
    } else if (probe(exception)) {
      return true;
    }
  }
  return false;
}

/**
 * Wraps a raw ABI call so C++ exceptions become typed, actionable JS errors.
 * `operation` names the export; `describe` renders the arguments for the message.
 */
export function guard<A extends unknown[], R>(
  operation: string,
  fn: (...args: A) => R,
  describe: (...args: A) => string = () => '',
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return fn(...args);
    } catch (cause) {
      // A WebAssembly.Exception is a C++ throw crossing the ABI. A std::bad_alloc is
      // heap exhaustion. Otherwise the only handle-related throw in the dispatch layer
      // is roGet's std::out_of_range, so attribute it accordingly rather than emit a
      // generic failure the caller cannot act on.
      const detail = describe(...args);
      if (cause instanceof WebAssembly.Exception && isNativeOutOfMemory(cause)) {
        throw new PicoError(
          'PICO_OUT_OF_MEMORY',
          `${operation} ran out of WebAssembly memory${detail ? ` (${detail})` : ''}: a native allocation failed ` +
            'at the 4 GiB wasm32 heap limit, which picovoxel/multi shares. Dispose this session, then retry with ' +
            'a coarser voxelSize, smaller bounds, or intermediates disposed sooner.',
          { cause },
        );
      }
      if (cause instanceof WebAssembly.Exception) {
        throw new PicoError(
          'PICO_INVALID_HANDLE',
          `${operation} was called with a handle PicoGK does not know${detail ? ` (${detail})` : ''}. ` +
            'The handle was never created, belongs to another Library instance, or has already been disposed. ' +
            'PicoGK handles are never reused, so this is always a real lifetime bug — check for use after dispose().',
          { cause },
        );
      }
      if (cause instanceof WebAssembly.RuntimeError) {
        throw new PicoError(
          'PICO_OUT_OF_MEMORY',
          `${operation} aborted inside WebAssembly${detail ? ` (${detail})` : ''}. ` +
            'The usual cause on wasm32 is exhausting the 4GB linear-memory ceiling with voxel grids — ' +
            'raise voxelSize, shrink the bounds, or dispose intermediate Voxels sooner.',
          { cause },
        );
      }
      if (cause instanceof PicoError) throw cause;
      throw new PicoError('PICO_CALL_FAILED', `${operation} failed${detail ? ` (${detail})` : ''}.`, {
        cause,
      });
    }
  };
}

/** Throws a typed, actionable error when a disposed wrapper is used. */
export function assertLive(disposed: boolean, kind: string): void {
  if (disposed) {
    throw new PicoError(
      'PICO_DISPOSED',
      `This ${kind} has already been disposed. Handles are not reusable after dispose(); ` +
        `create a new ${kind} — in ordinary use you never need to dispose at all.`,
    );
  }
}

/** Placeholder error thrown by subpath stubs for unimplemented entry points. */
export function notImplemented(what: string): never {
  throw new PicoError(
    'PICO_NOT_IMPLEMENTED',
    `${what} is not implemented yet — it lands in a later charter phase.`,
  );
}
