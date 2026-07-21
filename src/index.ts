// Public entry — the SERIAL variant. createPico is the supported surface
// (library-api-policy); picovoxel/raw is the generated escape hatch the
// conformance suite drives; picovoxel/multi is the pthread twin of this entry
// (same exported names — switching variants is a one-specifier change).
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

import createPicoModuleUntyped from './pico.mjs';
import { createPicoSession, type CreatePicoOptions, type Pico, type PicoGlueFactory } from './session.ts';

const glue = createPicoModuleUntyped as PicoGlueFactory;

/** Creates a single-threaded PicoGK session. Resolves once the wasm module is instantiated. */
export async function createPico(options: CreatePicoOptions = {}): Promise<Pico> {
  return createPicoSession(glue, options);
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
