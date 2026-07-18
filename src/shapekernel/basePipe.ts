// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/{BasePipe,BasePipeSegment}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R5); see NOTICE.

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import type { PicoGK } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { Frames } from './frames.ts';
import { LineModulation, SurfaceModulation } from './modulations.ts';

/** Pipe (annular cylinder) along a straight frame or spine (C# `BasePipe`). */
export class BasePipe extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected lengthSteps = 5;
  protected polarSteps = 360;
  protected radialSteps = 5;
  protected outerRadiusModulation: SurfaceModulation;
  protected innerRadiusModulation: SurfaceModulation;
  protected frames: Frames;

  constructor(frameOrFrames: Frame | Frames, a?: number, b?: number, c?: number) {
    super();
    if (frameOrFrames instanceof Frames) {
      // C# BasePipe(Frames, fInnerRadius = 10, fOuterRadius = 20)
      this.frames = frameOrFrames;
      this.setLengthSteps(500);
      this.innerRadiusModulation = new SurfaceModulation(a ?? 10);
      this.outerRadiusModulation = new SurfaceModulation(b ?? 20);
    } else {
      // C# BasePipe(LocalFrame, fLength = 20, fInnerRadius = 10, fOuterRadius = 20)
      this.frames = Frames.alongLine(a ?? 20, frameOrFrames);
      this.innerRadiusModulation = new SurfaceModulation(b ?? 10);
      this.outerRadiusModulation = new SurfaceModulation(c ?? 20);
    }
  }

  /** C# `SetRadius(inner, outer)` — bumps length sampling to 500. */
  setRadius(innerRadius: SurfaceModulation, outerRadius: SurfaceModulation): void {
    this.innerRadiusModulation = innerRadius;
    this.outerRadiusModulation = outerRadius;
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

  voxConstruct(pk: PicoGK): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: PicoGK): Mesh {
    const builder = new MeshBuilder();
    this.addTopSurface(builder, false);
    this.addBottomSurface(builder, true);
    this.addInnerMantle(builder, false);
    this.addOuterMantle(builder, true);
    return builder.build(pk);
  }

  /** Annular disc at a fixed length step (C# `AddTopSurface`/`AddBottomSurface`). */
  private addAnnulus(builder: MeshBuilder, lengthStep: number, flip: boolean): void {
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

  protected addTopSurface(builder: MeshBuilder, flip = false): void {
    this.addAnnulus(builder, this.lengthSteps - 1, flip);
  }

  protected addBottomSurface(builder: MeshBuilder, flip = false): void {
    this.addAnnulus(builder, 0, flip);
  }

  /** Mantle at a fixed radius step (C# `AddOuterMantle`/`AddInnerMantle`). */
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

  protected addOuterMantle(builder: MeshBuilder, flip = false): void {
    this.addMantle(builder, this.radialSteps - 1, flip);
  }

  protected addInnerMantle(builder: MeshBuilder, flip = false): void {
    this.addMantle(builder, 0, flip);
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

  /** Surface point; radiusRatio spans inner→outer (C# `vecGetSurfacePoint`). */
  surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const spine = this.frames.spineAt(lengthRatio);
    const localX = this.frames.localXAt(lengthRatio);
    const localY = this.frames.localYAt(lengthRatio);
    const phi = 2 * Math.PI * phiRatio;
    const outer = this.outerRadiusModulation.modulation(phi, lengthRatio);
    const inner = this.innerRadiusModulation.modulation(phi, lengthRatio);
    const radius = radiusRatio * (outer - inner) + inner;
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    return this.trafo([
      spine[0] + x * localX[0] + y * localY[0],
      spine[1] + x * localX[1] + y * localY[1],
      spine[2] + x * localX[2] + y * localY[2],
    ]);
  }
}

export type PipeSegmentMethod = 'startEnd' | 'midRange';

export interface PipeSegmentOptions {
  /** Required for the Frame form; ignored when a Frames spine is given (C# ctor split). */
  length?: number;
  innerRadius: number;
  outerRadius: number;
  /** START_END: the start phi modulation; MID_RANGE: the mid phi modulation. */
  startOrMid: LineModulation;
  /** START_END: the end phi modulation; MID_RANGE: the phi range modulation. */
  endOrRange: LineModulation;
  method: PipeSegmentMethod;
}

/**
 * Angular pipe segment; the circumferential range comes from two line
 * modulations, interpreted per `method` (C# `BasePipeSegment` + `EMethod`;
 * the two C# constructors become one options object per the repo idiom rules).
 */
export class BasePipeSegment extends BasePipe {
  protected readonly rangeModulation: LineModulation;
  protected readonly midModulation: LineModulation;

  constructor(frameOrFrames: Frame | Frames, options: PipeSegmentOptions) {
    if (frameOrFrames instanceof Frames) {
      super(frameOrFrames, options.innerRadius, options.outerRadius);
    } else {
      super(frameOrFrames, options.length ?? 20, options.innerRadius, options.outerRadius);
    }
    if (options.method === 'startEnd') {
      this.midModulation = options.startOrMid.add(options.endOrRange).scale(0.5);
      this.rangeModulation = options.endOrRange.sub(options.startOrMid);
    } else {
      this.midModulation = options.startOrMid;
      this.rangeModulation = options.endOrRange;
    }
  }

  override mshConstruct(pk: PicoGK): Mesh {
    const builder = new MeshBuilder();
    this.addTopSurface(builder, false);
    this.addBottomSurface(builder, true);
    this.addInnerMantle(builder, false);
    this.addOuterMantle(builder, true);
    this.addPhiCap(builder, 0, false); // C# AddStartSurface
    this.addPhiCap(builder, this.polarSteps - 1, true); // C# AddEndSurface
    return builder.build(pk);
  }

  /** Radial cap at a fixed phi step (C# `AddStartSurface`/`AddEndSurface`). */
  private addPhiCap(builder: MeshBuilder, phiStep: number, flip: boolean): void {
    const phiRatio = this.phiRatioFromStep(phiStep);
    for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
      const l1 = this.lengthRatioFromStep(lengthStep - 1);
      const l2 = this.lengthRatioFromStep(lengthStep);
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        const r1 = this.radiusRatioFromStep(radiusStep - 1);
        const r2 = this.radiusRatioFromStep(radiusStep);
        const pt0 = this.surfacePoint(l1, phiRatio, r1);
        const pt1 = this.surfacePoint(l1, phiRatio, r2);
        const pt2 = this.surfacePoint(l2, phiRatio, r2);
        const pt3 = this.surfacePoint(l2, phiRatio, r1);
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

  /** Phi spans mid ± range/2 at the length ratio (C# override). */
  override surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const spine = this.frames.spineAt(lengthRatio);
    const localX = this.frames.localXAt(lengthRatio);
    const localY = this.frames.localYAt(lengthRatio);
    const phi =
      this.midModulation.modulation(lengthRatio) +
      (phiRatio - 0.5) * this.rangeModulation.modulation(lengthRatio);
    const outer = this.outerRadiusModulation.modulation(phi, lengthRatio);
    const inner = this.innerRadiusModulation.modulation(phi, lengthRatio);
    const radius = radiusRatio * (outer - inner) + inner;
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    return this.trafo([
      spine[0] + x * localX[0] + y * localY[0],
      spine[1] + x * localX[1] + y * localY[1],
      spine[2] + x * localX[2] + y * localY[2],
    ]);
  }
}
