// Derived from LEAP71_LatticeLibrary — LatticeLibrary/BeamThickness/
// {ConstantBeamThickness,CellBasedBeamThickness,BoundaryBeamThickness,
// GlobalFuncBeamThickness}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R13); see NOTICE.

import { PicoGkError } from '../errors.ts';
import { uf } from '../shapekernel/uf.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import type { UnitCell } from './unitCells.ts';

/** Beam thickness for a given point in space (C# `IBeamThickness`). */
export interface BeamThickness {
  beamThickness(pt: Vec3): number;
  updateCell(cell: UnitCell): void;
  setBoundingVoxels(voxels: Voxels): void;
}

/** Constant thickness, independent of cell or boundary (C# `ConstantBeamThickness`). */
export class ConstantBeamThickness implements BeamThickness {
  private readonly thickness: number;

  constructor(thickness: number) {
    this.thickness = thickness;
  }

  beamThickness(_pt: Vec3): number {
    return this.thickness;
  }

  updateCell(_cell: UnitCell): void {}

  setBoundingVoxels(_voxels: Voxels): void {}
}

/**
 * Thickness from the point's position within the current unit cell:
 * min at the cell centre, max at the cell-diagonal radius
 * (C# `CellBasedBeamThickness`).
 */
export class CellBasedBeamThickness implements BeamThickness {
  private cell: UnitCell | undefined;
  private readonly minThickness: number;
  private readonly maxThickness: number;

  constructor(minThickness: number, maxThickness: number) {
    this.minThickness = minThickness;
    this.maxThickness = maxThickness;
  }

  updateCell(cell: UnitCell): void {
    this.cell = cell;
  }

  beamThickness(pt: Vec3): number {
    if (this.cell === undefined) {
      throw new PicoGkError('PICOGK_INVALID_ARGUMENT', 'No Unit Cell specified.');
    }
    const bounds = this.cell.cellBounding();
    const dist = vec3.length(vec3.sub(pt, this.cell.cellCentre()));
    const ratio = Math.min(Math.max(dist / (0.5 * vec3.length(vec3.sub(bounds.max, bounds.min))), 0), 1);
    return uf.transFixed(this.minThickness, this.maxThickness, ratio);
  }

  setBoundingVoxels(_voxels: Voxels): void {}
}

/**
 * Thickness from the distance to the bounding voxel surface: max on the
 * boundary, tanh-falling to min inside (C# `BoundaryBeamThickness`).
 */
export class BoundaryBeamThickness implements BeamThickness {
  private bounding: Voxels | undefined;
  private readonly minThickness: number;
  private readonly maxThickness: number;

  constructor(minThickness: number, maxThickness: number) {
    this.minThickness = minThickness;
    this.maxThickness = maxThickness;
  }

  beamThickness(pt: Vec3): number {
    if (this.bounding === undefined) {
      throw new PicoGkError('PICOGK_INVALID_ARGUMENT', 'No Boundary Voxels specified.');
    }
    const surface = this.bounding.closestPointOnSurface(pt);
    if (surface === null) {
      throw new PicoGkError('PICOGK_CALL_FAILED', 'No Closest Point found.');
    }
    return uf.transSmooth(this.maxThickness, this.minThickness, vec3.length(vec3.sub(surface, pt)), 15, 5);
  }

  updateCell(_cell: UnitCell): void {}

  setBoundingVoxels(voxels: Voxels): void {
    this.bounding = voxels;
  }
}

/**
 * Thickness from a global function of the point — upstream hard-codes
 * a ramp over x: ratio = clamp(0.02·x, 0, 1) (C# `GlobalFuncBeamThickness`).
 */
export class GlobalFuncBeamThickness implements BeamThickness {
  private readonly minThickness: number;
  private readonly maxThickness: number;

  constructor(minThickness: number, maxThickness: number) {
    this.minThickness = minThickness;
    this.maxThickness = maxThickness;
  }

  beamThickness(pt: Vec3): number {
    const ratio = Math.min(Math.max(0.02 * pt[0], 0), 1);
    return uf.transFixed(this.minThickness, this.maxThickness, ratio);
  }

  updateCell(_cell: UnitCell): void {}

  setBoundingVoxels(_voxels: Voxels): void {}
}
