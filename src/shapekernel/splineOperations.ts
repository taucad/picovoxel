// Derived from LEAP71_ShapeKernel — ShapeKernel/Utilities/SplineOperations.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R4); see NOTICE.
//
// Point-list plumbing: arc-length reparametrization, NURBS smoothing,
// frame/axis transforms and clustering. The C#-[Obsolete] frame helpers these
// wrap are `frame.ptToWorld`/`ptFromWorld` from picovoxel/numerics.

import { type Frame, frame } from '../numerics/frame.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { ControlPointSpline } from './splines.ts';
import { vecOps } from './vecOperations.ts';

/** ShapeKernel `SplineOperations` (static class → const object). */
export const splineOps = {
  /** Linearly interpolated points from start to end inclusive (C# `aGetLinearInterpolation`). */
  linearInterpolation(start: Vec3, end: Vec3, samples: number): Vec3[] {
    const points: Vec3[] = [];
    for (let i = 0; i < samples; i += 1) {
      points.push(vec3.lerp(start, end, i / (samples - 1)));
    }
    return points;
  },

  /** Each point snapped to the closest surface point of the target (C# `aGetSnappedSpline`). */
  snappedSpline: (points: readonly Vec3[], target: Voxels): Vec3[] =>
    // C# ignores the bool and uses the out param even on failure (zero vector).
    points.map((pt) => target.closestPointOnSurface(pt) ?? vec3.zero),

  /** Resample to a target count with constant spacing; endpoints preserved (C# count overload). */
  reparametrizedByCount(points: readonly Vec3[], targetSamples: number): Vec3[] {
    const lengths = splineOps.lengthsAtIndices(points);
    const spineLength = lengths[lengths.length - 1]!;
    const targetStep = spineLength / targetSamples;
    const resampled: Vec3[] = [points[0]!];
    for (let j = 1; j < targetSamples; j += 1) {
      const targetLength = targetStep * j;
      let upperIndex = 1;
      let upperLength = 0;
      for (; upperIndex < points.length; upperIndex += 1) {
        upperLength = lengths[upperIndex]!;
        if (upperLength >= targetLength) break;
      }
      const lowerIndex = upperIndex - 1;
      const lowerLength = lengths[lowerIndex]!;
      const dS = (targetLength - lowerLength) / (upperLength - lowerLength);
      resampled.push(vec3.lerp(points[lowerIndex]!, points[upperIndex]!, dS));
    }
    resampled.push(points[points.length - 1]!);
    return resampled;
  },

  /** Resample to a target spacing (min 10 samples, C# spacing overload). */
  reparametrizedBySpacing(points: readonly Vec3[], targetSpacing: number): Vec3[] {
    const targetSamples = Math.trunc(Math.max(10, splineOps.totalLength(points) / targetSpacing));
    return splineOps.reparametrizedByCount(points, targetSamples);
  },

  /** Cumulative arc length at each index (C# `aGetLengthsAtIndices`). */
  lengthsAtIndices(points: readonly Vec3[]): number[] {
    const lengths = [0];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += vec3.length(vec3.sub(points[i]!, points[i - 1]!));
      lengths.push(total);
    }
    return lengths;
  },

  /** Average spacing between consecutive points (C# `fGetAveragePointSpacing`). */
  averagePointSpacing: (points: readonly Vec3[]): number =>
    splineOps.totalLength(points) / (points.length - 1),

  /** Total arc length (C# `fGetTotalLength`). */
  totalLength(points: readonly Vec3[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += vec3.length(vec3.sub(points[i]!, points[i - 1]!));
    }
    return total;
  },

  /** Split at an index into two non-overlapping lists (C# `aSplitLists`). */
  splitAt: (points: readonly Vec3[], firstIndexOfSecond: number): [Vec3[], Vec3[]] => [
    points.slice(0, firstIndexOfSecond),
    points.slice(firstIndexOfSecond),
  ],

  /** Concatenate lists (C# `aCombineLists`). */
  combine: (lists: readonly (readonly Vec3[])[]): Vec3[] => lists.flat(),

  /** Every point rotated about the absolute Z axis (C# `aRotateListAroundZ`). */
  rotatedAroundZ: (points: readonly Vec3[], angle: number): Vec3[] =>
    points.map((pt) => vecOps.rotateAroundZ(pt, angle)),

  /** Every point translated (C# `aTranslateList`). */
  translated: (points: readonly Vec3[], shift: Vec3): Vec3[] => points.map((pt) => vec3.add(pt, shift)),

  /** Every point scaled about the origin (C# `aScaleList`). */
  scaled: (points: readonly Vec3[], factor: number): Vec3[] => points.map((pt) => vec3.scale(pt, factor)),

  /** NURBS smoothing via a degree-2 open BSpline (C# `aGetNURBSpline`). */
  nurbsSpline: (controlPoints: readonly Vec3[], samples: number): Vec3[] =>
    new ControlPointSpline(controlPoints, 2, 'open').points(samples),

  /** Linear oversampling with N samples per step (C# `aOverSampleList`). */
  overSampled(points: readonly Vec3[], samplesPerStep: number): Vec3[] {
    const out: Vec3[] = [];
    for (let i = 1; i < points.length; i += 1) {
      for (let j = 0; j < samplesPerStep; j += 1) {
        out.push(vec3.lerp(points[i - 1]!, points[i]!, j / samplesPerStep));
      }
    }
    out.push(points[points.length - 1]!);
    return out;
  },

  /** Every Nth point, end preserved (C# `aSubSampleList`). */
  subSampled(points: readonly Vec3[], sampleSize: number): Vec3[] {
    const out: Vec3[] = [];
    for (let i = 0; i < points.length; i += sampleSize) {
      out.push(points[i]!);
    }
    out.push(points[points.length - 1]!);
    return out;
  },

  /** Every point moved onto a frame's coordinate system (C# `aTranslateListOntoFrame`). */
  ontoFrame: (f: Frame, points: readonly Vec3[]): Vec3[] => points.map((pt) => frame.ptToWorld(f, pt)),

  /** Every point expressed relative to a frame (C# `aExpressListInFrame`). */
  inFrame: (f: Frame, points: readonly Vec3[]): Vec3[] => points.map((pt) => frame.ptFromWorld(f, pt)),

  /** Every point rotated about an arbitrary axis (C# `aRotateListAroundAxis`). */
  rotatedAroundAxis: (
    points: readonly Vec3[],
    deltaPhi: number,
    axis: Vec3,
    axisOrigin: Vec3 = vec3.zero,
  ): Vec3[] => points.map((pt) => vecOps.rotateAroundAxis(pt, deltaPhi, axis, axisOrigin)),

  /** Average of all positions (C# `vecGetAverage`). */
  average(points: readonly Vec3[]): Vec3 {
    let centre = vec3.zero;
    for (const pt of points) centre = vec3.add(centre, pt);
    return vec3.scale(centre, 1 / points.length);
  },

  /** The list point closest to `start` (C# `vecGetClosestPoint`). */
  closestPoint(points: readonly Vec3[], start: Vec3): Vec3 {
    let minDist = Number.MAX_VALUE;
    let near = vec3.zero;
    for (const pt of points) {
      const dist = vec3.distanceSquared(pt, start);
      if (dist < minDist) {
        minDist = dist;
        near = pt;
      }
    }
    return near;
  },

  /** Distance to the closest list point (C# `fGetDistanceToClosestPoint`). */
  distanceToClosestPoint(points: readonly Vec3[], start: Vec3): number {
    let minDist = Number.MAX_VALUE;
    for (const pt of points) {
      const dist = vec3.distanceSquared(pt, start);
      if (dist < minDist) minDist = dist;
    }
    return Math.sqrt(minDist);
  },

  /** Greedy clustering: keep points farther than the range from every kept point (C# `aGetClusteredPoints`). */
  clusteredPoints(points: readonly Vec3[], clusteringRange: number): Vec3[] {
    const rangeSquared = clusteringRange * clusteringRange;
    const clustered: Vec3[] = [points[0]!];
    for (let i = 1; i < points.length; i += 1) {
      const pt = points[i]!;
      const near = splineOps.closestPoint(clustered, pt);
      if (vec3.distanceSquared(near, pt) > rangeSquared) clustered.push(pt);
    }
    return clustered;
  },
} as const;
