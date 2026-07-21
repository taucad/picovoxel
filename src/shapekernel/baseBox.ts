// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseBox.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R5); see NOTICE.
// (BaseLogoBox is image-input-bound and not ported — graded N/A.)

import type { Mesh } from '../mesh.ts';
import type { Frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Bounds, Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, MeshBuilder, type MeshBaseShape, type SurfaceBaseShape } from './baseShape.ts';
import { Frames } from './frames.ts';
import { localFrame } from './localFrame.ts';
import { LineModulation } from './modulations.ts';

/**
 * Box along a straight frame or spine with width/depth line modulations
 * (C# `BaseBox`). Width maps to local X, depth to local Y; width and depth
 * ratios run -1..1, the length ratio 0..1.
 */
export class BaseBox extends BaseShape implements MeshBaseShape, SurfaceBaseShape {
  protected lengthSteps = 5;
  protected widthSteps = 5;
  protected depthSteps = 5;
  protected widthModulation: LineModulation;
  protected depthModulation: LineModulation;
  protected frames: Frames;

  constructor(frameOrFrames: Frame | Frames, a?: number, b?: number, c?: number) {
    super();
    if (frameOrFrames instanceof Frames) {
      // C# BaseBox(Frames, fWidth = 20, fDepth = 20)
      this.frames = frameOrFrames;
      this.setLengthSteps(500);
      this.widthModulation = new LineModulation(a ?? 20);
      this.depthModulation = new LineModulation(b ?? 20);
    } else {
      // C# BaseBox(LocalFrame, fLength = 20, fWidth = 20, fDepth = 20)
      this.frames = Frames.alongLine(a ?? 20, frameOrFrames);
      this.widthModulation = new LineModulation(b ?? 20);
      this.depthModulation = new LineModulation(c ?? 20);
    }
  }

  /** From a bounding box: centred in XY, based at min Z (C# `BaseBox(BBox3)`). */
  static fromBounds(bounds: Bounds): BaseBox {
    const size: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const centre: Vec3 = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      bounds.min[2],
    ];
    return new BaseBox(localFrame.create(centre), size[2], size[0], size[1]);
  }

  /** C# `SetWidth` — modulated width bumps width+length sampling to 500. */
  setWidth(modulation: LineModulation): void {
    this.widthModulation = modulation;
    this.setWidthSteps(500);
    this.setLengthSteps(500);
  }

  /** C# `SetDepth` — modulated depth bumps depth+length sampling to 500. */
  setDepth(modulation: LineModulation): void {
    this.depthModulation = modulation;
    this.setDepthSteps(500);
    this.setLengthSteps(500);
  }

  setWidthSteps(steps: number): void {
    this.widthSteps = Math.max(5, steps);
  }

  setDepthSteps(steps: number): void {
    this.depthSteps = Math.max(5, steps);
  }

  setLengthSteps(steps: number): void {
    this.lengthSteps = Math.max(5, steps);
  }

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
    const builder = new MeshBuilder();
    this.addLengthCap(builder, this.lengthSteps - 1, true); // top (C# AddTopSurface flipped)
    this.addLengthCap(builder, 0, false); // bottom
    this.addWidthCap(builder, 0, true); // front
    this.addWidthCap(builder, this.widthSteps - 1, false); // back
    this.addDepthCap(builder, this.depthSteps - 1, true); // right
    this.addDepthCap(builder, 0, false); // left
    return builder.build(pk);
  }

  /** Face at a fixed length step, iterating width×depth (C# `AddTopSurface`/`AddBottomSurface`). */
  private addLengthCap(builder: MeshBuilder, lengthStep: number, flip: boolean): void {
    const lr = this.lengthRatioFromStep(lengthStep);
    for (let widthStep = 1; widthStep < this.widthSteps; widthStep += 1) {
      const w1 = this.widthRatioFromStep(widthStep - 1);
      const w2 = this.widthRatioFromStep(widthStep);
      for (let depthStep = 1; depthStep < this.depthSteps; depthStep += 1) {
        const d1 = this.depthRatioFromStep(depthStep - 1);
        const d2 = this.depthRatioFromStep(depthStep);
        const pt0 = this.surfacePoint(w1, d1, lr);
        const pt1 = this.surfacePoint(w1, d2, lr);
        const pt2 = this.surfacePoint(w2, d2, lr);
        const pt3 = this.surfacePoint(w2, d1, lr);
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

  /** Face at a fixed width step, iterating length×depth (C# `AddFrontSurface`/`AddBackSurface`). */
  private addWidthCap(builder: MeshBuilder, widthStep: number, flip: boolean): void {
    const w = this.widthRatioFromStep(widthStep);
    for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
      const l1 = this.lengthRatioFromStep(lengthStep - 1);
      const l2 = this.lengthRatioFromStep(lengthStep);
      for (let depthStep = 1; depthStep < this.depthSteps; depthStep += 1) {
        const d1 = this.depthRatioFromStep(depthStep - 1);
        const d2 = this.depthRatioFromStep(depthStep);
        const pt0 = this.surfacePoint(w, d1, l1);
        const pt1 = this.surfacePoint(w, d2, l1);
        const pt2 = this.surfacePoint(w, d2, l2);
        const pt3 = this.surfacePoint(w, d1, l2);
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

  /** Face at a fixed depth step, iterating length×width (C# `AddLeftSurface`/`AddRightSurface`). */
  private addDepthCap(builder: MeshBuilder, depthStep: number, flip: boolean): void {
    const d = this.depthRatioFromStep(depthStep);
    for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
      const l1 = this.lengthRatioFromStep(lengthStep - 1);
      const l2 = this.lengthRatioFromStep(lengthStep);
      for (let widthStep = 1; widthStep < this.widthSteps; widthStep += 1) {
        const w1 = this.widthRatioFromStep(widthStep - 1);
        const w2 = this.widthRatioFromStep(widthStep);
        const pt0 = this.surfacePoint(w1, d, l1);
        const pt1 = this.surfacePoint(w2, d, l1);
        const pt2 = this.surfacePoint(w2, d, l2);
        const pt3 = this.surfacePoint(w1, d, l2);
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

  protected depthRatioFromStep(step: number): number {
    return 2 * ((1 / (this.depthSteps - 1)) * step) - 1; // -1..+1
  }

  protected widthRatioFromStep(step: number): number {
    return 2 * ((1 / (this.widthSteps - 1)) * step) - 1; // -1..+1
  }

  protected lengthRatioFromStep(step: number): number {
    return (1 / (this.lengthSteps - 1)) * step; // 0..1
  }

  /** Surface point; width/depth ratios -1..1, length ratio 0..1 (C# `vecGetSurfacePoint`). */
  surfacePoint(widthRatio: number, depthRatio: number, lengthRatio: number): Vec3 {
    const spine = this.frames.spineAt(lengthRatio);
    const localX = this.frames.localXAt(lengthRatio);
    const localY = this.frames.localYAt(lengthRatio);
    const x = 0.5 * widthRatio * this.widthModulation.modulation(lengthRatio);
    const y = 0.5 * depthRatio * this.depthModulation.modulation(lengthRatio);
    return this.trafo([
      spine[0] + x * localX[0] + y * localY[0],
      spine[1] + x * localX[1] + y * localY[1],
      spine[2] + x * localX[2] + y * localY[2],
    ]);
  }
}
