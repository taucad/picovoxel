// Numerics foundation.
// Ports PicoGK Numerics/Angles.cs. `Rad` is a branded number: compile-time
// discipline against the degree/radian bug class at zero runtime cost. Because
// a Rad IS a number, `Math.sin(r)`, comparisons and arithmetic work natively —
// the C# operator overloads and fSin/fCos/fTan wrappers need no port. Arithmetic
// widens the type back to `number`; the `rad.add`-style helpers keep chains
// branded. `Overhang` follows the same pattern over a validated 0..1 severity.

import { PicoError } from '../errors.ts';
import { tolerances } from './comparison.ts';

declare const radBrand: unique symbol;
/** An angle in radians (C# `PicoGK.Numerics.Rad`). Branded: plain numbers must pass through `rad.fromRad`/`rad.fromDeg`. */
export type Rad = number & { readonly [radBrand]: true };

declare const overhangBrand: unique symbol;
/** Normalized overhang severity 0..1 (C# `PicoGK.Numerics.Overhang`). 0 = vertical/self-supporting, 0.5 = 45º, 1 = horizontal. */
export type Overhang = number & { readonly [overhangBrand]: true };

/** 2π (C# `Rad.TwoPi`). */
export const TWO_PI = Math.PI * 2;

const asRad = (f: number): Rad => f as Rad;

/**
 * IEEE-754 remainder (C# `MathF.IEEERemainder`): `x - y*n` where `n` is the
 * integer nearest `x/y`, ties to even. `%` truncates instead, which would put
 * `rad.normalizedSigned` on the wrong side of ±π for half the range.
 */
function ieeeRemainder(x: number, y: number): number {
  const q = x / y;
  const floor = Math.floor(q);
  const fraction = q - floor;
  let n: number;
  if (fraction > 0.5) n = floor + 1;
  else if (fraction < 0.5) n = floor;
  else n = floor % 2 === 0 ? floor : floor + 1; // tie: round half to even
  return x - y * n;
}

/** `Rad` factories, constants and helpers. */
export const rad = {
  /** 0º (C# `Rad.Zero` / `Rad.Deg0`). */
  zero: asRad(0),
  /** 360º (C# `Rad.Full` / `Rad.Deg360`). */
  full: asRad(TWO_PI),
  /** 180º (C# `Rad.Half` / `Rad.Deg180`). */
  half: asRad(TWO_PI / 2),
  /** 90º (C# `Rad.Quarter` / `Rad.Deg90`). */
  quarter: asRad(TWO_PI / 4),
  /** 45º (C# `Rad.Deg45`). */
  deg45: asRad(TWO_PI / 8),

  /** Brand a radians value (C# `rFromRad` / the explicit float→Rad cast). */
  fromRad: asRad,

  /** From degrees (C# `rFromDeg`). */
  fromDeg: (degrees: number): Rad => asRad((degrees * TWO_PI) / 360),

  /** From a normalized 0..1 value mapped to 0..360º, clamped (C# `rFromNormalized`). */
  fromNormalized(normalized: number): Rad {
    if (normalized <= 0) return rad.zero;
    if (normalized >= 1) return rad.full;
    return asRad(TWO_PI * normalized);
  },

  /** The angle in degrees (C# `fDeg`). */
  deg: (r: Rad): number => (r * 360) / TWO_PI,

  /** Normalize to -π..+π (C# `rNormalizedSigned`; 0 for exact multiples of 2π). */
  normalizedSigned(r: Rad): Rad {
    const f = ieeeRemainder(r, TWO_PI);
    if (f === 0) return rad.zero;
    return asRad(f);
  },

  /** Normalize to [0, 2π) (C# `rNormalizedPositive`). */
  normalizedPositive(r: Rad): Rad {
    let f = r % TWO_PI;
    if (f < 0) f += TWO_PI;
    if (f === 0) return rad.zero;
    return asRad(f);
  },

  /** Fuzzy equality (C# `bAlmostEqual`). */
  almostEqual: (a: Rad, b: Rad, toleranceRad = tolerances.def): boolean => Math.abs(a - b) <= toleranceRad,

  /** Fuzzy equality of the normalized angle — 0º == 360º == 720º (C# `bAlmostEqualPeriodic`). */
  almostEqualPeriodic: (a: Rad, b: Rad, toleranceRad = tolerances.def): boolean =>
    Math.abs(rad.normalizedSigned(asRad(a - b))) <= toleranceRad,

  /** Quadrant-correct angle from +X (C# `rAtan2`). */
  atan2: (y: number, x: number): Rad => asRad(Math.atan2(y, x)),

  /** Arc tangent (C# `rAtan`). */
  atan: (f: number): Rad => asRad(Math.atan(f)),

  /** Arc cosine (C# `rAcos`). */
  acos: (f: number): Rad => asRad(Math.acos(f)),

  /** Arc cosine of the value clamped to [-1, 1] — for float-drifted geometry (C# `rAcosClamped`). */
  acosClamped: (f: number): Rad => asRad(Math.acos(Math.min(1, Math.max(-1, f)))),

  /** Arc sine (C# `rAsin`). */
  asin: (f: number): Rad => asRad(Math.asin(f)),

  /** Arc sine of the value clamped to [-1, 1] (C# `rAsinClamped`). */
  asinClamped: (f: number): Rad => asRad(Math.asin(Math.min(1, Math.max(-1, f)))),

  // Branded arithmetic — C# operator equivalents that keep the Rad type.
  add: (a: Rad, b: Rad): Rad => asRad(a + b),
  sub: (a: Rad, b: Rad): Rad => asRad(a - b),
  scale: (r: Rad, f: number): Rad => asRad(r * f),
  div: (r: Rad, f: number): Rad => asRad(r / f),
  /** Dimensionless ratio of two angles (C# `Rad / Rad`). */
  ratio: (a: Rad, b: Rad): number => a / b,
  neg: (r: Rad): Rad => asRad(-(r as number)),
} as const;

