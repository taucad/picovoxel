// Derived from LEAP71_LatticeLibrary — ImplicitLibrary/TPMSPresets/
// {ImplicitLidinoid,ImplicitSchwarzPrimitive,ImplicitSchwarzDiamond,
// ImplicitSplitWallGyroid,ImplicitSplitVoidGyroid,ImplicitRadialGyroid,
// ImplicitRandomizedSchwarzPrimitive,ImplicitModular}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// The five closed-form presets implement the shapekernel `Implicit` shape:
// `sdf` (upstream's serial callback path) AND `expression` (the slab-parallel
// tape, R9), value-identical op for op. The other three are `sdf`-only —
// their math cannot cross the tape op set (src/tape.ts has no atan2 for the
// radial unwrap, no data-grid gather for the deformation field, and
// ImplicitModular composes arbitrary user callbacks); consumers route them
// through the callback path, the same boundary R9 drew for withImplicit.
// The 9th preset the examples use, ImplicitGyroid, lives in
// src/shapekernel/implicitUtility.ts.

import type { Implicit } from '../shapekernel/implicitUtility.ts';
import type { SdfExpression } from '../tape.ts';
import type { SdfFunction, Vec3 } from '../types.ts';
import type { BeamThickness } from './beamThickness.ts';
import type { CoordinateTrafo } from './coordinateTrafo.ts';
import type { RandomDeformationField } from './randomDeformationField.ts';
import type { RawTpmsPattern } from './rawTpmsPatterns.ts';
import type { SplittingLogic } from './splittingLogic.ts';

const TWO_PI = 2 * Math.PI;

/** The gyroid surface sum at frequency scale s — callback form. */
const gyroidSum =
  (s: number) =>
  (x: number, y: number, z: number): number =>
    Math.sin(s * x) * Math.cos(s * y) + Math.sin(s * y) * Math.cos(s * z) + Math.sin(s * z) * Math.cos(s * x);

/** The same sum as a tape expression (identical fold order). */
const gyroidSumExpression = (s: number): SdfExpression => [
  '+',
  ['*', ['sin', ['*', s, 'x']], ['cos', ['*', s, 'y']]],
  ['*', ['sin', ['*', s, 'y']], ['cos', ['*', s, 'z']]],
  ['*', ['sin', ['*', s, 'z']], ['cos', ['*', s, 'x']]],
];

/**
 * Implicit lidinoid; the unit size is internally halved so features stay
 * comparable to a gyroid (C# `ImplicitLidinoid`).
 */
export class ImplicitLidinoid implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, wallThickness: number) {
    const s = (0.5 * TWO_PI) / unitSize;
    const s2 = 2 * s; // hoisted from C#'s inline `2 * scale` — same product
    const halfWall = 0.5 * wallThickness;
    this.sdf = (x, y, z) =>
      Math.abs(
        0.5 *
          (Math.sin(s2 * x) * Math.cos(s * y) * Math.sin(s * z) +
            Math.sin(s2 * y) * Math.cos(s * z) * Math.sin(s * x) +
            Math.sin(s2 * z) * Math.cos(s * x) * Math.sin(s * y)) -
          0.5 *
            (Math.cos(s2 * x) * Math.cos(s2 * y) +
              Math.cos(s2 * y) * Math.cos(s2 * z) +
              Math.cos(s2 * z) * Math.cos(s2 * x)),
      ) - halfWall;
    this.expression = [
      '-',
      [
        'abs',
        [
          '-',
          [
            '*',
            0.5,
            [
              '+',
              ['*', ['sin', ['*', s2, 'x']], ['cos', ['*', s, 'y']], ['sin', ['*', s, 'z']]],
              ['*', ['sin', ['*', s2, 'y']], ['cos', ['*', s, 'z']], ['sin', ['*', s, 'x']]],
              ['*', ['sin', ['*', s2, 'z']], ['cos', ['*', s, 'x']], ['sin', ['*', s, 'y']]],
            ],
          ],
          [
            '*',
            0.5,
            [
              '+',
              ['*', ['cos', ['*', s2, 'x']], ['cos', ['*', s2, 'y']]],
              ['*', ['cos', ['*', s2, 'y']], ['cos', ['*', s2, 'z']]],
              ['*', ['cos', ['*', s2, 'z']], ['cos', ['*', s2, 'x']]],
            ],
          ],
        ],
      ],
      halfWall,
    ];
  }
}

/** Implicit Schwarz primitive (C# `ImplicitSchwarzPrimitive`). */
export class ImplicitSchwarzPrimitive implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, wallThickness: number) {
    const s = TWO_PI / unitSize;
    const halfWall = 0.5 * wallThickness;
    this.sdf = (x, y, z) => Math.abs(Math.cos(s * x) + Math.cos(s * y) + Math.cos(s * z)) - halfWall;
    this.expression = [
      '-',
      ['abs', ['+', ['cos', ['*', s, 'x']], ['cos', ['*', s, 'y']], ['cos', ['*', s, 'z']]]],
      halfWall,
    ];
  }
}

/**
 * Implicit Schwarz diamond; the unit size is internally halved so features
 * stay comparable to a gyroid (C# `ImplicitSchwarzDiamond`).
 */
