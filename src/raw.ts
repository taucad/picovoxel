// picogk-js/raw — the generated, typed, complete ABI surface.
//
// loadPicoGkRaw gives you every core export as a cwrap keyed by ABI name; you own
// pointers, scratch buffers, and handle lifetimes. The main entry is the supported
// API — this subpath is the escape hatch and the conformance suite's substrate.
export { bindPicoGkRaw, loadPicoGkRaw } from './raw.generated.ts';
export type { PicoGkHandle, PicoGkRaw } from './raw.generated.ts';

// Legacy helper loader (scratch-buffer conveniences). Shim until P3 removes it.
export { loadPicoGK } from './raw.mjs';
