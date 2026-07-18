// Derived from LEAP71_ShapeKernel — ShapeKernel/Modulations/{LineModulation(1D),
// SurfaceModulation(2D)}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R5); see NOTICE.
//
// Modulations are the dimension-varying inputs of every base shape. The C#
// operator overloads (`mod + mod`, `mod - mod`, `f * mod`) become the
// `add`/`sub`/`scale` methods — the one visible API-shape change (Finding 7).
// The image-based SurfaceModulation form is viewer/Skia-bound and not ported.

import type { Vec3 } from '../types.ts';

export type RatioFunc = (ratio: number) => number;
export type SurfaceRatioFunc = (phi: number, lengthRatio: number) => number;
export type ModulationCoord = 'x' | 'y' | 'z';
export type ModulationLine = 'first' | 'second';

const coordOf = (pt: Vec3, coord: ModulationCoord): number =>
  coord === 'x' ? pt[0] : coord === 'y' ? pt[1] : pt[2];

/** 1D modulation: constant, function, or interpolated discrete points (C# `LineModulation`). */
export class LineModulation {
  /** The constant value when built from one (C# public `m_fConstValue`). */
  readonly constValue: number = 0;
  private readonly func: RatioFunc;

  constructor(value: number | RatioFunc) {
    if (typeof value === 'number') {
      this.constValue = value;
      this.func = () => this.constValue;
    } else {
      this.func = value;
    }
  }

  /**
   * From a discrete point list: `axis` picks the 0..1 parameter coordinate,
   * `values` the value coordinate; x must ascend, ends are pinned flat
   * (C# `LineModulation(aDiscretePoints, eValues, eAxis)`).
   */
  static fromPoints(points: readonly Vec3[], values: ModulationCoord, axis: ModulationCoord): LineModulation {
    const xValues: number[] = [coordOf(points[0]!, axis)];
    const yValues: number[] = [coordOf(points[0]!, values)];
    for (let i = 1; i < points.length; i += 1) {
      const x = coordOf(points[i]!, axis);
      if (x > xValues[xValues.length - 1]!) {
        xValues.push(x);
        yValues.push(coordOf(points[i]!, values));
      }
    }
    if (xValues[0]! > 0) {
      xValues.unshift(0);
      yValues.unshift(yValues[0]!);
    }
    if (xValues[xValues.length - 1]! < 1) {
      xValues.push(1);
      yValues.push(yValues[yValues.length - 1]!);
    }
    return new LineModulation((ratio: number) => {
      const x = Math.min(1, Math.max(0, ratio));
      // Lower-bound search — equivalent to C# BinarySearch + complement.
      let idx = xValues.length;
      let lo = 0;
      let hi = xValues.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (xValues[mid]! >= x) {
          idx = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const upper = Math.min(idx, xValues.length - 1);
      const lower = Math.max(upper - 1, 0);
      const lowerX = xValues[lower]!;
      const upperX = xValues[upper]!;
      if (upperX === lowerX) return yValues[lower]!;
      const lr = (x - lowerX) / (upperX - lowerX);
      return yValues[lower]! + lr * (yValues[upper]! - yValues[lower]!);
    });
  }

  /** The modulation value at a 0..1 ratio (C# `fGetModulation`). */
  modulation(ratio: number): number {
    return this.func(ratio);
  }

  /** Sum of two modulations (C# `operator +`). */
  add(other: LineModulation): LineModulation {
    return new LineModulation((r: number) => this.modulation(r) + other.modulation(r));
  }

  /** Difference of two modulations (C# `operator -`). */
  sub(other: LineModulation): LineModulation {
    return new LineModulation((r: number) => this.modulation(r) - other.modulation(r));
  }

  /** Scaled modulation (C# `operator *`). */
  scale(factor: number): LineModulation {
    return new LineModulation((r: number) => factor * this.modulation(r));
  }
}

/** Bundles a normalized line modulation with a physical length (C# `Distribution`). */
export class Distribution {
  readonly totalLength: number;
  readonly modulation: LineModulation;

  constructor(totalLength: number, modulation: LineModulation) {
    this.totalLength = totalLength;
    this.modulation = modulation;
  }
}

/** A Distribution describing contours of rotationally symmetric objects (C# `GenericContour`). */
export class GenericContour extends Distribution {}

/** 2D modulation over (phi, lengthRatio) (C# `SurfaceModulation`; the image form is not ported). */
export class SurfaceModulation {
  private readonly func: SurfaceRatioFunc;

  constructor(value: number | SurfaceRatioFunc) {
    if (typeof value === 'number') {
      this.func = () => value;
    } else {
      this.func = value;
    }
  }

  /** Lift a 1D modulation: `line` picks which argument it reads (C# `SurfaceModulation(oLineModulation, eLine)`). */
  static fromLineModulation(lineModulation: LineModulation, line: ModulationLine = 'second'): SurfaceModulation {
    return new SurfaceModulation((phi: number, lengthRatio: number) =>
      line === 'first' ? lineModulation.modulation(phi) : lineModulation.modulation(lengthRatio),
    );
  }

  /** The modulation value at the given ratios (C# `fGetModulation`). */
  modulation(phi: number, lengthRatio: number): number {
    return this.func(phi, lengthRatio);
  }

  /** Sum of two modulations (C# `operator +`). */
  add(other: SurfaceModulation): SurfaceModulation {
    return new SurfaceModulation((p: number, l: number) => this.modulation(p, l) + other.modulation(p, l));
  }

  /** Difference of two modulations (C# `operator -`). */
  sub(other: SurfaceModulation): SurfaceModulation {
    return new SurfaceModulation((p: number, l: number) => this.modulation(p, l) - other.modulation(p, l));
  }

  /** Scaled modulation (C# `operator *`). */
  scale(factor: number): SurfaceModulation {
    return new SurfaceModulation((p: number, l: number) => factor * this.modulation(p, l));
  }
}
