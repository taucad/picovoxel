// Public entry. createPicoGK is the supported surface (library-api-policy);
// picogk-js/raw is the generated escape hatch the conformance suite drives.
//
// The dispose-shim import is load-bearing and must stay first: it installs
// Symbol.dispose (Safari 16.4–18.3) before any consumer `using` code can run.
import './dispose.ts';

export { createPicoGK } from './session.ts';
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
