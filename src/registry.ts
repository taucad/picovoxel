// GC-driven native-handle reclamation (disposal-facade doc, normative design).
//
// One FinalizationRegistry per loaded module; sessions register every wrapper with
// it. The held value carries only primitives plus the raw free cwrap (invariant D1 —
// referencing the wrapper would keep it alive forever), and explicit dispose()
// unregisters before freeing (D2) so the two paths can never double-free.

/** What the registry holds per wrapper — primitives + the raw free cwrap only (D1). */
export interface Held {
  lib: bigint;
  handle: bigint;
  free: (lib: bigint, handle: bigint) => void;
}

/**
 * The seam wrappers register through. Structurally satisfied by a real
 * FinalizationRegistry and by the fake recorder the unit tests inject.
 */
export interface HandleRegistry {
  register(wrapper: object, held: Held, token: object): void;
  unregister(token: object): boolean;
}

/**
 * Frees one held handle. Must never throw: engines may stop delivering callbacks
 * after a throwing cleanup, and a late callback for an already-destroyed session
 * legitimately throws through the ABI (D4 — teardown wins races; swallow it).
 */
export function freeHeld(held: Held): void {
  try {
    held.free(held.lib, held.handle);
  } catch {
    /* session torn down first — fine */
  }
}

/** Creates the real registry. Split from `freeHeld` so the callback is unit-testable. */
export function createHandleRegistry(): HandleRegistry {
  return new FinalizationRegistry<Held>(freeHeld);
}
