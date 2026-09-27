// Derived from LEAP71_LatticeLibrary — ImplicitLibrary/SplittingLogic.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.

/** Turns a raw signed distance + wall thickness into the final field (C# `ISplittingLogic`). */
export interface SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number;
}

/** Wall on both sides of the zero surface (C# `FullWallLogic`). */
export class FullWallLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return Math.abs(signedDistance) - 0.5 * wallThickness;
  }
}

/** Complement of the full wall (C# `FullVoidLogic`). */
export class FullVoidLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return -(Math.abs(signedDistance) - 0.5 * wallThickness);
  }
}

/** Wall only on the positive side (C# `PositiveHalfWallLogic`). */
export class PositiveHalfWallLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return Math.max(signedDistance, Math.abs(signedDistance) - 0.5 * wallThickness);
  }
}

/** Wall only on the negative side (C# `NegativeHalfWallLogic`). */
export class NegativeHalfWallLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return Math.max(-signedDistance, Math.abs(signedDistance) - 0.5 * wallThickness);
  }
}

/** Positive-side volume shrunk by the half wall (C# `PositiveVoidLogic`). */
export class PositiveVoidLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return -(Math.max(0, signedDistance) - 0.5 * wallThickness);
  }
}

/** Negative-side volume shrunk by the half wall (C# `NegativeVoidLogic`). */
export class NegativeVoidLogic implements SplittingLogic {
  advancedSignedDistance(signedDistance: number, wallThickness: number): number {
    return -(Math.max(0, -signedDistance) - 0.5 * wallThickness);
  }
}
