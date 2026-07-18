// Public entry — the SERIAL variant. createPicoGK is the supported surface
// (library-api-policy); picogk-js/raw is the generated escape hatch the
// conformance suite drives; picogk-js/multi is the pthread twin of this entry
// (same exported names — switching variants is a one-specifier change).
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

import createPicoGKModuleUntyped from './picogk.mjs';
import { createPicoGKSession, type CreatePicoGkOptions, type PicoGK, type PicoGkGlueFactory } from './session.ts';

const glue = createPicoGKModuleUntyped as PicoGkGlueFactory;

/** Creates a single-threaded PicoGK session. Resolves once the wasm module is instantiated. */
export async function createPicoGK(options: CreatePicoGkOptions = {}): Promise<PicoGK> {
  return createPicoGKSession(glue, options);
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
export type { Bounds, Color, Mat4, SdfFunction, Vec3 } from './types.ts';