function overhangOutOfRange(what: string, range: string, value: number): PicoError {
  return new PicoError(
    'PICO_INVALID_ARGUMENT',
    `${what} must be finite and in the range ${range}, got ${value}.`,
  );
}

const asOverhang = (f: number): Overhang => f as Overhang;

/** `Overhang` factories and accessors. Comparisons (`<`, `>`, C# `bExceeds`) work natively on the branded number. */
export const overhang = {
  /** No overhang — vertical, self-supporting (C# `uNone`). */
  none: asOverhang(0),
  /** Maximum overhang — horizontal (C# `uFull`). */
  full: asOverhang(1),

  /** From normalized severity 0..1 (C# `uFromNormalized`). */
  fromNormalized(f: number): Overhang {
    if (!Number.isFinite(f) || f < 0 || f > 1) throw overhangOutOfRange('Normalized overhang', '0..1', f);
    return asOverhang(f);
  },

  /** From percent 0..100 (C# `uFromPercent`). */
  fromPercent(f: number): Overhang {
    if (!Number.isFinite(f) || f < 0 || f > 100) throw overhangOutOfRange('Overhang percentage', '0..100', f);
    return asOverhang(f / 100);
  },

  /** From radians 0..π/2 (C# `uFromRad`). */
  fromRad(f: number): Overhang {
    if (!Number.isFinite(f) || f < 0 || f > Math.PI / 2)
      throw overhangOutOfRange('Overhang angle in rad', '0..π/2', f);
    return asOverhang(f / (Math.PI / 2));
  },

  /** From degrees 0..90 (C# `uFromDeg`). */
  fromDeg(f: number): Overhang {
    if (!Number.isFinite(f) || f < 0 || f > 90) throw overhangOutOfRange('Overhang angle', '0..90', f);
    return asOverhang(f / 90);
  },

  /**
   * From degrees measured from the horizontal plane — some 3D-printing vendors'
   * convention; avoid unless exchanging data with one (C# `uFromDegFromHorizontal`).
   */
  fromDegFromHorizontal(f: number): Overhang {
    if (!Number.isFinite(f) || f < 0 || f > 90) throw overhangOutOfRange('Overhang angle', '0..90', f);
    return asOverhang((90 - f) / 90);
  },

  /** Severity as percent 0..100 (C# `fPercent`). */
  percent: (u: Overhang): number => u * 100,

  /** Overhang angle in radians 0..π/2 (C# `fRad`). */
  rad: (u: Overhang): Rad => asRad((u * Math.PI) / 2),

  /** Overhang angle in degrees 0..90 (C# `fDeg`). */
  deg: (u: Overhang): number => u * 90,

  /** Degrees from horizontal — the inverted vendor convention (C# `fDegFromHorizontal`). */
  degFromHorizontal: (u: Overhang): number => 90 - u * 90,
} as const;
