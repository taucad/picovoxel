// picogk-js/multi — the PTHREAD variant of the package entry. Same exported
// names as the base entry, bound to picogk-multi.mjs: switching variants is a
// one-specifier change, and neither glue ever appears in the other's graph.
//
// Runtime requirements beyond the serial build: SharedArrayBuffer — in browsers
// that means cross-origin isolation (COOP/COEP headers). Node needs nothing extra.
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

import createPicoGKMultiModuleUntyped from './picogk-multi.mjs';
import { createPicoGKSession, type CreatePicoGkOptions, type PicoGK, type PicoGkGlueFactory } from './session.ts';

const glue = createPicoGKMultiModuleUntyped as PicoGkGlueFactory;

/**
 * Creates a multithreaded (pthreads) PicoGK session. Resolves once the wasm
 * module is instantiated AND the TBB worker pool has had a chance to spin up.
 *
 * The warmup matters: oneTBB launches its workers on the first parallel region,
 * and the launch handshake only completes while the main thread is off the wasm
 * stack. Without it, back-to-back synchronous calls run single-threaded forever
 * (measured: identical-to-serial timings, and a livelock under memory growth).
 * One tiny op + one yield turns that into full parallelism (measured 5–6× on
 * offsets at 12 threads).
 */
export async function createPicoGK(options: CreatePicoGkOptions = {}): Promise<PicoGK> {
  const session = await createPicoGKSession(glue, options);
  const warm = session.createVoxels({ shape: 'sphere', radius: 2 });
  warm.offset({ distance: 0.5 });
  warm.dispose();
  // ponytail: fixed ramp-up yield (11ms measured on 12 cores; 100ms for slow
  // machines/browsers). Poll module.PThread.runningWorkers if this ever flakes.
  await new Promise((resume) => setTimeout(resume, 100));
  return session;
}

export type {
  AllocatedCounts,
  CreatePicoGkOptions,
  CreateScalarFieldOptions,
  CreateVectorFieldOptions,
  CreateVoxelsOptions,
  MemoryUsage,
  PicoGK,
} from './session.ts';
export type { GetSliceOptions, ShellOptions, SliceAxis, SliceMode, Voxels, VoxelSlice } from './voxels.ts';
export type { Mesh, TransformOptions } from './mesh.ts';
export type { FromStlOptions, StlUnit, ToStlOptions } from './stl.ts';
export type { AddBeamOptions, Lattice } from './lattice.ts';
export type { PolyLine } from './polyline.ts';
export type { ScalarField, ScalarFieldSlice, VectorField } from './fields.ts';
export type { Metadata, MetadataType, MetadataValue } from './metadata.ts';
export type { VdbFieldType, VdbFile } from './vdb.ts';
export { PicoGkError } from './errors.ts';
export type { PicoGkErrorCode } from './errors.ts';
export { emptyBounds, isEmptyBounds } from './types.ts';
export type { SdfExpression, SdfOperator } from './tape.ts';
export type { Bounds, Color, Mat4, SdfFunction, Vec3 } from './types.ts';
