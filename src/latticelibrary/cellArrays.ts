// Derived from LEAP71_LatticeLibrary — LatticeLibrary/CellArrays/
// {RegularCellArray,ConformalCellArray}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// The per-corner noise reseeds a fresh random stream from the corner's
// coordinates, so shared corners of adjacent cells deform identically. The C#
// seed `iX * iY * iZ` collides wildly (any zero coordinate → seed 0) and
// overflows int — ported verbatim via Math.imul. The seeded corpus is
// self-referential (createRandom, not C# Random), per the blueprint rule.

import { BaseBox } from '../shapekernel/baseBox.ts';
import { BaseLens } from '../shapekernel/baseLens.ts';
import { BasePipeSegment } from '../shapekernel/basePipe.ts';
import { localFrame } from '../shapekernel/localFrame.ts';
import { LineModulation, SurfaceModulation } from '../shapekernel/modulations.ts';
import { createRandom, uf } from '../shapekernel/uf.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { CuboidCell, type UnitCell } from './unitCells.ts';

/** A collection of unit cells (C# `ICellArray`). */
export interface CellArray {
  unitCells(): readonly UnitCell[];
}

/** C# `vecGetCorner`: coordinate-seeded noise, shared by both regular arrays. */
function noisyCorner(
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  noiseLevel: number,
): Vec3 {
  const iX = Math.trunc(x * 1000);
  const iY = Math.trunc(y * 1000);
  const iZ = Math.trunc(z * 1000);
  // C# int multiplication wraps — Math.imul replicates the overflow.
  const random = createRandom(Math.imul(Math.imul(iX, iY), iZ));
  return [
    x + uf.randomLinear(-noiseLevel * dx, noiseLevel * dx, random),
    y + uf.randomLinear(-noiseLevel * dy, noiseLevel * dy, random),
    z + uf.randomLinear(-noiseLevel * dz, noiseLevel * dz, random),
  ];
}

/** The 8 cuboid corners at (x, y, z) with the C# corner winding 1-8. */
function cuboidAt(
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  noiseLevel: number,
): CuboidCell {
  return new CuboidCell([
    noisyCorner(x, y, z, dx, dy, dz, noiseLevel),
    noisyCorner(x, y + dy, z, dx, dy, dz, noiseLevel),
    noisyCorner(x + dx, y + dy, z, dx, dy, dz, noiseLevel),
    noisyCorner(x + dx, y, z, dx, dy, dz, noiseLevel),
    noisyCorner(x, y, z + dz, dx, dy, dz, noiseLevel),
    noisyCorner(x, y + dy, z + dz, dx, dy, dz, noiseLevel),
    noisyCorner(x + dx, y + dy, z + dz, dx, dy, dz, noiseLevel),
    noisyCorner(x + dx, y, z + dz, dx, dy, dz, noiseLevel),
  ]);
}

/**
 * Regular grid cell array housing the bounding box of the voxel field, with
 * customised x/y/z unit-cell dimensions. The noise level (0 for a perfectly
 * regular grid) is clamped to 0.3 as upstream (C# `RegularCellArray`).
 */
export class RegularCellArray implements CellArray {
  private readonly cells: UnitCell[] = [];

  constructor(voxels: Voxels, dx: number, dy: number, dz: number, noiseLevel = 0) {
    const level = Math.min(Math.abs(noiseLevel), 0.3);
    const { bounds } = voxels.properties();
    for (let x = bounds.min[0] - 0.5 * dx; x <= bounds.max[0] + 0.5 * dx; x += dx) {
      for (let y = bounds.min[1] - 0.5 * dy; y <= bounds.max[1] + 0.5 * dy; y += dy) {
        for (let z = bounds.min[2] - 0.5 * dz; z <= bounds.max[2] + 0.5 * dz; z += dz) {
          this.cells.push(cuboidAt(x, y, z, dx, dy, dz, level));
        }
      }
    }
  }

  unitCells(): readonly UnitCell[] {
    return this.cells;
  }
}

/**
 * A grid of just one unit cell, centred in XY and based at z = 0
 * (C# `RegularUnitCell`).
 */
export class RegularUnitCell implements CellArray {
  private readonly cells: UnitCell[];

