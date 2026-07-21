// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseRing.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R5); see NOTICE.

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { SurfaceModulation } from './modulations.ts';

/** Torus ring on a local frame; tube radius surface-modulated (C# `BaseRing`). */
export class BaseRing extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected polarSteps = 360;
  protected radialSteps = 360;
  protected readonly ringRadius: number;
  protected radiusModulation: SurfaceModulation;
  protected readonly frame: Frame;

  constructor(frame: Frame, ringRadius = 50, radius = 5) {
    super();
    this.frame = frame;
    this.ringRadius = ringRadius;
    this.radiusModulation = new SurfaceModulation(radius);
  }

  setRadius(modulation: SurfaceModulation): void {
    this.radiusModulation = modulation;
  }

  setRadialSteps(steps: number): void {
    this.radialSteps = Math.max(5, steps);
  }

  setPolarSteps(steps: number): void {
    this.polarSteps = Math.max(5, steps);
  }

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
    const builder = new MeshBuilder();
    const radiusRatio = 1;
    for (let alphaStep = 0; alphaStep < this.radialSteps; alphaStep += 1) {
      // Wrap the ring closed: step 0 pairs with the last step (C# iLowerIndex wrap).
      let lowerIndex = alphaStep - 1;
      if (lowerIndex < 0) lowerIndex += this.radialSteps;
      const alpha1 = this.alphaRatioFromStep(lowerIndex);
      const alpha2 = this.alphaRatioFromStep(alphaStep);
      for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
        const phi1 = this.phiRatioFromStep(phiStep - 1);
        const phi2 = this.phiRatioFromStep(phiStep);
        const pt0 = this.surfacePoint(alpha1, phi1, radiusRatio);
        const pt1 = this.surfacePoint(alpha2, phi1, radiusRatio);
        const pt2 = this.surfacePoint(alpha2, phi2, radiusRatio);
        const pt3 = this.surfacePoint(alpha1, phi2, radiusRatio);
        builder.addTriangle(pt0, pt1, pt2);
        builder.addTriangle(pt0, pt2, pt3);
      }
    }
    return builder.build(pk);
  }

  protected alphaRatioFromStep(step: number): number {
    return (1 / (this.radialSteps - 1)) * step;
  }

  protected phiRatioFromStep(step: number): number {
    return (1 / (this.polarSteps - 1)) * step;
  }

  /** Surface point on the torus; alpha runs around the ring, phi around the tube (C# `vecGetSurfacePoint`). */
  surfacePoint(alphaRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const alpha = 2 * Math.PI * alphaRatio;
    const phi = 2 * Math.PI * phiRatio;
    const f = this.frame;

    const ringX = this.ringRadius * Math.cos(alpha);
    const ringY = this.ringRadius * Math.sin(alpha);
    const spine: Vec3 = [
      f.pos[0] + ringX * f.lx[0] + ringY * f.ly[0],
      f.pos[1] + ringX * f.lx[1] + ringY * f.ly[1],
      f.pos[2] + ringX * f.lx[2] + ringY * f.ly[2],
    ];

    // Tube cross-section frame: X radially outward, Y along the ring axis.
    const localX = vec3.safeNormalized(vec3.sub(spine, f.pos));
    const localY = f.lz;

    const radius = radiusRatio * this.radiusModulation.modulation(phi, alpha);
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    return this.trafo([
      spine[0] + x * localX[0] + y * localY[0],
      spine[1] + x * localX[1] + y * localY[1],
      spine[2] + x * localX[2] + y * localY[2],
    ]);
  }
}
