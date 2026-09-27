// picovoxel/raw — the generated, typed, complete ABI surface.
//
// loadPicoRaw gives you every core export as a direct wasm call keyed by ABI name; you own
// pointers, scratch buffers, and handle lifetimes. The main entry is the supported
// API — this subpath is the escape hatch and the conformance suite's substrate.
//
// loadPicoRaw instantiates the SERIAL glue. For the pthread variant, take
// `session.module` off a picovoxel/multi session and bindPicoRaw it — bind is
// glue-agnostic, which is what keeps this subpath out of the variant split.
import createPicoModuleUntyped from './pico.mjs';
import { bindPicoRaw, type PicoRaw } from './raw.generated.ts';
import type { PicoWasmModule } from './types.ts';

export { bindPicoRaw } from './raw.generated.ts';
export type { PicoHandle, PicoRaw } from './raw.generated.ts';

/** Instantiates the serial wasm module and binds the full raw surface. */
export async function loadPicoRaw(overrides: object = {}): Promise<{ module: PicoWasmModule; raw: PicoRaw }> {
  const module = await (createPicoModuleUntyped as (overrides?: object) => Promise<PicoWasmModule>)(
    overrides,
  );
  return { module, raw: bindPicoRaw(module) };
}
