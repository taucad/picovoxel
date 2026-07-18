// Derived from LEAP71_LatticeLibrary — LatticeLibrary/UnitCells/CuboidCell.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R13); see NOTICE.
//
// The C# `IUnitCell.PreviewUnitCell` (viewer wireframes) is not on this
// headless surface — same rule as the shapekernel port's dropped
// Visualizations layer (R16).

import type { Bounds, Vec3 } from '../types.ts';

/** A lattice unit cell (C# `IUnitCell`, preview dropped). */
export interface UnitCell {
  cornerPoints(): readonly Vec3[];
  cellCentre(): Vec3;
  cellBounding(): Bounds;
}

/**
 * Simple unit cell with 8 corner points in the shape of a cuboid:
 * lower corners 1-4, upper corners 5-8 (C# `CuboidCell`).
 */
export class CuboidCell implements UnitCell {
  private readonly corners: readonly Vec3[];
  private readonly centre: Vec3;
  private readonly bounds: Bounds;

  constructor(corners: readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3]) {
    this.corners = corners;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const corner of corners) {
      sumX += corner[0];
      sumY += corner[1];
      sumZ += corner[2];
      if (corner[0] > maxX) maxX = corner[0];
      if (corner[1] > maxY) maxY = corner[1];
      if (corner[2] > maxZ) maxZ = corner[2];
      if (corner[0] < minX) minX = corner[0];
      if (corner[1] < minY) minY = corner[1];
      if (corner[2] < minZ) minZ = corner[2];
    }
    this.centre = [sumX / corners.length, sumY / corners.length, sumZ / corners.length];
    this.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  cornerPoints(): readonly Vec3[] {
    return this.corners;
  }

  cellCentre(): Vec3 {
    return this.centre;
  }

  cellBounding(): Bounds {
    return this.bounds;
  }
}
