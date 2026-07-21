// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseSphere.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R5); see NOTICE.
//
// Upstream quirks ported verbatim: the tessellation's inner loop starts at
// step 0 (its first band reaches one step BELOW ratio 0), and the radius
// modulation is queried with the raw phi/theta ANGLES, not 0..1 ratios.

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { SurfaceModulation } from './modulations.ts';

/** Sphere on a local frame with a surface-modulated radius (C# `BaseSphere`). */
export class BaseSphere extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected azimuthalSteps = 360;
  protected polarSteps = 180;
  protected radiusModulation: SurfaceModulation;
  protected readonly frame: Frame;

  constructor(frame: Frame, radius = 10) {
    super();
    this.frame = frame;
    this.radiusModulation = new SurfaceModulation(radius);
  }

  setRadius(modulation: SurfaceModulation): void {
    this.radiusModulation = modulation;
  }

  /** No lower clamp upstream (unlike the other shapes' step setters). */
  setAzimuthalSteps(steps: number): void {
    this.azimuthalSteps = steps;
  }

  setPolarSteps(steps: number): void {
    this.polarSteps = steps;
  }

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
    const builder = new MeshBuilder();
    const radiusRatio = 1;
    for (let thetaStep = 1; thetaStep < this.azimuthalSteps; thetaStep += 1) {
      const theta1 = (1 / (this.azimuthalSteps - 1)) * (thetaStep - 1);
      const theta2 = (1 / (this.azimuthalSteps - 1)) * thetaStep;
      for (let phiStep = 0; phiStep < this.polarSteps; phiStep += 1) {
        const phi1 = (1 / (this.polarSteps - 1)) * (phiStep - 1);
        const phi2 = (1 / (this.polarSteps - 1)) * phiStep;
        const pt0 = this.surfacePoint(phi1, theta1, radiusRatio);
        const pt1 = this.surfacePoint(phi1, theta2, radiusRatio);
        const pt2 = this.surfacePoint(phi2, theta2, radiusRatio);
        const pt3 = this.surfacePoint(phi2, theta1, radiusRatio);
        builder.addTriangle(pt0, pt1, pt2);
        builder.addTriangle(pt0, pt2, pt3);
      }
    }
    return builder.build(pk);
  }

  /**
   * Surface point; theta is the polar angle from +Z, radius modulation queried
   * with raw angles (C# `vecGetSurfacePoint`).
   */
  surfacePoint(phiRatio: number, thetaRatio: number, radiusRatio: number): Vec3 {
    const theta = Math.PI * thetaRatio;
    const phi = 2 * Math.PI * phiRatio;
    const radius = radiusRatio * this.radiusModulation.modulation(phi, theta);
    const x = radius * Math.cos(phi) * Math.sin(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(theta);
    const f = this.frame;
    return this.trafo([
      f.pos[0] + x * f.lx[0] + y * f.ly[0] + z * f.lz[0],
      f.pos[1] + x * f.lx[1] + y * f.ly[1] + z * f.lz[1],
      f.pos[2] + x * f.lx[2] + y * f.ly[2] + z * f.lz[2],
    ]);
  }
}
