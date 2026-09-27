// Derived from LEAP71_ShapeKernel — ShapeKernel/Utilities/ImplicitUtility.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R6); see NOTICE.
//
// Each implicit is available in BOTH forms: `sdf` — the JS callback (upstream's
// serial per-voxel path), and `expression` — the serialized SdfExpression the
// slab-parallel tape path evaluates in-module on every thread (R9). The two are
// value-identical: same f64 operations, one f32 truncation at the grid write.
// The SuperEllipsoid ADDS its centre (upstream quirk, ported verbatim).

import type { SdfExpression } from '../tape.ts';
import type { SdfFunction, Vec3 } from '../types.ts';

export interface Implicit {
  /** C# `IImplicit.fSignedDistance` as a picovoxel SdfFunction. */
  readonly sdf: SdfFunction;
  /** The same field as a tape expression for the parallel fill. */
  readonly expression: SdfExpression;
}

/** Gyroid pattern with a wall-thickness ratio (C# `ImplicitGyroid`). */
export class ImplicitGyroid implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(unitSize: number, thicknessRatio: number) {
    const scale = (2 * Math.PI) / unitSize;
    this.sdf = (x, y, z) =>
      Math.abs(
        Math.sin(scale * x) * Math.cos(scale * y) +
          Math.sin(scale * y) * Math.cos(scale * z) +
          Math.sin(scale * z) * Math.cos(scale * x),
      ) -
      0.5 * thicknessRatio;
    this.expression = [
      '-',
      [
        'abs',
        [
          '+',
          ['*', ['sin', ['*', scale, 'x']], ['cos', ['*', scale, 'y']]],
          ['*', ['sin', ['*', scale, 'y']], ['cos', ['*', scale, 'z']]],
          ['*', ['sin', ['*', scale, 'z']], ['cos', ['*', scale, 'x']]],
        ],
      ],
      0.5 * thicknessRatio,
    ];
  }

  /** Thickness ratio for a target wall thickness in mm (C# `fGetThicknessRatio`). */
  static thicknessRatio(wallThickness: number, unitSize: number): number {
    return (wallThickness * 10) / unitSize;
  }
}

/** Implicit sphere (C# `ImplicitSphere`). */
export class ImplicitSphere implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(centre: Vec3, radius: number) {
    const [cx, cy, cz] = centre;
    this.sdf = (x, y, z) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - radius;
    this.expression = [
      '-',
      ['sqrt', ['+', ['pow', ['-', 'x', cx], 2], ['pow', ['-', 'y', cy], 2], ['pow', ['-', 'z', cz], 2]]],
      radius,
    ];
  }
}

/** Implicit genus-2 surface; `gap` controls the centre hole (C# `ImplicitGenus`). */
export class ImplicitGenus implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(gap: number) {
    this.sdf = (x, y, z) =>
      2 * y * (y * y - 3 * x * x) * (1 - z * z) + (x * x + y * y) ** 2 - (9 * z * z - 1) * (1 - z * z) - gap;
    const x2: SdfExpression = ['*', 'x', 'x'];
    const y2: SdfExpression = ['*', 'y', 'y'];
    const z2: SdfExpression = ['*', 'z', 'z'];
    const oneMinusZ2: SdfExpression = ['-', 1, z2];
    this.expression = [
      '-',
      [
        '+',
        ['*', 2, 'y', ['-', y2, ['*', 3, x2]], oneMinusZ2],
        ['pow', ['+', x2, y2], 2],
        ['-', 0, ['*', ['-', ['*', 9, z2], 1], oneMinusZ2]],
      ],
      gap,
    ];
  }
}

/** Implicit superellipsoid (C# `ImplicitSuperEllipsoid`; centre is ADDED, as upstream). */
export class ImplicitSuperEllipsoid implements Implicit {
  readonly sdf: SdfFunction;
  readonly expression: SdfExpression;

  constructor(centre: Vec3, ax: number, ay: number, az: number, epsilon1: number, epsilon2: number) {
    const [cx, cy, cz] = centre;
    this.sdf = (x, y, z) => {
      const dx = Math.abs(x + cx) / ax;
      const dy = Math.abs(y + cy) / ay;
      const dz = Math.abs(z + cz) / az;
      return (
        (dx ** (2 / epsilon2) + dy ** (2 / epsilon2)) ** (epsilon2 / epsilon1) + dz ** (2 / epsilon1) - 1
      );
    };
    const dx: SdfExpression = ['/', ['abs', ['+', 'x', cx]], ax];
    const dy: SdfExpression = ['/', ['abs', ['+', 'y', cy]], ay];
    const dz: SdfExpression = ['/', ['abs', ['+', 'z', cz]], az];
    this.expression = [
      '-',
      [
        '+',
        ['pow', ['+', ['pow', dx, 2 / epsilon2], ['pow', dy, 2 / epsilon2]], epsilon2 / epsilon1],
        ['pow', dz, 2 / epsilon1],
      ],
      1,
    ];
  }
}
