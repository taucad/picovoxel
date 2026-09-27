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
import { WASM_EXPORTS } from './pico-multi.exports.ts';
import {
  createPicoSession,
  openPicoRuntime,
  warmPool,
  type CreatePicoOptions,
  type CreatePicoRuntimeOptions,
  type Pico,
  type PicoGlueFactory,
  type PicoRuntime,
} from './session.ts';

// The glue plus the export names it reads, so a caller's wasmModule is checked first.
const glue: PicoGlueFactory = Object.assign((overrides?: object) => (createPicoMultiModuleUntyped as PicoGlueFactory)(overrides), {
  wasmExports: WASM_EXPORTS,
});

/**
 * Creates a multithreaded (pthreads) PicoGK session. Resolves once the wasm
 * module is instantiated AND the TBB worker pool has had a chance to spin up
 * (see `warmPool` in session.ts). The session owns its module and pool:
 * `dispose()` terminates both.
 */
export async function createPico(options: CreatePicoOptions = {}): Promise<Pico> {
  return createPicoSession(glue, options, warmPool);
}

/**
 * Creates a multithreaded runtime: the module is instantiated and its pool warmed
 * once, then `runtime.createPico()` opens sessions on it with no per-session
 * instantiation, pool spawn or warm-up. Dispose the runtime when done — it
 * terminates the pool, which nothing else does.
 */
export async function createPicoRuntime(options: CreatePicoRuntimeOptions = {}): Promise<PicoRuntime> {
  return openPicoRuntime(glue, options, warmPool);
}

export type {
  AllocatedCounts,
  CreatePicoOptions,
  CreatePicoRuntimeOptions,
  CreatePicoSessionOptions,
  CreateScalarFieldOptions,
  CreateVectorFieldOptions,
  CreateVoxelsOptions,
  MemoryUsage,
  Pico,
  PicoRuntime,
} from './session.ts';
export type { GetSliceOptions, ShellOptions, SliceAxis, SliceMode, Voxels, VoxelSlice } from './voxels.ts';
export type { Mesh, TransformOptions } from './mesh.ts';
export { meshToStlBytes } from './stl.ts';
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