  constructor(dx: number, dy: number, dz: number, noiseLevel = 0) {
    const level = Math.min(Math.abs(noiseLevel), 0.3);
    this.cells = [cuboidAt(-0.5 * dx, -0.5 * dy, 0, dx, dy, dz, level)];
  }

  unitCells(): readonly UnitCell[] {
    return this.cells;
  }
}

/** The three modulated demo shapes conformal arrays showcase (C# `ConformalShowcaseShapes`). */
export const conformalShowcaseShapes = {
  /** Modulated box, length 100 (C# `oGetBox_01`). */
  box01(): BaseBox {
    const box = new BaseBox(localFrame.identity, 100);
    box.setDepth(new LineModulation((lengthRatio: number) => 80 - 40 * Math.cos(3 * lengthRatio)));
    box.setWidth(new LineModulation((lengthRatio: number) => 60 + 20 * Math.cos(5 * lengthRatio)));
    return box;
  },

  /** Height-modulated lens (C# `oGetLens_01`). */
  lens01(): BaseLens {
    const lens = new BaseLens(localFrame.identity, 1, 20, 40);
    lens.setHeight(
      new SurfaceModulation((_phi: number, radiusRatio: number) => -20 + 20 * radiusRatio),
      new SurfaceModulation((_phi: number, radiusRatio: number) => 20 + 5 * Math.cos(2 * radiusRatio)),
    );
    return lens;
  },

  /** Radius- and phi-range-modulated pipe segment (C# `oGetSegment_01`). */
  segment01(): BasePipeSegment {
    const segment = new BasePipeSegment(localFrame.identity, {
      length: 100,
      innerRadius: 20,
      outerRadius: 40,
      startOrMid: new LineModulation(0),
      endOrRange: new LineModulation(
        (lengthRatio: number) => Math.PI - 0.45 * Math.PI * Math.cos(3 * lengthRatio),
      ),
      method: 'midRange',
    });
    const innerRadius = (_phi: number, lengthRatio: number): number => 20 + 10 * lengthRatio;
    segment.setRadius(
      new SurfaceModulation(innerRadius),
      new SurfaceModulation(
        (phi: number, lengthRatio: number) => innerRadius(phi, lengthRatio) + 15 + 5 * Math.cos(4 * phi),
      ),
    );
    return segment;
  },
} as const;

/**
 * Regular grid cell array conformal to a BaseBox, BaseLens or BasePipeSegment;
 * the cell count per dimension is explicit (C# `ConformalCellArray`, three
 * constructor overloads folded into one union parameter).
 */
export class ConformalCellArray implements CellArray {
  private readonly cells: UnitCell[] = [];

  constructor(
    shape: BaseBox | BaseLens | BasePipeSegment,
    numberInX: number,
    numberInY: number,
    numberInZ: number,
  ) {
    const point = (ix: number, iy: number, iz: number): Vec3 =>
      shape instanceof BaseBox
        ? // widthRatio/depthRatio span -1..1, lengthRatio 0..1 (C# vecGetInternalBoxPt).
          shape.surfacePoint((2 * ix) / numberInX - 1, (2 * iy) / numberInY - 1, iz / numberInZ)
        : // Lens: (heightRatio, phiRatio, radiusRatio); segment: (lengthRatio,
          // phiRatio, radiusRatio) — the same index mapping upstream.
          shape.surfacePoint(ix / numberInX, iz / numberInZ, iy / numberInY);
    for (let nx = 1; nx <= numberInX; nx += 1) {
      for (let ny = 1; ny <= numberInY; ny += 1) {
        for (let nz = 1; nz <= numberInZ; nz += 1) {
          // NOTE the conformal corner winding (02 = +x) differs from the
          // regular arrays' (02 = +y) — both orders are upstream's.
          this.cells.push(
            new CuboidCell([
              point(nx - 1, ny - 1, nz - 1),
              point(nx, ny - 1, nz - 1),
              point(nx, ny, nz - 1),
              point(nx - 1, ny, nz - 1),
              point(nx - 1, ny - 1, nz),
              point(nx, ny - 1, nz),
              point(nx, ny, nz),
              point(nx - 1, ny, nz),
            ]),
          );
        }
      }
    }
  }

  unitCells(): readonly UnitCell[] {
    return this.cells;
  }
}
