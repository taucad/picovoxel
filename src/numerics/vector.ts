// Numerics foundation.
// The System.Numerics analog JS lacks: Vector2/Vector3 algebra over the repo's
// allocation-light readonly tuples, plus PicoGK's VectorExt helpers
// (Extensions.cs) and the vector halves of Comparison.cs. Frame-dependent
// helpers (`vecPtWorld` and friends) live in frame.ts — in TS they are the
// frame functions themselves, not extension-method sugar.

import { PicoError } from '../errors.ts';
import type { Mat4, Vec3 } from '../types.ts';
import { scalar, tolerances } from './comparison.ts';

/** A 2D vector as an immutable tuple (System.Numerics `Vector2` analog). */
export type Vec2 = readonly [number, number];

function zeroLength(kind: string): PicoError {
  return new PicoError(
    'PICO_INVALID_ARGUMENT',
    `Cannot normalize a zero-length ${kind}. Use safeNormalized() if a zero result is acceptable.`,
  );
}

/** `Vector2` operations. */
export const vec2 = {
  zero: [0, 0] as Vec2,

  add: (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]],
  sub: (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]],
  scale: (v: Vec2, f: number): Vec2 => [v[0] * f, v[1] * f],
  dot: (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1],
  lengthSquared: (v: Vec2): number => v[0] * v[0] + v[1] * v[1],
  length: (v: Vec2): number => Math.hypot(v[0], v[1]),
  distanceSquared: (a: Vec2, b: Vec2): number => vec2.lengthSquared(vec2.sub(a, b)),
  lerp: (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],

  /** Unit-length copy; throws on (almost) zero-length input (C# `vecNormalized`). */
  normalized(v: Vec2): Vec2 {
    const length = vec2.length(v);
    if (scalar.almostZero(length)) throw zeroLength('Vec2');
    // .NET Vector2.Normalize divides component-wise (not multiply-by-reciprocal
    // — the reciprocal is off in the last ulp for e.g. length 5).
    return [v[0] / length, v[1] / length];
  },

  /** Unit-length copy, or (0,0) for (almost) zero-length input (C# `vecSafeNormalized`). */
  safeNormalized(v: Vec2): Vec2 {
    const length = vec2.length(v);
    if (scalar.almostZero(length)) return vec2.zero;
    return [v[0] / length, v[1] / length];
  },

  /** Lift to 3D by appending Z (C# `vecAsVector3`). */
  asVec3: (v: Vec2, z = 0): Vec3 => [v[0], v[1], z],

  /** Fuzzy equality by squared distance (C# `Vector2.bAlmostEqual`). */
  almostEqual: (a: Vec2, b: Vec2, distSquared = tolerances.defSquared): boolean =>
    vec2.distanceSquared(a, b) <= distSquared,

  /** Fuzzy zero-length test (C# `Vector2.bAlmostZero`). */
  almostZero: (v: Vec2, zeroSquared = tolerances.zeroSquared): boolean =>
    vec2.lengthSquared(v) <= zeroSquared,

  /** All components finite (C# `Vector2.bIsFinite`). */
  isFinite: (v: Vec2): boolean => Number.isFinite(v[0]) && Number.isFinite(v[1]),
} as const;

/** `Vector3` operations. */
export const vec3 = {
  zero: [0, 0, 0] as Vec3,
  unitX: [1, 0, 0] as Vec3,
  unitY: [0, 1, 0] as Vec3,
  unitZ: [0, 0, 1] as Vec3,
  one: [1, 1, 1] as Vec3,

  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  neg: (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]],
  scale: (v: Vec3, f: number): Vec3 => [v[0] * f, v[1] * f, v[2] * f],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  lengthSquared: (v: Vec3): number => v[0] * v[0] + v[1] * v[1] + v[2] * v[2],
  length: (v: Vec3): number => Math.hypot(v[0], v[1], v[2]),
  distanceSquared: (a: Vec3, b: Vec3): number => vec3.lengthSquared(vec3.sub(a, b)),
  distance: (a: Vec3, b: Vec3): number => vec3.length(vec3.sub(a, b)),
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],

  /** Unit-length copy; throws on (almost) zero-length input (C# `vecNormalized`). */
  normalized(v: Vec3): Vec3 {
    const length = vec3.length(v);
    if (scalar.almostZero(length)) throw zeroLength('Vec3');
    // .NET Vector3.Normalize divides component-wise (see vec2.normalized).
    return [v[0] / length, v[1] / length, v[2] / length];
  },

  /** Unit-length copy, or (0,0,0) for (almost) zero-length input (C# `vecSafeNormalized`). */
  safeNormalized(v: Vec3): Vec3 {
    const length = vec3.length(v);
    if (scalar.almostZero(length)) return vec3.zero;
    return [v[0] / length, v[1] / length, v[2] / length];
  },

  /** Drop Z (C# `vecStripZ`). */
  stripZ: (v: Vec3): Vec2 => [v[0], v[1]],

  /**
   * Row-vector matrix transform — translation lives in elements 12–14, the same
   * System.Numerics convention `mesh.transform({ matrix })` uses
   * (C# `Vector3.Transform(v, m)` / `vecTransformed`).
   */
  transformed(v: Vec3, m: Mat4): Vec3 {
    if (m.length !== 16) {
      throw new PicoError('PICO_INVALID_ARGUMENT', `transform matrix needs 16 elements, got ${m.length}.`);
    }
    const [x, y, z] = v;
    return [
      x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
      x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
      x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
    ];
  },

  /**
   * Mirror a point across the plane through `planePoint` with `planeNormal`
   * (C# `vecMirrored`; the normal is safe-normalized first).
   */
  mirrored(pt: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 {
    const n = vec3.safeNormalized(planeNormal);
    return vec3.sub(pt, vec3.scale(n, 2 * vec3.dot(vec3.sub(pt, planePoint), n)));
  },

  /** Fuzzy equality by squared distance (C# `Vector3.bAlmostEqual`). */
  almostEqual: (a: Vec3, b: Vec3, distSquared = tolerances.defSquared): boolean =>
    vec3.distanceSquared(a, b) <= distSquared,

  /** Fuzzy zero-length test (C# `Vector3.bAlmostZero`). */
  almostZero: (v: Vec3, zeroSquared = tolerances.zeroSquared): boolean =>
    vec3.lengthSquared(v) <= zeroSquared,

  /** All components finite (C# `Vector3.bIsFinite`). */
  isFinite: (v: Vec3): boolean => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]),
} as const;
