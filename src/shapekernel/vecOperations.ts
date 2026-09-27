// Derived from LEAP71_ShapeKernel — ShapeKernel/Utilities/VecOperations.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R4); see NOTICE.
//
// Cylindrical/spherical point helpers and rotation utilities the whole
// ShapeKernel layer leans on. Angles are plain radians numbers here, as
// upstream (ShapeKernel predates the Rad type). The C#-[Obsolete] members
// (Normalize/ConvertTo3D/ConvertTo2D/vecTranslate*/vecExpress*) are not
// reproduced — their replacements are `vec3`/`frame` in picovoxel/numerics.
//
// NOTE vecOps.sphPoint measures theta from the XY plane upward (sin θ → z),
// which is NOT the `spherical` coordinate convention in picovoxel/numerics
// (polar angle from +Z). Ported as upstream wrote it.

import { PicoError } from '../errors.ts';
import { rad } from '../numerics/angles.ts';
import type { Frame } from '../numerics/frame.ts';
import { quat } from '../numerics/quaternion.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';

/** ShapeKernel `VecOperations` (Hungarian prefixes dropped). */
export const vecOps = {
  /** Cartesian point from cylindrical coordinates (C# `vecGetCylPoint`). */
  cylPoint: (radius: number, phi: number, z: number): Vec3 => [
    radius * Math.cos(phi),
    radius * Math.sin(phi),
    z,
  ],

  /** Cartesian point from spherical coordinates, theta measured from the XY plane (C# `vecGetSphPoint`). */
  sphPoint: (radius: number, phi: number, theta: number): Vec3 => [
    radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(theta),
  ],

  /** Planar (XY) radius about the absolute Z axis (C# `fGetRadius` / the `R` extension). */
  radius: (pt: Vec3): number => Math.sqrt(pt[0] * pt[0] + pt[1] * pt[1]),

  /** Planar polar angle about the absolute Z axis, radians (C# `fGetPhi`). */
  phi: (pt: Vec3): number => Math.atan2(pt[1], pt[0]),

  /** Elevation angle from the XY plane, radians (C# `fGetTheta`). */
  theta: (pt: Vec3): number => Math.atan2(pt[2], vecOps.radius(pt)),

  /** Same phi and z, new radius (C# `vecSetRadius`). */
  setRadius: (pt: Vec3, newRadius: number): Vec3 => vecOps.cylPoint(newRadius, vecOps.phi(pt), pt[2]),

  /** Same radius and z, new phi (C# `vecSetPhi`). */
  setPhi: (pt: Vec3, newPhi: number): Vec3 => vecOps.cylPoint(vecOps.radius(pt), newPhi, pt[2]),

  /** Same radius and phi, new z (C# `vecSetZ`). */
  setZ: (pt: Vec3, newZ: number): Vec3 => vecOps.cylPoint(vecOps.radius(pt), vecOps.phi(pt), newZ),

  /** Radially shifted by deltaRadius (C# `vecUpdateRadius`). */
  updateRadius: (pt: Vec3, deltaRadius: number): Vec3 =>
    vecOps.cylPoint(vecOps.radius(pt) + deltaRadius, vecOps.phi(pt), pt[2]),

  /** Turned about the absolute Z axis by deltaPhi (C# `vecUpdatePhi`). */
  updatePhi: (pt: Vec3, deltaPhi: number): Vec3 =>
    vecOps.cylPoint(vecOps.radius(pt), vecOps.phi(pt) + deltaPhi, pt[2]),

  /** Vertically shifted by deltaZ (C# `vecUpdateZ`). */
  updateZ: (pt: Vec3, deltaZ: number): Vec3 =>
    vecOps.cylPoint(vecOps.radius(pt), vecOps.phi(pt), pt[2] + deltaZ),

  /** Normalized planar radial direction from the Z axis to the point (C# `vecGetPlanarDir`). */
  planarDir: (pt: Vec3): Vec3 => vec3.safeNormalized([pt[0], pt[1], 0]),

  /** The vector or its negation, whichever aligns better with the target (C# `vecFlipForAlignment`). */
  flipForAlignment(dir: Vec3, targetDir: Vec3): Vec3 {
    return vec3.dot(targetDir, dir) >= vec3.dot(targetDir, vec3.neg(dir)) ? dir : vec3.neg(dir);
  },

  /** True when the direction points the same way as the target (C# `bCheckAlignment`). */
  checkAlignment: (dir: Vec3, targetDir: Vec3): boolean =>
    vec3.dot(targetDir, dir) >= vec3.dot(targetDir, vec3.neg(dir)),

  /** Rotate a point about the absolute Z axis through an optional origin (C# `vecRotateAroundZ`). */
  rotateAroundZ(pt: Vec3, deltaPhi: number, axisOrigin: Vec3 = vec3.zero): Vec3 {
    const diff = vec3.sub(pt, axisOrigin);
    const rotated = vecOps.setPhi(diff, vecOps.phi(diff) + deltaPhi);
    return vec3.add(axisOrigin, rotated);
  },

  /** An arbitrary direction orthogonal to the given one (C# `vecGetOrthogonalDir`). */
  orthogonalDir(dir: Vec3): Vec3 {
    let nonParallel = vec3.unitX;
    if (Math.abs(vec3.dot(dir, nonParallel)) > 0.95) nonParallel = vec3.unitY;
    return vec3.safeNormalized(vec3.cross(dir, nonParallel));
  },

  /**
   * Minimum angle between two vectors, radians (C# `fGetAngleBetween`).
   * The C# NaN-repair branch is unreachable after the clamp and not reproduced.
   */
  angleBetween(a: Vec3, b: Vec3): number {
    const dot = vec3.dot(vec3.safeNormalized(a), vec3.safeNormalized(b));
    return Math.acos(Math.min(1, Math.max(-1, dot)));
  },

  /** Minimum SIGNED angle between two vectors about a reference normal (C# `fGetSignedAngleBetween`). */
  signedAngleBetween(a: Vec3, b: Vec3, refNormal: Vec3): number {
    const zeroError = 1e-20;
    if (
      vec3.lengthSquared(a) < zeroError ||
      vec3.lengthSquared(b) < zeroError ||
      vec3.lengthSquared(refNormal) < zeroError
    ) {
      throw new PicoError('PICO_INVALID_ARGUMENT', 'signedAngleBetween: Vec3 with zero length.');
    }
    const na = vec3.safeNormalized(a);
    const nb = vec3.safeNormalized(b);
    const normal = vecOps.flipForAlignment(vec3.cross(na, nb), vec3.safeNormalized(refNormal));
    const theta = Math.abs(vecOps.angleBetween(na, nb));
    const posDot = vec3.dot(na, vecOps.rotateAroundAxis(nb, theta, normal));
    const negDot = vec3.dot(na, vecOps.rotateAroundAxis(nb, -theta, normal));
    return negDot > posDot ? -theta : theta;
  },

  /** Rotate a point about an arbitrary axis through an optional origin (C# `vecRotateAroundAxis`). */
  rotateAroundAxis(pt: Vec3, deltaPhi: number, axis: Vec3, axisOrigin: Vec3 = vec3.zero): Vec3 {
    const relative = vec3.sub(pt, axisOrigin);
    const q = quat.fromAxisAngle(axis, rad.fromRad(deltaPhi));
    return vec3.add(quat.transform(relative, q), axisOrigin);
  },

  /** Radial direction from a frame's Z axis to the point, in world space (C# `vecGetDirectionToAxis`). */
  directionToAxis(frame: Frame, pt: Vec3): Vec3 {
    const relative = vec3.sub(pt, frame.pos);
    const x = vec3.dot(relative, frame.lx);
    const y = vec3.dot(relative, frame.ly);
    return vec3.safeNormalized(vec3.add(vec3.scale(frame.lx, x), vec3.scale(frame.ly, y)));
  },

  /** Radius from a frame's Z axis to the point (C# `fGetRadiusToAxis`). */
  radiusToAxis(frame: Frame, pt: Vec3): number {
    const relative = vec3.sub(pt, frame.pos);
    const x = vec3.dot(relative, frame.lx);
    const y = vec3.dot(relative, frame.ly);
    return Math.sqrt(x * x + y * y);
  },

  /** Polar angle about a frame's Z axis to the point (C# `fGetPhiToAxis`). */
  phiToAxis(frame: Frame, pt: Vec3): number {
    const relative = vec3.sub(pt, frame.pos);
    return Math.atan2(vec3.dot(relative, frame.ly), vec3.dot(relative, frame.lx));
  },

  /** Cylindrically interpolated point between two points (C# `vecCylindricalInterpolation`). */
  cylindricalInterpolation(pt1: Vec3, pt2: Vec3, ratio: number, axisOrigin: Vec3 = vec3.zero): Vec3 {
    const origin = vecOps.setZ(axisOrigin, 0);
    const minAngle = vecOps.angleBetween(pt1, pt2);
    const side1 = vec3.safeNormalized(vec3.sub(pt1, origin));

    // Rotation sense: whichever direction lands closer to pt2.
    const distPos = vec3.length(vec3.sub(pt2, vecOps.rotateAroundZ(pt1, minAngle)));
    const distNeg = vec3.length(vec3.sub(pt2, vecOps.rotateAroundZ(pt1, -minAngle)));
    const sense = distNeg < distPos ? -1 : 1;

    const radius1 = vecOps.radius(vec3.sub(pt1, origin));
    const radius2 = vecOps.radius(vec3.sub(pt2, origin));
    const interRadius = radius1 + ratio * (radius2 - radius1);
    const interZ = pt1[2] + ratio * (pt2[2] - pt1[2]);

    const inter = vecOps.rotateAroundZ(vec3.scale(side1, interRadius), sense * ratio * minAngle);
    return vec3.add(vecOps.setZ(inter, interZ), origin);
  },

  /** Spherically interpolated point between two points (C# `vecSphericalInterpolation`). */
  sphericalInterpolation(pt1: Vec3, pt2: Vec3, ratio: number, axisOrigin: Vec3 = vec3.zero): Vec3 {
    const minAngle = vecOps.angleBetween(pt1, pt2);
    const side1 = vec3.safeNormalized(vec3.sub(pt1, axisOrigin));
    const side2 = vec3.safeNormalized(vec3.sub(pt2, axisOrigin));
    const normal = vec3.cross(side1, side2);

    const distPos = vec3.length(vec3.sub(pt2, vecOps.rotateAroundAxis(pt1, minAngle, normal)));
    const distNeg = vec3.length(vec3.sub(pt2, vecOps.rotateAroundAxis(pt1, -minAngle, normal)));
    const sense = distNeg < distPos ? -1 : 1;

    const radius1 = vec3.length(vec3.sub(pt1, axisOrigin));
    const radius2 = vec3.length(vec3.sub(pt2, axisOrigin));
    const interRadius = radius1 + ratio * (radius2 - radius1);

    const inter = vecOps.rotateAroundAxis(vec3.scale(side1, interRadius), sense * ratio * minAngle, normal);
    return vec3.add(inter, axisOrigin);
  },
} as const;
