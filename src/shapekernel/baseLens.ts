// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseLens.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.
//
// Upstream quirk ported verbatim: the height modulations are queried with
// (phi ANGLE, radiusRatio) — not two 0..1 ratios.

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { SurfaceModulation } from './modulations.ts';

/** Lens/washer: annulus between two height-modulated faces (C# `BaseLens`). */
export class BaseLens extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected radialSteps = 5;
  protected polarSteps = 360;
  protected heightSteps = 5;
  protected readonly innerRadius: number;
  protected readonly outerRadius: number;
  protected upperModulation: SurfaceModulation;
  protected lowerModulation: SurfaceModulation;
  protected readonly frame: Frame;

  constructor(frame: Frame, height: number, innerRadius: number, outerRadius: number) {
    super();
    this.frame = frame;
    this.innerRadius = innerRadius;
    this.outerRadius = outerRadius;
    this.lowerModulation = new SurfaceModulation(0);
    this.upperModulation = new SurfaceModulation(height);
  }

  /** C# `SetHeight` — modulated faces bump radial sampling to 500. */
  setHeight(lowerModulation: SurfaceModulation, upperModulation: SurfaceModulation): void {
    this.lowerModulation = lowerModulation;
    this.upperModulation = upperModulation;
    this.setRadialSteps(500);
  }

  setRadialSteps(steps: number): void {
    this.radialSteps = Math.max(5, steps);
  }

  setPolarSteps(steps: number): void {
    this.polarSteps = Math.max(5, steps);
  }

  setHeightSteps(steps: number): void {
    this.heightSteps = Math.max(5, steps);
  }

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
    const builder = new MeshBuilder();
    this.addFace(builder, 1, false); // top
    this.addFace(builder, 0, true); // bottom
    this.addMantle(builder, 0, false); // inner
    this.addMantle(builder, this.radialSteps - 1, true); // outer
    return builder.build(pk);
  }

  /** Face at a fixed height ratio, iterating phi×radius (C# `AddTopSurface`/`AddBottomSurface`). */
  private addFace(builder: MeshBuilder, heightRatio: number, flip: boolean): void {
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      const phi1 = this.phiRatioFromStep(phiStep - 1);
      const phi2 = this.phiRatioFromStep(phiStep);
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        const r1 = this.radiusRatioFromStep(radiusStep - 1);
        const r2 = this.radiusRatioFromStep(radiusStep);
        const pt0 = this.surfacePoint(heightRatio, phi1, r1);
        const pt1 = this.surfacePoint(heightRatio, phi1, r2);
        const pt2 = this.surfacePoint(heightRatio, phi2, r2);
        const pt3 = this.surfacePoint(heightRatio, phi2, r1);
        if (!flip) {
          builder.addTriangle(pt0, pt1, pt2);
          builder.addTriangle(pt0, pt2, pt3);
        } else {
          builder.addTriangle(pt0, pt2, pt1);
          builder.addTriangle(pt0, pt3, pt2);
        }
      }
    }
  }

  /** Mantle at a fixed radius step, iterating phi×height (C# `AddInnerMantle`/`AddOuterMantle`). */
  private addMantle(builder: MeshBuilder, radiusStep: number, flip: boolean): void {
    const radiusRatio = this.radiusRatioFromStep(radiusStep);
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      const phi1 = this.phiRatioFromStep(phiStep - 1);
      const phi2 = this.phiRatioFromStep(phiStep);
      for (let heightStep = 1; heightStep < this.heightSteps; heightStep += 1) {
        const h1 = this.heightRatioFromStep(heightStep - 1);
        const h2 = this.heightRatioFromStep(heightStep);
        const pt0 = this.surfacePoint(h1, phi1, radiusRatio);
        const pt1 = this.surfacePoint(h2, phi1, radiusRatio);
        const pt2 = this.surfacePoint(h2, phi2, radiusRatio);
        const pt3 = this.surfacePoint(h1, phi2, radiusRatio);
        if (!flip) {
          builder.addTriangle(pt0, pt1, pt2);
          builder.addTriangle(pt0, pt2, pt3);
        } else {
          builder.addTriangle(pt0, pt2, pt1);
          builder.addTriangle(pt0, pt3, pt2);
        }
      }
    }
  }

  protected radiusRatioFromStep(step: number): number {
    return (1 / (this.radialSteps - 1)) * step;
  }

  protected phiRatioFromStep(step: number): number {
    return (1 / (this.polarSteps - 1)) * step;
  }

  protected heightRatioFromStep(step: number): number {
    return (1 / (this.heightSteps - 1)) * step;
  }

  /** Surface point (C# `vecGetSurfacePoint`; args heightRatio, phiRatio, radiusRatio). */
  surfacePoint(heightRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const phi = 2 * Math.PI * phiRatio;
    const radius = (this.outerRadius - this.innerRadius) * radiusRatio + this.innerRadius;
    const lower = this.lowerModulation.modulation(phi, radiusRatio);
    const upper = this.upperModulation.modulation(phi, radiusRatio);
    const z = lower + heightRatio * (upper - lower);
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    const f = this.frame;
    return this.trafo([
      f.pos[0] + x * f.lx[0] + y * f.ly[0] + z * f.lz[0],
      f.pos[1] + x * f.lx[1] + y * f.ly[1] + z * f.lz[1],
      f.pos[2] + x * f.lx[2] + y * f.ly[2] + z * f.lz[2],
    ]);
  }
}
