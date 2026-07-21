// Derived from LEAP71_LatticeLibrary — ImplicitLibrary/RawTPMSPatterns.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R13); see NOTICE.
//
// Raw (unit-frequency, no wall) TPMS surface equations over pre-transformed
// coordinates. Frequency scales are the upstream constants: gyroid and
// Schwarz primitive 2π, lidinoid and Schwarz diamond π (halved so features
// stay comparable to a gyroid).

import { uf } from '../shapekernel/uf.ts';

/** Raw TPMS surface equation (C# `IRawTPMSPattern`). */
export interface RawTpmsPattern {
  signedDistance(x: number, y: number, z: number): number;
}

const TWO_PI = 2 * Math.PI;

/** C# `RawGyroidTPMSPattern`. */
export class RawGyroidTpmsPattern implements RawTpmsPattern {
  signedDistance(x: number, y: number, z: number): number {
    return (
      Math.sin(TWO_PI * x) * Math.cos(TWO_PI * y) +
      Math.sin(TWO_PI * y) * Math.cos(TWO_PI * z) +
      Math.sin(TWO_PI * z) * Math.cos(TWO_PI * x)
    );
  }
}

/** C# `RawLidinoidTPMSPattern`. */
export class RawLidinoidTpmsPattern implements RawTpmsPattern {
  signedDistance(x: number, y: number, z: number): number {
    const s = 0.5 * TWO_PI;
    return (
      0.5 *
        (Math.sin(2 * s * x) * Math.cos(s * y) * Math.sin(s * z) +
          Math.sin(2 * s * y) * Math.cos(s * z) * Math.sin(s * x) +
          Math.sin(2 * s * z) * Math.cos(s * x) * Math.sin(s * y)) -
      0.5 *
        (Math.cos(2 * s * x) * Math.cos(2 * s * y) +
          Math.cos(2 * s * y) * Math.cos(2 * s * z) +
          Math.cos(2 * s * z) * Math.cos(2 * s * x))
    );
  }
}

/** C# `RawSchwarzPrimitiveTPMSPattern`. */
export class RawSchwarzPrimitiveTpmsPattern implements RawTpmsPattern {
  signedDistance(x: number, y: number, z: number): number {
    return Math.cos(TWO_PI * x) + Math.cos(TWO_PI * y) + Math.cos(TWO_PI * z);
  }
}

/** C# `RawSchwarzDiamondTPMSPattern`. */
export class RawSchwarzDiamondTpmsPattern implements RawTpmsPattern {
  signedDistance(x: number, y: number, z: number): number {
    const s = 0.5 * TWO_PI;
    return (
      Math.cos(s * x) * Math.cos(s * y) * Math.cos(s * z) -
      Math.sin(s * x) * Math.sin(s * y) * Math.sin(s * z)
    );
  }
}

/**
 * Schwarz diamond blending into Schwarz primitive over x in -2..3
 * (C# `RawTransitionTPMSPattern`).
 */
export class RawTransitionTpmsPattern implements RawTpmsPattern {
  private readonly first = new RawSchwarzDiamondTpmsPattern();
  private readonly second = new RawSchwarzPrimitiveTpmsPattern();

  signedDistance(x: number, y: number, z: number): number {
    const ratio = Math.min(Math.max((x + 2) / 5, 0), 1);
    return uf.transFixed(this.first.signedDistance(x, y, z), this.second.signedDistance(x, y, z), ratio);
  }
}
