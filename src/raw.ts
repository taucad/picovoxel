// picogk-js/raw — the generated, typed, complete ABI surface.
//
// loadPicoGkRaw gives you every core export as a cwrap keyed by ABI name; you own
// pointers, scratch buffers, and handle lifetimes. The main entry is the supported
// API — this subpath is the escape hatch and the conformance suite's substrate.
//
// loadPicoGkRaw instantiates the SERIAL glue. For the pthread variant, take
// `session.module` off a picogk-js/multi session and bindPicoGkRaw it — bind is
// glue-agnostic, which is what keeps this subpath out of the variant split.
import createPicoGKModuleUntyped from './picogk.mjs';
import { bindPicoGkRaw, type PicoGkRaw } from './raw.generated.ts';
import type { PicoGkWasmModule } from './types.ts';

export { bindPicoGkRaw } from './raw.generated.ts';
export type { PicoGkHandle, PicoGkRaw } from './raw.generated.ts';

/** Instantiates the serial wasm module and binds the full raw surface. */
export async function loadPicoGkRaw(overrides: object = {}): Promise<{ module: PicoGkWasmModule; raw: PicoGkRaw }> {
  const module = await (createPicoGKModuleUntyped as (overrides?: object) => Promise<PicoGkWasmModule>)(overrides);
  return { module, raw: bindPicoGkRaw(module) };
}
