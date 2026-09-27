// Derived from LEAP71_ShapeKernel — ShapeKernel/Splines/{TangentialControlSpline,
// ControlPointSpline, CylindricalControlSpline}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R4); see NOTICE.
//
// The BSpline basis recursion is ported verbatim (Cox-de-Boor with upstream's
// epsilon guards). One deliberate deviation: C# ControlPointSpline MUTATES the
// caller's control-point list in CLOSED mode (drops a duplicate endpoint,
// appends n-1 wrap points inside aGetKnotVector) — here the list is copied
// first; the rendered spline is identical.

import type { Frame } from '../numerics/frame.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import { vecOps } from './vecOperations.ts';

/** ShapeKernel `ISpline`: anything that renders to a point list. */
export interface Spline {
  points(samples?: number): Vec3[];
}

export type SplineEnds = 'open' | 'closed';

const EPSILON = 0.0000001; // C# m_fError

/** BSpline-based control point spline, open or closed ends (C# `ControlPointSpline`). */
export class ControlPointSpline implements Spline {
  private readonly controlPoints: Vec3[];
  private readonly degree: number;
  private readonly knots: number[];

  constructor(controlPoints: readonly Vec3[], degree = 2, ends: SplineEnds = 'open') {
    this.controlPoints = [...controlPoints];
    this.degree = degree;

    if (ends === 'closed') {
      // First and last control point must not coincide.
      const first = this.controlPoints[0]!;
      const last = this.controlPoints[this.controlPoints.length - 1]!;
      if (vec3.length(vec3.sub(first, last)) < EPSILON) this.controlPoints.pop();
      // Wrap: append n-1 leading control points (C# does this inside aGetKnotVector).
      const before = this.controlPoints.length;
      for (let i = 0; i < before - 1; i += 1) this.controlPoints.push(this.controlPoints[i]!);
      this.knots = this.knotVector(false);
    } else {
      this.knots = this.knotVector(true);
    }
  }

  /** Equally spaced knot vector; open splines clamp into [0, 1] (C# `aGetKnotVector`). */
  private knotVector(clamp: boolean): number[] {
    const controlPointCount = this.controlPoints.length;
    const knotCount = controlPointCount + this.degree + 1;
    const validRange = knotCount - this.degree - (this.degree + 1);
    const dR = 1 / validRange;
    const knots: number[] = [];
    for (let i = 0; i < knotCount; i += 1) {
      const value = -(dR * this.degree) + dR * i;
      knots.push(clamp ? Math.min(1, Math.max(0, value)) : value);
    }
    return knots;
  }

  /** Render with the given sample count (C# `aGetPoints`). */
  points(samples = 500): Vec3[] {
    const rendered: Vec3[] = [];
    for (let i = 0; i < samples; i += 1) {
      rendered.push(this.pointAt(i / (samples - 1)));
    }
    return rendered;
  }

  /** Sample dynamically at a length ratio (C# `vecGetPointAt`). */
  pointAt(lengthRatio: number): Vec3 {
    let pt: Vec3 = vec3.zero;
    for (let i = 0; i < this.controlPoints.length; i += 1) {
      const base = this.baseFunc(lengthRatio, i, this.degree);
      pt = vec3.add(pt, vec3.scale(this.controlPoints[i]!, base));
    }
    return pt;
  }

