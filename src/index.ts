// Public entry. createPicoGK is the supported surface (library-api-policy);
// loadPicoGK is the thin raw-ABI loader the conformance suite drives.
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

export { createPicoGK } from './session.ts';
export type { CreatePicoGkOptions, CreateVoxelsOptions, PicoGK } from './session.ts';
export type { Voxels } from './voxels.ts';
export type { Mesh } from './mesh.ts';
export { PicoGkError } from './errors.ts';
export type { PicoGkErrorCode } from './errors.ts';
export type { Bounds, SdfFunction, Vec3 } from './types.ts';
export { loadPicoGK } from './raw.mjs';
