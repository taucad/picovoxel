// picovoxel/multi — the PTHREAD variant of the package entry. Same exported
// names as the base entry, bound to pico-multi.mjs: switching variants is a
// one-specifier change, and neither glue ever appears in the other's graph.
//
// Allocator: this artifact links mimalloc (SKv2-0 V0.3, per the SK-0-EXIT
// decision table — construct 2.164×, byte-identical to dlmalloc). The serial
// entry stays dlmalloc: it is the L0 oracle lane and byte-locked.
//
// Runtime requirements beyond the serial build: SharedArrayBuffer — in browsers
// that means cross-origin isolation (COOP/COEP headers). Node needs nothing extra.
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

import createPicoMultiModuleUntyped from './pico-multi.mjs';
import { createPicoSession, type CreatePicoOptions, type Pico, type PicoGlueFactory } from './session.ts';

const glue = createPicoMultiModuleUntyped as PicoGlueFactory;

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
export async function createPico(options: CreatePicoOptions = {}): Promise<Pico> {
  const session = await createPicoSession(glue, options);
  const warm = session.createVoxels({ shape: 'sphere', radius: 2 });
  warm.offset({ distance: 0.5 });
  warm.dispose();
  // The yielding is load-bearing (the handshake needs the main thread off the
  // wasm stack) but the *duration* never was: poll the pool instead of sleeping
  // a flat 100 ms. TBB wants one worker per core besides this thread, and a
  // 12-core machine gets there in 2–4 ms. The deadline is the old constant, so
  // a slow host — or one whose browser caps workers below hardwareConcurrency —
  // is never worse off than it was, it just stops being the common case.
  // No fallbacks on the two lookups: navigator.hardwareConcurrency exists in
  // every supported engine (Node >=21, all three gated browsers) and PThread is
  // unconditionally present in the -pthread glue this entry is bound to.
  const pool = session.module.PThread!;
  const wanted = navigator.hardwareConcurrency - 1;
  const deadline = Date.now() + 100;
  while (pool.runningWorkers.length < wanted && Date.now() < deadline) {
    await new Promise((resume) => setTimeout(resume, 0));
  }
  return session;
}

export type {
  AllocatedCounts,
  CreatePicoOptions,
  CreateScalarFieldOptions,
  CreateVectorFieldOptions,
  CreateVoxelsOptions,
  MemoryUsage,
  Pico,
} from './session.ts';
export type { GetSliceOptions, ShellOptions, SliceAxis, SliceMode, Voxels, VoxelSlice } from './voxels.ts';
export type { Mesh, TransformOptions } from './mesh.ts';
export type { FromStlOptions, StlUnit, ToStlOptions } from './stl.ts';
export type { AddBeamOptions, Lattice } from './lattice.ts';
export type { PolyLine } from './polyline.ts';
export type { ScalarField, ScalarFieldSlice, VectorField } from './fields.ts';
export { surfaceNormalFieldExtractor, vectorFieldMerge } from './fieldUtils.ts';
export type { SurfaceNormalFieldOptions } from './fieldUtils.ts';
export type { Metadata, MetadataType, MetadataValue } from './metadata.ts';
export type { VdbFieldType, VdbFile } from './vdb.ts';
export { PicoError } from './errors.ts';
export type { PicoErrorCode } from './errors.ts';
export { emptyBounds, isEmptyBounds } from './types.ts';
export type { SdfExpression, SdfOperator } from './tape.ts';
export type { Bounds, Color, Mat4, SdfFunction, Vec3 } from './types.ts';
