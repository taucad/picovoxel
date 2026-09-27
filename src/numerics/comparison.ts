// Numerics foundation.
// Ports PicoGK Numerics/Comparison.cs: the tolerance constants and fuzzy scalar
// comparisons that epsilon-discipline the rest of the geometry layer. Vector
// variants live on `vec2`/`vec3` (vector.ts). Semantics are ported, not
// bit-width — C# computes in float32, we compute in float64 (strictly more
// precise for authoring math; parity gates are closed-form).

/** Default tolerances for fuzzy comparisons (C# `PicoGK.Numerics.Tolerances`). */
export const tolerances = {
  /** Default tolerance for fuzzy comparisons (`Tolerances.fDef`). */
  def: 1e-6,
  /** `Tolerances.fDefSquared` — for squared-distance comparisons. */
  defSquared: 1e-6 * 1e-6,
  /** Value regarded as zero in fuzzy zero checks (`Tolerances.fZero`). */
  zero: 1e-8,
  /** `Tolerances.fZeroSquared` — squared variant. */
  zeroSquared: 1e-8 * 1e-8,
} as const;

/** Fuzzy scalar comparisons (C# `ComparisonExtensions` on `float`). */
export const scalar = {
  /**
   * Fuzzy equality with both an absolute and a relative tolerance
   * (C# `float.bAlmostEqual`): equal when exactly equal, within `absTol`,
   * or within `relTol` of the larger magnitude.
   */
  almostEqual(a: number, b: number, absTol = tolerances.def, relTol = tolerances.def): boolean {
    if (a === b) return true;
    const diff = Math.abs(a - b);
    if (diff <= absTol) return true;
    return diff <= Math.max(Math.abs(a), Math.abs(b)) * relTol;
  },

  /** `a <= b + tol` (C# `bAlmostLessOrEqual`). */
  almostLessOrEqual(a: number, b: number, tol = tolerances.def): boolean {
    return a <= b + tol;
  },

  /** `a >= b - tol` (C# `bAlmostMoreOrEqual`). */
  almostMoreOrEqual(a: number, b: number, tol = tolerances.def): boolean {
    return a >= b - tol;
  },

  /** Fuzzy zero test (C# `bAlmostZero`). */
  almostZero(f: number, zero = tolerances.zero): boolean {
    return Math.abs(f) <= zero;
  },
} as const;
