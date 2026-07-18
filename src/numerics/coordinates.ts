// Numerics foundation (real-world-subjects blueprint R1).
// Ports PicoGK Numerics/Coordinates.cs: polar / cylindrical / spherical
// coordinates — the currency of rotational and helical construction in CEM.
// Factories validate as the C# constructors do; conversions and lerps mirror
// them exactly (angular deltas normalize signed, so lerp takes the short way
// around).

import { PicoGkError } from '../errors.ts';
import type { Vec3 } from '../types.ts';
import { type Rad, rad } from './angles.ts';
import { scalar, tolerances } from './comparison.ts';
import { type Vec2, vec2, vec3 } from './vector.ts';

/** A polar coordinate (C# `PicoGK.Numerics.Polar`): radius + azimuth from +X. */
export interface Polar {
  readonly r: number;
  readonly phi: Rad;
}

/** A cylindrical coordinate (C# `Cylindrical`): radius from the Z axis, azimuth, height. */
export interface Cylindrical {
  readonly r: number;
  readonly phi: Rad;
  readonly z: number;
}

/** A spherical coordinate (C# `Spherical`): radius, azimuth `phi` (−π..π), polar angle `theta` from +Z (0..π). */
export interface Spherical {
  readonly r: number;
  readonly phi: Rad;
  readonly theta: Rad;
}

function invalid(message: string): PicoGkError {
  return new PicoGkError('PICOGK_INVALID_ARGUMENT', message);
}

function checkRadius(r: number): void {
  if (!Number.isFinite(r) || r < 0) throw invalid(`Radius must be finite and non-negative, got ${r}.`);
}

function checkPhi(phi: Rad): void {
  if (!Number.isFinite(phi)) throw invalid(`Phi must be finite, got ${phi}.`);
}

/** `Polar` factories and conversions. */
export const polar = {
  /** Validated constructor (C# `Polar(fR, rPhi)`). */
  create(r: number, phi: Rad): Polar {
    checkRadius(r);
    checkPhi(phi);
    return { r, phi };
  },

  /** From a 2D cartesian point (C# `Polar(Vector2)`; azimuth undefined at the origin → zero). */
  fromCartesian(v: Vec2): Polar {
    if (!vec2.isFinite(v)) throw invalid(`Cartesian vector must be finite, got (${v[0]}, ${v[1]}).`);
    const lengthSquared = vec2.lengthSquared(v);
    if (lengthSquared <= tolerances.zeroSquared) return { r: 0, phi: rad.zero };
    return { r: Math.sqrt(lengthSquared), phi: rad.atan2(v[1], v[0]) };
  },

  /** To 2D cartesian (C# `vecAsCartesian`). */
  toCartesian: (p: Polar): Vec2 => [p.r * Math.cos(p.phi), p.r * Math.sin(p.phi)],

  /** Lerp in polar space; the angular delta takes the short way around (C# `oLerp`). */
  lerp(a: Polar, b: Polar, t: number): Polar {
    const deltaPhi = rad.normalizedSigned(rad.sub(b.phi, a.phi));
    return polar.create(a.r + t * (b.r - a.r), rad.add(a.phi, rad.scale(deltaPhi, t)));
  },
} as const;

/** `Cylindrical` factories and conversions. */
export const cylindrical = {
  /** Validated constructor (C# `Cylindrical(fR, rPhi, fZ)`). */
  create(r: number, phi: Rad, z: number): Cylindrical {
    checkRadius(r);
    checkPhi(phi);
    if (!Number.isFinite(z)) throw invalid(`Z must be finite, got ${z}.`);
    return { r, phi, z };
  },

  /** From a polar coordinate plus height (C# `Cylindrical(Polar, fZ)`). */
  fromPolar: (p: Polar, z: number): Cylindrical => cylindrical.create(p.r, p.phi, z),

  /** From a cartesian point (C# `Cylindrical(Vector3)`). */
  fromCartesian(v: Vec3): Cylindrical {
    const p = polar.fromCartesian(vec3.stripZ(v));
    return cylindrical.create(p.r, p.phi, v[2]);
  },

  /** From a spherical coordinate (C# `Cylindrical(Spherical)`). */
  fromSpherical: (s: Spherical): Cylindrical => cylindrical.fromCartesian(spherical.toCartesian(s)),

  /** To cartesian (C# `vecAsCartesian`). */
  toCartesian: (c: Cylindrical): Vec3 => [c.r * Math.cos(c.phi), c.r * Math.sin(c.phi), c.z],

  /** Lerp in cylindrical space; angular delta short-way-around (C# `oLerp`). */
  lerp(a: Cylindrical, b: Cylindrical, t: number): Cylindrical {
    const deltaPhi = rad.normalizedSigned(rad.sub(b.phi, a.phi));
    return cylindrical.create(
      a.r + t * (b.r - a.r),
      rad.add(a.phi, rad.scale(deltaPhi, t)),
      a.z + t * (b.z - a.z),
    );
  },
} as const;

/** `Spherical` factories and conversions. */
export const spherical = {
  /** Validated constructor (C# `Spherical(fR, rPhi, rTheta)`; theta must lie in [0, π]). */
  create(r: number, phi: Rad, theta: Rad): Spherical {
    checkRadius(r);
    checkPhi(phi);
    if (!Number.isFinite(theta) || theta < 0 || theta > rad.half) {
      throw invalid(`Theta must be finite and in the range [0, π], got ${theta}.`);
    }
    return { r, phi, theta };
  },

  /** From a cartesian point (C# `Spherical(Vector3)`; angles undefined at the origin → zeros). */
  fromCartesian(v: Vec3): Spherical {
    if (!vec3.isFinite(v)) throw invalid(`Cartesian vector must be finite, got (${v[0]}, ${v[1]}, ${v[2]}).`);
    const r = vec3.length(v);
    if (scalar.almostZero(r)) return { r: 0, phi: rad.zero, theta: rad.zero };
    return { r, phi: rad.atan2(v[1], v[0]), theta: rad.acosClamped(v[2] / r) };
  },

  /** From a cylindrical coordinate (C# `Spherical(Cylindrical)`). */
  fromCylindrical: (c: Cylindrical): Spherical => spherical.fromCartesian(cylindrical.toCartesian(c)),

  /** To cartesian (C# `vecAsCartesian`). */
  toCartesian(s: Spherical): Vec3 {
    const sinTheta = Math.sin(s.theta);
    return [s.r * sinTheta * Math.cos(s.phi), s.r * sinTheta * Math.sin(s.phi), s.r * Math.cos(s.theta)];
  },

  /** Lerp in spherical space; azimuthal delta short-way-around (C# `oLerp`). */
  lerp(a: Spherical, b: Spherical, t: number): Spherical {
    const deltaPhi = rad.normalizedSigned(rad.sub(b.phi, a.phi));
    return spherical.create(
      a.r + t * (b.r - a.r),
      rad.add(a.phi, rad.scale(deltaPhi, t)),
      rad.add(a.theta, rad.scale(rad.sub(b.theta, a.theta), t)),
    );
  },
} as const;
