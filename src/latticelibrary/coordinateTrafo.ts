// Derived from LEAP71_LatticeLibrary — ImplicitLibrary/CoordinateTrafo.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// C# `Apply(out fX, out fY, out fZ, vecPt)` becomes `apply(pt): Vec3`.

import { uf } from '../shapekernel/uf.ts';
import { vecOps } from '../shapekernel/vecOperations.ts';
import type { Vec3 } from '../types.ts';

/** Coordinate transformation ahead of a raw TPMS lookup (C# `ICoordinateTrafo`). */
export interface CoordinateTrafo {
  apply(pt: Vec3): Vec3;
}

/** Per-axis division by the unit sizes (C# `ScaleTrafo`). */
export class ScaleTrafo implements CoordinateTrafo {
  private readonly unitX: number;
  private readonly unitY: number;
  private readonly unitZ: number;

  constructor(unitX: number, unitY: number, unitZ: number) {
    this.unitX = unitX;
    this.unitY = unitY;
    this.unitZ = unitZ;
  }

  apply(pt: Vec3): Vec3 {
    return [pt[0] / this.unitX, pt[1] / this.unitY, pt[2] / this.unitZ];
  }
}

/**
 * Z-dependent scale ramp 20→5 over z 0..50; upstream pins the output z to a
 * constant 10, flattening the pattern along Z — ported verbatim
 * (C# `FunctionalScaleTrafo`).
 */
export class FunctionalScaleTrafo implements CoordinateTrafo {
  apply(pt: Vec3): Vec3 {
    const ratio = Math.min(Math.max(pt[2] / 50, 0), 1);
    // C# evaluates fTransFixed(20, 5, ratio) once per axis with equal args; folded.
    const unit = uf.transFixed(20, 5, ratio);
    return [pt[0] / unit, pt[1] / unit, 10];
  }
}

/**
 * Cylindrical unwrap: x = radius, y = samplesPerRound · (phi + phiPerZ · z)
 * — note y is an angle count, not scaled to a unit size (C# `RadialTrafo`).
 */
export class RadialTrafo implements CoordinateTrafo {
  private readonly samplesPerRound: number;
  private readonly phiPerZ: number;

  constructor(samplesPerRound: number, phiPerZ: number) {
    this.samplesPerRound = samplesPerRound;
    this.phiPerZ = phiPerZ;
  }

  apply(pt: Vec3): Vec3 {
    const z = pt[2];
    const radius = vecOps.radius(pt);
    const phi = vecOps.phi(pt) + this.phiPerZ * z;
    return [radius, this.samplesPerRound * phi, z];
  }
}

/** Sequential composition of trafos; an empty list is the identity (C# `CombinedTrafo`). */
export class CombinedTrafo implements CoordinateTrafo {
  private readonly trafos: readonly CoordinateTrafo[];

  constructor(trafos: readonly CoordinateTrafo[]) {
    this.trafos = trafos;
  }

  apply(pt: Vec3): Vec3 {
    let current = pt;
    for (const trafo of this.trafos) {
      current = trafo.apply(current);
    }
    return current;
  }
}
