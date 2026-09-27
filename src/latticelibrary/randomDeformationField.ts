// Derived from LEAP71_LatticeLibrary — ImplicitLibrary/RandomDeformationField.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// The C# constructor's sub-cube loop exists only to preview wireframes and is
// dropped (headless surface, R16 rule); the grid/noise arrays and the
// trilinear lookup are ported verbatim. Randomness is an explicit
// RandomSource (self-referential seeded corpus), drawn in the same
// x-outer/z-inner grid order as upstream.

import type { RandomSource } from '../shapekernel/uf.ts';
import { uf } from '../shapekernel/uf.ts';
import type { Bounds, Vec3 } from '../types.ts';

/** Componentwise clamped lerp (C# `vecGetInter`). */
function interpolate(min: Vec3, max: Vec3, ratio: number): Vec3 {
  const r = Math.min(Math.max(ratio, 0), 1);
  return [min[0] + r * (max[0] - min[0]), min[1] + r * (max[1] - min[1]), min[2] + r * (max[2] - min[2])];
}

/**
 * Regular cuboid 3D grid with a random 3D value at each grid point and
 * tri-linear spatial interpolation for 3D modulations
 * (C# `RandomDeformationField`).
 */
export class RandomDeformationField {
  private readonly noiseVectors: Vec3[][][] = [];
  private readonly bounds: Bounds;
  private readonly xSamples: number;
  private readonly ySamples: number;
  private readonly zSamples: number;

  constructor(bounds: Bounds, resolution: number, minValue: number, maxValue: number, random: RandomSource) {
    this.bounds = bounds;
    this.xSamples = Math.trunc((bounds.max[0] - bounds.min[0]) / resolution) + 1;
    this.ySamples = Math.trunc((bounds.max[1] - bounds.min[1]) / resolution) + 1;
    this.zSamples = Math.trunc((bounds.max[2] - bounds.min[2]) / resolution) + 1;
    for (let ix = 0; ix <= this.xSamples; ix += 1) {
      const plane: Vec3[][] = [];
      for (let iy = 0; iy <= this.ySamples; iy += 1) {
        const row: Vec3[] = [];
        for (let iz = 0; iz <= this.zSamples; iz += 1) {
          row.push([
            uf.randomLinear(minValue, maxValue, random),
            uf.randomLinear(minValue, maxValue, random),
            uf.randomLinear(minValue, maxValue, random),
          ]);
        }
        plane.push(row);
      }
      this.noiseVectors.push(plane);
    }
  }

  /**
   * Tri-linear interpolation of the noise grid at the point, clamped to the
   * bounding box (C# `vecGetData`; the interpolated grid POSITION upstream
   * computes alongside is dead code and dropped). QUIRK kept: a query exactly
   * on the max face can index one row past the grid — upstream throws
   * IndexOutOfRange there when the division rounds to the sample count.
   */
  dataAt(pt: Vec3): Vec3 {
    const x = Math.min(Math.max(pt[0], this.bounds.min[0]), this.bounds.max[0]);
    const y = Math.min(Math.max(pt[1], this.bounds.min[1]), this.bounds.max[1]);
    const z = Math.min(Math.max(pt[2], this.bounds.min[2]), this.bounds.max[2]);

    const dx = (this.bounds.max[0] - this.bounds.min[0]) / this.xSamples;
    const dy = (this.bounds.max[1] - this.bounds.min[1]) / this.ySamples;
    const dz = (this.bounds.max[2] - this.bounds.min[2]) / this.zSamples;
    const lowerX = Math.trunc((x - this.bounds.min[0]) / dx);
    const lowerY = Math.trunc((y - this.bounds.min[1]) / dy);
    const lowerZ = Math.trunc((z - this.bounds.min[2]) / dz);

    const at = (ix: number, iy: number, iz: number): Vec3 => this.noiseVectors[ix]![iy]![iz]!;
    const xRatio = (x - (this.bounds.min[0] + dx * lowerX)) / dx;
    const yRatio = (y - (this.bounds.min[1] + dy * lowerY)) / dy;
    const zRatio = (z - (this.bounds.min[2] + dz * lowerZ)) / dz;

    const dir00 = interpolate(at(lowerX, lowerY, lowerZ), at(lowerX + 1, lowerY, lowerZ), xRatio);
    const dir10 = interpolate(at(lowerX, lowerY + 1, lowerZ), at(lowerX + 1, lowerY + 1, lowerZ), xRatio);
    const dir01 = interpolate(at(lowerX, lowerY, lowerZ + 1), at(lowerX + 1, lowerY, lowerZ + 1), xRatio);
    const dir11 = interpolate(
      at(lowerX, lowerY + 1, lowerZ + 1),
      at(lowerX + 1, lowerY + 1, lowerZ + 1),
      xRatio,
    );
    const dir0 = interpolate(dir00, dir10, yRatio);
    const dir1 = interpolate(dir01, dir11, yRatio);
    return interpolate(dir0, dir1, zRatio);
  }
}
