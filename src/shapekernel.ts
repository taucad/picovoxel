// picogk-js/shapekernel — TypeScript port of LEAP71_ShapeKernel (Apache-2.0,
// © 2023-2026 LEAP 71; see NOTICE), built ON TOP of the public picogk-js API
// plus picogk-js/numerics (blueprint D3: subpath export, no wasm changes).
// Explicit-session surface: shapes are pure authoring objects; the session
// enters only at the voxelization boundary. The C# LocalFrame IS the numerics
// `Frame` here (Finding 9). Ported file-by-file and graded in
// MIGRATING-FROM-CSHARP.md; the viewer-bound Visualizations layer is
// deliberately not on this surface (R16).

export { Frames, type FrameType } from './shapekernel/frames.ts';
export { localFrame } from './shapekernel/localFrame.ts';
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
