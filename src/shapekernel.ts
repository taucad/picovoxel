// picogk-js/shapekernel — TypeScript port of LEAP71_ShapeKernel (Apache-2.0,
// © 2023-2026 LEAP 71; see NOTICE), built ON TOP of the public picogk-js API
// plus picogk-js/numerics (blueprint D3: subpath export, no wasm changes).
// Explicit-session surface: shapes are pure authoring objects; the session
// enters only at the voxelization boundary. The C# LocalFrame IS the numerics
// `Frame` here (Finding 9). Ported file-by-file and graded in
// MIGRATING-FROM-CSHARP.md; the viewer-bound Visualizations layer is
// deliberately not on this surface (R16).

export { BaseBox } from './shapekernel/baseBox.ts';
export { BaseCone, BaseCylinder } from './shapekernel/baseCylinder.ts';
export { BaseLens } from './shapekernel/baseLens.ts';
export {
  BasePipe,
  BasePipeSegment,
  type PipeSegmentMethod,
  type PipeSegmentOptions,
} from './shapekernel/basePipe.ts';
export { BaseRevolve } from './shapekernel/baseRevolve.ts';
export { BaseRing } from './shapekernel/baseRing.ts';
export {
  BaseShape,
  type LatticeBaseShape,
  MeshBuilder,
  type MeshBaseShape,
  type SpineBaseShape,
  type SurfaceBaseShape,
  type VertexTransformation,
} from './shapekernel/baseShape.ts';
export { BaseSphere } from './shapekernel/baseSphere.ts';
export { Frames, type FrameType } from './shapekernel/frames.ts';
export { localFrame } from './shapekernel/localFrame.ts';
export { meshUtility } from './shapekernel/meshUtility.ts';
export {
  Distribution,
  GenericContour,
  LineModulation,
  type ModulationCoord,
  type ModulationLine,
  type RatioFunc,
  SurfaceModulation,
  type SurfaceRatioFunc,
} from './shapekernel/modulations.ts';
export { splineOps } from './shapekernel/splineOperations.ts';
export {
  ControlPointSpline,
  CylindricalControlSpline,
  type CylindricalDirection,
  type Spline,
  type SplineEnds,
  TangentialControlSpline,
  type TangentOptions,
} from './shapekernel/splines.ts';
export {
  createRandom,
  type PolygonPreset,
  type RandomSource,
  type SuperShapePreset,
  uf,
} from './shapekernel/uf.ts';
export { vecOps } from './shapekernel/vecOperations.ts';
export { type Frame, frame } from './numerics/frame.ts';
export type { Vec3 } from './types.ts';
