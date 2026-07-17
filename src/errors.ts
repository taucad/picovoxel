// R10 — typed errors at the C ABI boundary.
//
// PicoGK throws std::out_of_range from HandleManager::roGet (PicoGKHandleManager.h:79)
// and PicoGKLibrary.cpp has zero try/catch in 1,798 lines. Under -fwasm-exceptions
// that exception does cross extern "C" — MEASURED (2026-07-18), it surfaces in JS as
// a WebAssembly.Exception (opaque tag+payload, no usable message; under the old JS-EH
// -fexceptions build it was a bare Number), and the module stays usable afterwards.
//
// So this layer exists for legibility, not survival: an opaque WebAssembly.Exception
// tells a caller nothing. One higher-order wrapper beats 140 C++ try/catch blocks.

export type PicoGkErrorCode =
  | 'PICOGK_INVALID_HANDLE'
  | 'PICOGK_WASM_INIT_FAILED'
  | 'PICOGK_OUT_OF_MEMORY'
  | 'PICOGK_DISPOSED'
  | 'PICOGK_CALL_FAILED'
  | 'PICOGK_INVALID_ARGUMENT'
  | 'PICOGK_SESSION_MISMATCH'
  | 'PICOGK_ALLOC_FAILED'
  | 'PICOGK_RESERVED_METADATA'
  | 'PICOGK_VDB_NO_COMPATIBLE_FIELD'
  | 'PICOGK_NOT_IMPLEMENTED';

export class PicoGkError extends Error {
  code: PicoGkErrorCode;

  constructor(code: PicoGkErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PicoGkError';
    this.code = code;
  }
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
      // A WebAssembly.Exception is a C++ throw crossing the ABI. The only handle-
      // related throw in the dispatch layer is roGet's std::out_of_range, so attribute
      // it accordingly rather than emit a generic failure the caller cannot act on.
      const detail = describe(...args);
      if (cause instanceof WebAssembly.Exception) {
        throw new PicoGkError(
          'PICOGK_INVALID_HANDLE',
          `${operation} was called with a handle PicoGK does not know${detail ? ` (${detail})` : ''}. ` +
            'The handle was never created, belongs to another Library instance, or has already been disposed. ' +
            'PicoGK handles are never reused, so this is always a real lifetime bug — check for use after dispose().',
          { cause },
        );
      }
      if (cause instanceof WebAssembly.RuntimeError) {
        throw new PicoGkError(
          'PICOGK_OUT_OF_MEMORY',
          `${operation} aborted inside WebAssembly${detail ? ` (${detail})` : ''}. ` +
            'The usual cause on wasm32 is exhausting the 4GB linear-memory ceiling with voxel grids — ' +
            'raise voxelSize, shrink the bounds, or dispose intermediate Voxels sooner.',
          { cause },
        );
      }
      if (cause instanceof PicoGkError) throw cause;
      throw new PicoGkError('PICOGK_CALL_FAILED', `${operation} failed${detail ? ` (${detail})` : ''}.`, { cause });
    }
  };
}

/** Throws a typed, actionable error when a disposed wrapper is used. */
export function assertLive(disposed: boolean, kind: string): void {
  if (disposed) {
    throw new PicoGkError(
      'PICOGK_DISPOSED',
      `This ${kind} has already been disposed. Handles are not reusable after dispose(); ` +
        `create a new ${kind} — in ordinary use you never need to dispose at all.`,
    );
  }
}

/** R3 placeholder thrown by subpath stubs until their phases land. */
export function notImplemented(what: string): never {
  throw new PicoGkError('PICOGK_NOT_IMPLEMENTED', `${what} is not implemented yet — it lands in a later charter phase.`);
}
