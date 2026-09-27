// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/{BaseCylinder,BaseCone}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { Frames } from './frames.ts';
import { SurfaceModulation } from './modulations.ts';

/**
 * Cylinder along a straight frame or a spine, with a surface-modulated radius
 * (C# `BaseCylinder`). Tessellates top/bottom discs + outer mantle, then
 * voxelizes the closed mesh.
 */
export class BaseCylinder extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected lengthSteps = 5;
  protected polarSteps = 360;
  protected radialSteps = 5;
  protected radiusModulation: SurfaceModulation;
  protected frames: Frames;

  constructor(frameOrFrames: Frame | Frames, lengthOrRadius?: number, radius?: number) {
    super();
    if (frameOrFrames instanceof Frames) {
      // C# BaseCylinder(Frames, fRadius = 10)
      this.frames = frameOrFrames;
      this.setLengthSteps(500);
      this.radiusModulation = new SurfaceModulation(lengthOrRadius ?? 10);
    } else {
      // C# BaseCylinder(LocalFrame, fLength = 20, fRadius = 10)
      this.frames = Frames.alongLine(lengthOrRadius ?? 20, frameOrFrames);
      this.radiusModulation = new SurfaceModulation(radius ?? 10);
    }
  }

  /** C# `SetRadius` — modulated radii bump the length sampling to 500. */
  setRadius(modulation: SurfaceModulation): void {
    this.radiusModulation = modulation;
    this.setLengthSteps(500);
  }

  setRadialSteps(steps: number): void {
    this.radialSteps = Math.max(5, steps);
  }

  setPolarSteps(steps: number): void {
    this.polarSteps = Math.max(5, steps);
  }

  setLengthSteps(steps: number): void {
    this.lengthSteps = Math.max(5, steps);
  }

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
    const builder = new MeshBuilder();
    this.addTopSurface(builder);
    this.addOuterMantle(builder);
    this.addBottomSurface(builder);
    return builder.build(pk);
  }

  /** Top disc at full length (C# `AddTopSurface`). */
  protected addTopSurface(builder: MeshBuilder): void {
    const lengthRatio = this.lengthRatioFromStep(this.lengthSteps - 1);
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      const phi1 = this.phiRatioFromStep(phiStep - 1);
      const phi2 = this.phiRatioFromStep(phiStep);
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        const r1 = this.radiusRatioFromStep(radiusStep - 1);
        const r2 = this.radiusRatioFromStep(radiusStep);
        const pt0 = this.surfacePoint(lengthRatio, phi1, r1);
        const pt1 = this.surfacePoint(lengthRatio, phi1, r2);
        const pt2 = this.surfacePoint(lengthRatio, phi2, r2);
        const pt3 = this.surfacePoint(lengthRatio, phi2, r1);
        builder.addTriangle(pt0, pt1, pt2);
        builder.addTriangle(pt0, pt2, pt3);
      }
    }
  }

  /** Bottom disc, wound the other way (C# `AddBottomSurface`). */
  protected addBottomSurface(builder: MeshBuilder): void {
    const lengthRatio = this.lengthRatioFromStep(0);
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      const phi1 = this.phiRatioFromStep(phiStep - 1);
      const phi2 = this.phiRatioFromStep(phiStep);
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        const r1 = this.radiusRatioFromStep(radiusStep - 1);
        const r2 = this.radiusRatioFromStep(radiusStep);
        const pt0 = this.surfacePoint(lengthRatio, phi1, r1);
        const pt1 = this.surfacePoint(lengthRatio, phi1, r2);
        const pt2 = this.surfacePoint(lengthRatio, phi2, r2);
        const pt3 = this.surfacePoint(lengthRatio, phi2, r1);
        builder.addTriangle(pt0, pt2, pt1);
        builder.addTriangle(pt0, pt3, pt2);
      }
    }
  }

  /** Outer mantle across phi and length (C# `AddOuterMantle`). */
  protected addOuterMantle(builder: MeshBuilder): void {
    const radiusRatio = this.radiusRatioFromStep(this.radialSteps - 1);
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      const phi1 = this.phiRatioFromStep(phiStep - 1);
      const phi2 = this.phiRatioFromStep(phiStep);
      for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
        const l1 = this.lengthRatioFromStep(lengthStep - 1);
        const l2 = this.lengthRatioFromStep(lengthStep);
        const pt0 = this.surfacePoint(l1, phi1, radiusRatio);
        const pt1 = this.surfacePoint(l2, phi1, radiusRatio);
        const pt2 = this.surfacePoint(l2, phi2, radiusRatio);
        const pt3 = this.surfacePoint(l1, phi2, radiusRatio);
        builder.addTriangle(pt0, pt2, pt1);
        builder.addTriangle(pt0, pt3, pt2);
      }
    }
  }

  protected radiusRatioFromStep(step: number): number {
    return (1 / (this.radialSteps - 1)) * step;
  }

  protected phiRatioFromStep(step: number): number {
    return (1 / (this.polarSteps - 1)) * step;
  }

  protected lengthRatioFromStep(step: number): number {
    return (1 / (this.lengthSteps - 1)) * step;
  }

  /**
   * Surface point at (lengthRatio, phiRatio, radiusRatio), all 0..1
   * (C# `vecGetSurfacePoint`).
   */
  surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const phi = 2 * Math.PI * phiRatio;
    const spine = this.frames.spineAt(lengthRatio);
    const localX = this.frames.localXAt(lengthRatio);
    const localY = this.frames.localYAt(lengthRatio);
    const radius = radiusRatio * this.radiusModulation.modulation(phi, lengthRatio);
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    return this.trafo([
      spine[0] + x * localX[0] + y * localY[0],
      spine[1] + x * localX[1] + y * localY[1],
      spine[2] + x * localX[2] + y * localY[2],
    ]);
  }
}

/** Cone: a BaseCylinder with a linear start→end radius (C# `BaseCone`). */
export class BaseCone extends BaseShape {
  protected readonly cylinder: BaseCylinder;

  constructor(frame: Frame, length: number, startRadius: number, endRadius: number) {
    super();
    this.cylinder = new BaseCylinder(frame, length);
    this.cylinder.setRadius(
      new SurfaceModulation((_phi: number, lengthRatio: number) => {
        const clamped = Math.min(1, Math.max(0, lengthRatio));
        return startRadius + clamped * (endRadius - startRadius);
      }),
    );
  }

  voxConstruct(pk: Pico): Voxels {
    this.cylinder.setTransformation(this.trafo);
    return this.cylinder.voxConstruct(pk);
  }

  /** The underlying cylinder (C# `oGetBaseCylinder`). */
  baseCylinder(): BaseCylinder {
    return this.cylinder;
  }
}
