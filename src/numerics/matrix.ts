// Numerics foundation (real-world-subjects blueprint R1).
// Completes the algebra for the `Mat4` type that already exists at the ABI
// (types.ts / mesh.transform): System.Numerics `Matrix4x4` in row-vector
// convention — basis vectors in rows, translation in elements 12–14, points
// transform as v·M (vec3.transformed). Scoped to the surface Frame3d and the
// mesh path use; the rest of Matrix4x4 is graded N/A in MIGRATING-FROM-CSHARP.md.

import { PicoError } from '../errors.ts';
import type { Mat4, Vec3 } from '../types.ts';

function checkMat4(m: Mat4, what: string): void {
  if (m.length !== 16) {
    throw new PicoError('PICO_INVALID_ARGUMENT', `${what} needs 16 elements, got ${m.length}.`);
  }
}

/** `Matrix4x4` operations. */
export const mat4 = {
  /** The identity matrix (C# `Matrix4x4.Identity`). */
  identity: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as Mat4,

  /** Scale matrix (C# `Matrix4x4.CreateScale`). */
  createScale: (scale: Vec3): Mat4 =>
    [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1] as const,

  /**
   * Matrix product `a·b` (C# `Matrix4x4.operator *`). Row-vector convention:
   * `v·(a·b)` applies `a` first, then `b`.
   */
  multiply(a: Mat4, b: Mat4): Mat4 {
    checkMat4(a, 'left matrix');
    checkMat4(b, 'right matrix');
    const out: number[] = []; // filled in index order 0..15 below
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        out[row * 4 + col] =
          a[row * 4]! * b[col]! +
          a[row * 4 + 1]! * b[4 + col]! +
          a[row * 4 + 2]! * b[8 + col]! +
          a[row * 4 + 3]! * b[12 + col]!;
      }
    }
    return out;
  },
} as const;
