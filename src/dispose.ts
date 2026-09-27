// The ONLY file that mentions Symbol.dispose (disposal-facade doc, Finding 3).
//
// No released Safari ships Symbol.dispose (MDN, 2026-09), and our floor is Safari 16.4
// (SIMD), so hosts without it need the symbol defined before any consumer `using` runs —
// tslib's __addDisposableResource reads the GLOBAL Symbol.dispose at use time and
// throws if it is missing, so installing it here serves consumer code too.
// When every supported host ships Symbol.dispose, delete the `??=` line; nothing else changes.

const S = Symbol as unknown as { dispose?: symbol };

/**
 * Ensures `Symbol.dispose` exists, assigning only when missing so native always wins
 * (well-known symbols are non-writable; `??=` short-circuits before any write).
 * `Symbol.for` over `Symbol()` keeps duplicate shim copies and cross-realm executions
 * idempotent. The `target` parameter exists because the native symbol cannot be
 * removed from the real `Symbol`, which would leave the polyfill branch untestable.
 */
export function ensureDisposeSymbol(target: { dispose?: symbol } = S): symbol {
  target.dispose ??= Symbol.for('Symbol.dispose');
  return target.dispose;
}

/** The dispose symbol every wrapper aliases: `wrapper[DISPOSE] = wrapper.dispose`. */
export const DISPOSE: symbol = ensureDisposeSymbol();
