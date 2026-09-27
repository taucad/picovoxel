// Public entry — the SERIAL variant. createPico is the supported surface
// (library-api-policy); picovoxel/raw is the generated escape hatch the
// conformance suite drives; picovoxel/multi is the pthread twin of this entry
// (same exported names — switching variants is a one-specifier change).
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (hosts without it, including every released Safari) before any consumer `using` code can run.
import './dispose.ts';

import createPicoModuleUntyped from './pico.mjs';
import { WASM_EXPORTS } from './pico.exports.ts';
import {
  createPicoSession,
  openPicoRuntime,
  type CreatePicoOptions,
  type CreatePicoRuntimeOptions,
  type Pico,
  type PicoGlueFactory,
  type PicoRuntime,
} from './session.ts';

// The glue plus the export names it reads, so a caller's wasmModule is checked first.
const glue: PicoGlueFactory = Object.assign(
  (overrides?: object) => (createPicoModuleUntyped as PicoGlueFactory)(overrides),
  {
    wasmExports: WASM_EXPORTS,
  },
);

/**
 * Creates a single-threaded PicoGK session. Resolves once the wasm module is
 * instantiated. The session owns its module: `dispose()` releases both.
 */
export async function createPico(options: CreatePicoOptions = {}): Promise<Pico> {
  return createPicoSession(glue, options);
}

/**
 * Creates a single-threaded runtime: the module is instantiated once, then
 * `runtime.createPico()` opens sessions on it with no per-session instantiation.
 * Each session is its own PicoGK Library instance (voxel size, lane and objects
 * are per session). `runtime.dispose()` disposes every open session.
 */
export async function createPicoRuntime(options: CreatePicoRuntimeOptions = {}): Promise<PicoRuntime> {
  return openPicoRuntime(glue, options);
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
  PicoWasmOverrides,
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
