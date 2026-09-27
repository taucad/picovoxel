// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseRevolve.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.

import type { Mesh } from '../mesh.ts';
import { type Frame, frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { Frames } from './frames.ts';
import { localFrame } from './localFrame.ts';
import { LineModulation, type GenericContour } from './modulations.ts';
import { vecOps } from './vecOperations.ts';

/**
 * Revolves a spine cross-section about the reference frame's Z axis
 * (C# `BaseRevolve`). Inward and outward radii count positive away from the
 * spine.
 */
export class BaseRevolve extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected lengthSteps = 500;
  protected polarSteps = 360;
  protected radialSteps = 100;
  protected readonly frames: Frames;
  protected readonly frame: Frame;
  protected outerRadiusModulation: LineModulation;
  protected innerRadiusModulation: LineModulation;

  constructor(referenceFrame: Frame, frames: Frames, inwardRadius = 3, outwardRadius = 3) {
    super();
    this.frame = referenceFrame;
    this.outerRadiusModulation = new LineModulation(outwardRadius);
    this.innerRadiusModulation = new LineModulation(inwardRadius);
    this.frames = frames;
  }

  setRadius(innerRadius: LineModulation, outerRadius: LineModulation): void {
    this.innerRadiusModulation = innerRadius;
    this.outerRadiusModulation = outerRadius;
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
    this.addLengthCap(builder, this.lengthSteps - 1, false); // top
    this.addMantle(builder, 0, false); // inner
    this.addMantle(builder, this.radialSteps - 1, true); // outer
    this.addLengthCap(builder, 0, true); // bottom
    return builder.build(pk);
  }

  private addLengthCap(builder: MeshBuilder, lengthStep: number, flip: boolean): void {
    const lengthRatio = this.lengthRatioFromStep(lengthStep);
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

  private addMantle(builder: MeshBuilder, radiusStep: number, flip: boolean): void {
    const radiusRatio = this.radiusRatioFromStep(radiusStep);
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

  protected lengthRatioFromStep(step: number): number {
    return (1 / (this.lengthSteps - 1)) * step;
  }

  /** Spine offset along local X, revolved about the reference frame's Z axis (C# `vecGetSurfacePoint`). */
  surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const spine = this.frames.spineAt(lengthRatio);
    const localX = this.frames.localXAt(lengthRatio);
    const phi = 2 * Math.PI * phiRatio;
    const outward = this.outerRadiusModulation.modulation(lengthRatio);
    const inward = -this.innerRadiusModulation.modulation(lengthRatio);
    const radius = radiusRatio * (outward - inward) + inward;
    const pt: Vec3 = [
      spine[0] + radius * localX[0],
      spine[1] + radius * localX[1],
      spine[2] + radius * localX[2],
    ];
    return this.trafo(vecOps.rotateAroundAxis(pt, phi, this.frame.lz, this.frame.pos));
  }

  /** Spine position (C# `vecGetSpineAlongLength`). */
  spinePoint(lengthRatio: number): Vec3 {
    return this.frames.spineAt(lengthRatio);
  }

  /** Outer surface point at (phi, lengthRatio) (C# `vecGetOuterSurfacePoint`). */
  outerSurfacePoint(phi: number, lengthRatio: number): Vec3 {
    return this.surfacePoint(lengthRatio, phi / (2 * Math.PI), 1);
  }

  /** Inner surface point at (phi, lengthRatio) (C# `vecGetInnerSurfacePoint`). */
  innerSurfacePoint(phi: number, lengthRatio: number): Vec3 {
    return this.surfacePoint(lengthRatio, phi / (2 * Math.PI), 0);
  }

  /** Cylindrical frames traced from a rotationally-symmetric contour (C# `aGetFramesFromContour`). */
  static framesFromContour(contour: GenericContour, referenceFrame: Frame = localFrame.identity): Frames {
    const samples = 500;
    const points: Vec3[] = [];
    for (let i = 0; i < samples; i += 1) {
      const lr = (1 / (samples - 1)) * i;
      const z = lr * contour.totalLength;
      const radius = contour.modulation.modulation(lr);
      points.push(frame.ptToWorld(referenceFrame, [radius, 0, z]));
    }
    return Frames.ofType(points, 'cylindrical', 0.5);
  }
}