  /** Cox-de-Boor basis recursion (C# `fBaseFunc`). */
  private baseFunc(lengthRatio: number, controlPoint: number, degree: number): number {
    const knots = this.knots;
    if (degree === 0) {
      const lastKnot = knots[knots.length - 1]!;
      if (
        (lengthRatio >= knots[controlPoint]! && lengthRatio < knots[controlPoint + 1]!) ||
        (Math.abs(lengthRatio - knots[controlPoint + 1]!) < EPSILON &&
          Math.abs(lengthRatio - lastKnot) < EPSILON)
      ) {
        return 1;
      }
      return 0;
    }
    let value = 0;
    if (Math.abs(knots[controlPoint + degree]! - knots[controlPoint]!) > EPSILON) {
      value +=
        ((lengthRatio - knots[controlPoint]!) / (knots[controlPoint + degree]! - knots[controlPoint]!)) *
        this.baseFunc(lengthRatio, controlPoint, degree - 1);
    }
    if (Math.abs(knots[controlPoint + degree + 1]! - knots[controlPoint + 1]!) > EPSILON) {
      value +=
        ((knots[controlPoint + degree + 1]! - lengthRatio) /
          (knots[controlPoint + degree + 1]! - knots[controlPoint + 1]!)) *
        this.baseFunc(lengthRatio, controlPoint + 1, degree - 1);
    }
    return value;
  }
}

export interface TangentOptions {
  startTangentStrength?: number;
  endTangentStrength?: number;
  relativeStartStrength?: boolean;
  relativeEndStrength?: boolean;
}

/** Cubic-feel connector between two points/frames with tangent control (C# `TangentialControlSpline`). */
export class TangentialControlSpline implements Spline {
  private readonly bspline: ControlPointSpline;

  constructor(start: Vec3, end: Vec3, startDir: Vec3, endDir: Vec3, options: TangentOptions = {}) {
    const span = vec3.length(vec3.sub(start, end));
    let startStrength = options.startTangentStrength ?? 0.3 * span;
    let endStrength = options.endTangentStrength ?? 0.3 * span;
    if (options.relativeStartStrength) startStrength *= span;
    if (options.relativeEndStrength) endStrength *= span;

    const pt2 = vec3.add(start, vec3.scale(vec3.safeNormalized(startDir), startStrength));
    const pt3 = vec3.sub(end, vec3.scale(vec3.safeNormalized(endDir), endStrength));
    this.bspline = new ControlPointSpline([start, pt2, pt3, end]);
  }

  /** The frame-to-frame form: positions + local Z directions (the C# frame ctor). */
  static betweenFrames(
    startFrame: Frame,
    endFrame: Frame,
    options: TangentOptions = {},
  ): TangentialControlSpline {
    return new TangentialControlSpline(startFrame.pos, endFrame.pos, startFrame.lz, endFrame.lz, options);
  }

  points(samples = 500): Vec3[] {
    return this.bspline.points(samples);
  }
}

export type CylindricalDirection = 'radial' | 'tangential' | 'z';

/** Step-wise cylindrical path builder (C# `CylindricalControlSpline`). */
export class CylindricalControlSpline implements Spline {
  private readonly controlPoints: Vec3[];

  constructor(start: Vec3) {
    this.controlPoints = [start];
  }

  /** Append a step relative to the last position (C# `AddRelativeStep`). */
  addRelativeStep(direction: CylindricalDirection, stepLength: number): void {
    const last = this.controlPoints[this.controlPoints.length - 1]!;
    if (direction === 'z') {
      this.controlPoints.push(vec3.add(last, vec3.scale(vec3.unitZ, stepLength)));
    } else if (direction === 'radial') {
      this.controlPoints.push(vec3.add(last, vec3.scale(vecOps.planarDir(last), stepLength)));
    } else {
      const tangential = vec3.cross(vec3.unitZ, vecOps.planarDir(last));
      this.controlPoints.push(vec3.add(last, vec3.scale(tangential, stepLength)));
    }
  }

  /** Append a step to an absolute radius or z (C# `AddAbsoluteStep`; tangential has no absolute form). */
  addAbsoluteStep(direction: Exclude<CylindricalDirection, 'tangential'>, newValue: number): void {
    const last = this.controlPoints[this.controlPoints.length - 1]!;
    if (direction === 'z') {
      this.controlPoints.push(vecOps.setZ(last, newValue));
    } else {
      this.controlPoints.push(vecOps.setRadius(last, newValue));
    }
  }

  points(samples = 500): Vec3[] {
    return new ControlPointSpline(this.controlPoints).points(samples);
  }
}
