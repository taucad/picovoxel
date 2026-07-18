// Numerics foundation (real-world-subjects blueprint R1).
// The System.Numerics `Quaternion` analog, scoped to the surface the kernel
// and its consumers actually use: axis-angle construction, rotating vectors,
// rotation-matrix extraction and slerp (Frame3d rotations + interpolation,
// ShapeKernel's vecRotateAroundAxis). Algorithms mirror the .NET reference
// implementations so differential goldens line up.

import { PicoGkError } from '../errors.ts';
import type { Mat4, Vec3 } from '../types.ts';
import type { Rad } from './angles.ts';

/** A rotation quaternion as [x, y, z, w] (System.Numerics `Quaternion` analog). */
export type Quat = readonly [number, number, number, number];

/** `Quaternion` operations. */
export const quat = {
  /** The identity rotation (C# `Quaternion.Identity`). */
  identity: [0, 0, 0, 1] as Quat,

  /**
   * From a rotation axis and angle (C# `Quaternion.CreateFromAxisAngle`).
   * As in .NET, the axis is used as given — normalize it first if needed.
   */
  fromAxisAngle(axis: Vec3, angle: Rad): Quat {
    const half = angle * 0.5;
    const s = Math.sin(half);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
  },

  /**
   * Extract the rotation from a rigid row-vector matrix
   * (C# `Quaternion.CreateFromRotationMatrix`, Shepperd's method — the same
   * four branches as the .NET reference source).
   */
  fromMat4(m: Mat4): Quat {
    if (m.length !== 16) {
      throw new PicoGkError('PICOGK_INVALID_ARGUMENT', `rotation matrix needs 16 elements, got ${m.length}.`);
    }
    const m11 = m[0]!, m12 = m[1]!, m13 = m[2]!;
    const m21 = m[4]!, m22 = m[5]!, m23 = m[6]!;
    const m31 = m[8]!, m32 = m[9]!, m33 = m[10]!;

    const trace = m11 + m22 + m33;
    if (trace > 0) {
      let s = Math.sqrt(trace + 1);
      const w = s * 0.5;
      s = 0.5 / s;
      return [(m23 - m32) * s, (m31 - m13) * s, (m12 - m21) * s, w];
    }
    if (m11 >= m22 && m11 >= m33) {
      const s = Math.sqrt(1 + m11 - m22 - m33);
      const invS = 0.5 / s;
      return [0.5 * s, (m12 + m21) * invS, (m13 + m31) * invS, (m23 - m32) * invS];
    }
    if (m22 > m33) {
      const s = Math.sqrt(1 + m22 - m11 - m33);
      const invS = 0.5 / s;
      return [(m21 + m12) * invS, 0.5 * s, (m32 + m23) * invS, (m31 - m13) * invS];
    }
    const s = Math.sqrt(1 + m33 - m11 - m22);
    const invS = 0.5 / s;
    return [(m31 + m13) * invS, (m32 + m23) * invS, 0.5 * s, (m12 - m21) * invS];
  },

  /** Dot product (C# `Quaternion.Dot`). */
  dot: (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],

  /** Component-wise negation — the same rotation, opposite hemisphere. */
  neg: (q: Quat): Quat => [-q[0], -q[1], -q[2], -q[3]],

  /**
   * Spherical linear interpolation (C# `Quaternion.Slerp`): shortest arc —
   * flips the second quaternion's hemisphere when the dot is negative, and
   * falls back to lerp when the quaternions are nearly parallel.
   */
  slerp(a: Quat, b: Quat, t: number): Quat {
    const epsilon = 1e-6;
    let cosOmega = quat.dot(a, b);
    let flip = false;
    if (cosOmega < 0) {
      flip = true;
      cosOmega = -cosOmega;
    }
    let s1: number, s2: number;
    if (cosOmega > 1 - epsilon) {
      s1 = 1 - t;
      s2 = flip ? -t : t;
    } else {
      const omega = Math.acos(cosOmega);
      const invSinOmega = 1 / Math.sin(omega);
      s1 = Math.sin((1 - t) * omega) * invSinOmega;
      s2 = flip ? -Math.sin(t * omega) * invSinOmega : Math.sin(t * omega) * invSinOmega;
    }
    return [
      s1 * a[0] + s2 * b[0],
      s1 * a[1] + s2 * b[1],
      s1 * a[2] + s2 * b[2],
      s1 * a[3] + s2 * b[3],
    ];
  },

  /** Rotate a vector by the quaternion (C# `Vector3.Transform(v, q)`). */
  transform(v: Vec3, q: Quat): Vec3 {
    const [qx, qy, qz, qw] = q;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const wx2 = qw * x2, wy2 = qw * y2, wz2 = qw * z2;
    const xx2 = qx * x2, xy2 = qx * y2, xz2 = qx * z2;
    const yy2 = qy * y2, yz2 = qy * z2, zz2 = qz * z2;
    const [x, y, z] = v;
    return [
      x * (1 - yy2 - zz2) + y * (xy2 - wz2) + z * (xz2 + wy2),
      x * (xy2 + wz2) + y * (1 - xx2 - zz2) + z * (yz2 - wx2),
      x * (xz2 - wy2) + y * (yz2 + wx2) + z * (1 - xx2 - yy2),
    ];
  },
} as const;
