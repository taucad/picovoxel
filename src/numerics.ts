// picovoxel/numerics — the CEM numerics foundation (real-world-subjects
// blueprint R1, decision D1). Two documented strata plus the canonical frame:
//   1. System.Numerics analog: vec2/vec3/quat/mat4 over allocation-light
//      readonly tuples (JS has no BCL vector layer — this is it).
//   2. PicoGK.Numerics port: Rad branded angles, Overhang, polar/cylindrical/
//      spherical coordinates, tolerances + fuzzy comparison.
//   3. frame — Frame3d semantics, the one rigid-frame type (Finding 9).
// Every C# API is graded ported-or-N/A in MIGRATING-FROM-CSHARP.md. Pure math,
// no wasm dependency: usable standalone and by picovoxel/shapekernel.

export { type Overhang, overhang, type Rad, rad, TWO_PI } from './numerics/angles.ts';
export { scalar, tolerances } from './numerics/comparison.ts';
export {
  type Cylindrical,
  cylindrical,
  type Polar,
  polar,
  type Spherical,
  spherical,
} from './numerics/coordinates.ts';
export { type Frame, frame } from './numerics/frame.ts';
export { mat4 } from './numerics/matrix.ts';
export { type Quat, quat } from './numerics/quaternion.ts';
export { type Vec2, vec2, vec3 } from './numerics/vector.ts';
export type { Mat4, Vec3 } from './types.ts';