export class ImplicitSchwarzDiamond implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, wallThickness: number) {
    const s = (0.5 * TWO_PI) / unitSize;
    const halfWall = 0.5 * wallThickness;
    this.sdf = (x, y, z) =>
      Math.abs(
        Math.cos(s * x) * Math.cos(s * y) * Math.cos(s * z) -
          Math.sin(s * x) * Math.sin(s * y) * Math.sin(s * z),
      ) - halfWall;
    this.expression = [
      '-',
      [
        'abs',
        [
          '-',
          ['*', ['cos', ['*', s, 'x']], ['cos', ['*', s, 'y']], ['cos', ['*', s, 'z']]],
          ['*', ['sin', ['*', s, 'x']], ['sin', ['*', s, 'y']], ['sin', ['*', s, 'z']]],
        ],
      ],
      halfWall,
    ];
  }
}

/**
 * Gyroid wall on one side of the surface, solid on the other; `side` picks
 * which (C# `ImplicitSplitWallGyroid`).
 */
export class ImplicitSplitWallGyroid implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, wallThickness: number, side: boolean) {
    const s = TWO_PI / unitSize;
    const sum = gyroidSum(s);
    const sumExpression = gyroidSumExpression(s);
    const halfWall = 0.5 * wallThickness;
    if (side) {
      this.sdf = (x, y, z) => {
        const dist = sum(x, y, z);
        return Math.max(dist, Math.abs(dist) - halfWall);
      };
      this.expression = ['max', sumExpression, ['-', ['abs', sumExpression], halfWall]];
    } else {
      this.sdf = (x, y, z) => {
        const dist = sum(x, y, z);
        return Math.max(-dist, Math.abs(dist) - halfWall);
      };
      this.expression = ['max', ['-', sumExpression], ['-', ['abs', sumExpression], halfWall]];
    }
  }
}

/**
 * One side of the gyroid surface as a void, shrunk by the half wall; `side`
 * picks which (C# `ImplicitSplitVoidGyroid`).
 */
export class ImplicitSplitVoidGyroid implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, wallThickness: number, side: boolean) {
    const s = TWO_PI / unitSize;
    const sum = gyroidSum(s);
    const sumExpression = gyroidSumExpression(s);
    const halfWall = 0.5 * wallThickness;
    if (side) {
      this.sdf = (x, y, z) => -(Math.max(0, sum(x, y, z)) - halfWall);
      this.expression = ['-', ['-', ['max', 0, sumExpression], halfWall]];
    } else {
      this.sdf = (x, y, z) => -(Math.max(0, -sum(x, y, z)) - halfWall);
      this.expression = ['-', ['-', ['max', 0, ['-', sumExpression]], halfWall]];
    }
  }
}

/**
 * Gyroid unwrapped around the Z axis: an exact unit count per round via the
 * cylindrical phi (C# `ImplicitRadialGyroid`). Callback-only: atan2 is
 * outside the tape op set.
 */
export class ImplicitRadialGyroid {
  readonly sdf: SdfFunction;

  constructor(unitsPerRound: number, unitSizeInZ: number, wallThickness: number) {
    const s = TWO_PI / unitSizeInZ;
    this.sdf = (x, y, z) => {
      // Cylindrical mapping, as C# via VecOperations.fGetRadius/fGetPhi.
      const radius = Math.sqrt(x * x + y * y);
      const dPhi = TWO_PI / unitsPerRound;
      const phi = Math.atan2(y, x) + Math.PI;
      const phiIntervals = phi / dPhi;
      const unitSize = TWO_PI / s;
      const dY = phiIntervals * unitSize;
      const dist =
        Math.sin(s * radius) * Math.cos(s * dY) +
        Math.sin(s * dY) * Math.cos(s * z) +
        Math.sin(s * z) * Math.cos(s * radius);
      return Math.abs(dist) - 0.5 * wallThickness;
    };
  }
}

/**
 * Schwarz primitive over a randomly deformed grid: the query point is shifted
 * by the field's noise vector before the surface equation
 * (C# `ImplicitRandomizedSchwarzPrimitive`). Callback-only: the tape has no
 * data-grid gather.
 */
export class ImplicitRandomizedSchwarzPrimitive {
  readonly sdf: SdfFunction;

  constructor(unitSize: number, wallThickness: number, field: RandomDeformationField) {
    const s = TWO_PI / unitSize;
    this.sdf = (x, y, z) => {
      const noise = field.dataAt([x, y, z]);
      const dist = Math.cos(s * (x + noise[0])) + Math.cos(s * (y + noise[1])) + Math.cos(s * (z + noise[2]));
      return Math.abs(dist) - 0.5 * wallThickness;
    };
  }
}

/**
 * Modular implicit: coordinate trafo → raw TPMS pattern, walled by a
 * splitting logic; the wall thickness is queried in cartesian coordinates
 * (C# `ImplicitModular`). Callback-only: the components are arbitrary
 * callbacks.
 */
export class ImplicitModular {
  readonly sdf: SdfFunction;

  constructor(
    pattern: RawTpmsPattern,
    wallThickness: BeamThickness,
    trafo: CoordinateTrafo,
    splittingLogic: SplittingLogic,
  ) {
    this.sdf = (x, y, z) => {
      const pt: Vec3 = [x, y, z];
      const [tx, ty, tz] = trafo.apply(pt);
      return splittingLogic.advancedSignedDistance(
        pattern.signedDistance(tx, ty, tz),
        wallThickness.beamThickness(pt),
      );
    };
  }
}
