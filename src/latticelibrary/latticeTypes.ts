// Derived from LEAP71_LatticeLibrary — LatticeLibrary/LatticeTypes/
// {BodyCentreLattice,OctahedronLattice,RandomSplineLattice}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// The identical private `AddBeam` in the two C# 8-corner types is one shared
// helper here. `RandomSplineLattice` swaps C#'s ambient `Uf` randomness for an
// explicit RandomSource (no Math.random in library code; self-referential
// seeded corpus, as the shapekernel port).

import { PicoError } from '../errors.ts';
import type { Lattice } from '../lattice.ts';
import { vec3 } from '../numerics/vector.ts';
import { splineOps } from '../shapekernel/splineOperations.ts';
import { type RandomSource, uf } from '../shapekernel/uf.ts';
import type { Vec3 } from '../types.ts';
import type { BeamThickness } from './beamThickness.ts';
import type { UnitCell } from './unitCells.ts';

/** Beam-connecting logic for one unit cell (C# `ILatticeType`). */
export interface LatticeType {
  addCell(lattice: Lattice, cell: UnitCell, beamThickness: BeamThickness, subSamples?: number): void;
}

/** One beam pt1→pt2, sampled into chained sub-beams when samples > 2 (C# `AddBeam`). */
function addSampledBeam(
  lattice: Lattice,
  pt1: Vec3,
  pt2: Vec3,
  beamThickness: BeamThickness,
  samples: number,
): void {
  if (samples === 2) {
    lattice.addBeam({
      start: pt1,
      end: pt2,
      startRadius: 0.5 * beamThickness.beamThickness(pt1),
      endRadius: 0.5 * beamThickness.beamThickness(pt2),
    });
  } else {
    for (let i = 1; i < samples; i += 1) {
      const start = vec3.add(pt1, vec3.scale(vec3.sub(pt2, pt1), (i - 1) / (samples - 1)));
      const end = vec3.add(pt1, vec3.scale(vec3.sub(pt2, pt1), i / (samples - 1)));
      lattice.addBeam({
        start,
        end,
        startRadius: 0.5 * beamThickness.beamThickness(start),
        endRadius: 0.5 * beamThickness.beamThickness(end),
      });
    }
  }
}

function requireEightCorners(cell: UnitCell, latticeName: string): readonly Vec3[] {
  const corners = cell.cornerPoints();
  if (corners.length !== 8) {
    throw new PicoError('PICO_INVALID_ARGUMENT', `${latticeName} only supports Unit Cells with 8 Corners.`);
  }
  return corners;
}

/**
 * Body-centred lattice: every corner connects through the cell centre
 * (C# `BodyCentreLattice`).
 */
export class BodyCentreLattice implements LatticeType {
  addCell(lattice: Lattice, cell: UnitCell, beamThickness: BeamThickness, subSamples = 2): void {
    const corners = requireEightCorners(cell, 'Body Centre Lattice');
    const centre = cell.cellCentre();
    for (const corner of corners) {
      addSampledBeam(lattice, corner, centre, beamThickness, subSamples);
    }
  }
}

/**
 * Octahedron lattice: adjacent face centres of the unit cell connect
 * (C# `OctahedronLattice`).
 */
export class OctahedronLattice implements LatticeType {
  addCell(lattice: Lattice, cell: UnitCell, beamThickness: BeamThickness, subSamples = 2): void {
    const corners = requireEightCorners(cell, 'Octahedron Lattice');
    const face = (a: number, b: number, c: number, d: number): Vec3 =>
      vec3.scale(vec3.add(vec3.add(corners[a]!, corners[b]!), vec3.add(corners[c]!, corners[d]!)), 0.25);
    const lower = face(0, 1, 2, 3);
    const upper = face(4, 5, 6, 7);
    const forward = face(4, 5, 0, 1);
    const right = face(6, 5, 2, 1);
    const backward = face(6, 7, 2, 3);
    const left = face(4, 7, 0, 3);
    for (const [from, to] of [
      [lower, right],
      [lower, left],
      [lower, forward],
      [lower, backward],
      [upper, right],
      [upper, left],
      [upper, forward],
      [upper, backward],
      [forward, right],
      [forward, left],
      [backward, right],
      [backward, left],
    ] as const) {
      addSampledBeam(lattice, from, to, beamThickness, subSamples);
    }
  }
}

/**
 * Custom lattice type connecting random corners of a cell through a noisy
 * NURBS midpoint; `passes` connects each corner to that many other points
 * (C# `RandomSplineLattice`).
 */
export class RandomSplineLattice implements LatticeType {
  private readonly random: RandomSource;
  private readonly passes: number;

  constructor(random: RandomSource, passes = 1) {
    this.random = random;
    this.passes = passes;
  }

  // subSamples is in the C# signature but unused there too — the spline's 20
  // sample points set the beam resolution.
  addCell(lattice: Lattice, cell: UnitCell, beamThickness: BeamThickness, _subSamples?: number): void {
    const bounds = cell.cellBounding();
    const size = vec3.sub(bounds.max, bounds.min);
    const corners = cell.cornerPoints();
    for (let pass = 0; pass < this.passes; pass += 1) {
      for (let i = 0; i < corners.length; i += 1) {
        let j;
        do {
          j = Math.trunc(uf.randomLinear(0, corners.length, this.random));
        } while (j === i); // never connect a corner to itself
        const noise: Vec3 = [
          uf.randomLinear(-0.3 * size[0], 0.3 * size[0], this.random),
          uf.randomLinear(-0.3 * size[1], 0.3 * size[1], this.random),
          uf.randomLinear(-0.3 * size[2], 0.3 * size[2], this.random),
        ];
        const points = splineOps.nurbsSpline(
          [corners[i]!, vec3.add(cell.cellCentre(), noise), corners[j]!],
          20,
        );
        for (let k = 1; k < points.length; k += 1) {
          lattice.addBeam({
            start: points[k - 1]!,
            end: points[k]!,
            startRadius: 0.5 * beamThickness.beamThickness(points[k - 1]!),
            endRadius: 0.5 * beamThickness.beamThickness(points[k]!),
          });
        }
      }
    }
  }
}
