// Derived from LEAP71_ShapeKernel — ShapeKernel/Utilities/{UsefulFormulas,
// SuperShapes, PolygonalShapes}.cs (the three partials of the C# `Uf` class)
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R4); see NOTICE.
//
// Transitions, randomness, fibonacci distributions, supershapes and polygon
// radii. C# `Random` becomes an explicit `RandomSource` — `createRandom(seed)`
// is the reproducible form (mulberry32; the seeded corpus is self-referential,
// not C#-sequence-matching — blueprint risk #4); omitting it uses a shared
// non-reproducible default, as upstream. `Uf.Wait` (thread sleep) and the
// obsolete `fLimitValue` are not reproduced.

import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import { ControlPointSpline } from './splines.ts';

/** A uniform [0, 1) source (the C# `Random.NextDouble` role). */
export type RandomSource = () => number;

/** Reproducible mulberry32 stream from a 32-bit seed. */
export function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const defaultRandom: RandomSource = Math.random;

export type SuperShapePreset = 'round' | 'hex' | 'quad' | 'tri';
export type PolygonPreset = 'hex' | 'quad' | 'tri';

/** The C# fTransFixed transition BSpline, built once (upstream caches it statically). */
let transitionSpline: ControlPointSpline | undefined;

/** ShapeKernel `Uf` (the "useful formulas" grab-bag). */
export const uf = {
  /** BSpline-eased transition between two values at position s in 0..1 (C# `fTransFixed`). */
  transFixed(value1: number, value2: number, s: number): number {
    transitionSpline ??= new ControlPointSpline([
      [0, 0, 0],
      [0, 0, 0.5],
      [1, 0, 0.5],
      [1, 0, 1],
    ]);
    const ratio = transitionSpline.pointAt(s)[0];
    return value1 + ratio * (value2 - value1);
  },

  /** Component-wise transFixed between two points (C# `vecTransFixed`). */
  vecTransFixed: (pt1: Vec3, pt2: Vec3, s: number): Vec3 => [
    uf.transFixed(pt1[0], pt2[0], s),
    uf.transFixed(pt1[1], pt2[1], s),
    uf.transFixed(pt1[2], pt2[2], s),
  ],

  /** tanh-smoothed transition between two values (C# `fTransSmooth`). */
  transSmooth(value1: number, value2: number, s: number, transitionS: number, smooth: number): number {
    const blend = 0.5 + 0.5 * Math.tanh((s - transitionS) / smooth);
    return value1 * (1 - blend) + value2 * blend;
  },

  /** tanh-smoothed transition between two points (C# `vecTransSmooth`). */
  vecTransSmooth(pt1: Vec3, pt2: Vec3, s: number, transitionS: number, smooth: number): Vec3 {
    const blend = 0.5 + 0.5 * Math.tanh((s - transitionS) / smooth);
    return vec3.add(vec3.scale(pt1, 1 - blend), vec3.scale(pt2, blend));
  },

  /** Box-Muller gaussian sample (C# `fGetRandomGaussian`). */
  randomGaussian(mean: number, stdDev: number, random: RandomSource = defaultRandom): number {
    const x1 = 1 - random();
    const x2 = 1 - random();
    const y1 = Math.sqrt(-2 * Math.log(x1)) * Math.cos(2 * Math.PI * x2);
    return y1 * stdDev + mean;
  },

  /** Uniform sample in [min, max) (C# `fGetRandomLinear`). */
  randomLinear: (min: number, max: number, random: RandomSource = defaultRandom): number =>
    min + (max - min) * random(),

  /** Fair coin (C# `bGetRandomBool`). */
  randomBool: (random: RandomSource = defaultRandom): boolean => random() > 0.5,

  /** Fibonacci-distributed points in a 2D disc (C# `aGetFibonacciCirlePoints`). */
  fibonacciCirclePoints(outerRadius: number, samples: number): Vec3[] {
    const points: Vec3[] = [];
    for (let i = 0; i < samples; i += 1) {
      const k = i + 0.5;
      const r = Math.sqrt(k / samples);
      const phi = Math.PI * (1 + Math.sqrt(5)) * k;
      points.push([r * outerRadius * Math.cos(phi), r * outerRadius * Math.sin(phi), 0]);
    }
    return points;
  },

  /** Fibonacci-distributed points on a 3D sphere surface (C# `aGetFibonacciSpherePoints`). */
  fibonacciSpherePoints(outerRadius: number, samples: number): Vec3[] {
    const points: Vec3[] = [];
    for (let i = 0; i < samples; i += 1) {
      const k = i + 0.5;
      const phi = Math.acos(1 - (2 * k) / samples);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      points.push([
        outerRadius * Math.cos(theta) * Math.sin(phi),
        outerRadius * Math.sin(theta) * Math.sin(phi),
        outerRadius * Math.cos(phi),
      ]);
    }
    return points;
  },

  /** Superformula radius at a polar angle, reference radius 1 (C# `fGetSuperShapeRadius` custom form). */
  superShapeRadius: (phi: number, m: number, n1: number, n2: number, n3: number): number =>
    Math.pow(
      Math.pow(Math.abs(Math.cos(0.25 * m * phi)), n2) + Math.pow(Math.abs(Math.sin(0.25 * m * phi)), n3),
      -(1 / n1),
    ),

  /** Superformula radius from a preset (C# preset overload). */
  superShapeRadiusPreset(phi: number, preset: SuperShapePreset): number {
    if (preset === 'hex') return uf.superShapeRadius(phi, 6, 2, 1.2, 1.2);
    if (preset === 'quad') return uf.superShapeRadius(phi, 4, 20, 15, 15);
    if (preset === 'tri') return uf.superShapeRadius(phi, 3, 3, 4, 4);
    return 1; // round
  },

  /** Regular-polygon radius at a polar angle, inscribed in the unit circle (C# `fGetPolygonRadius`). */
  polygonRadius(phi: number, m: number): number {
    const dPhi = phi % ((2 * Math.PI) / m);
    return Math.cos(Math.PI / m) / Math.cos(dPhi - Math.PI / m);
  },

  /** Regular-polygon radius from a preset (C# preset overload). */
  polygonRadiusPreset(phi: number, preset: PolygonPreset): number {
    if (preset === 'hex') return uf.polygonRadius(phi, 6);
    if (preset === 'quad') return uf.polygonRadius(phi, 4);
    return uf.polygonRadius(phi, 3); // tri
  },
} as const;
