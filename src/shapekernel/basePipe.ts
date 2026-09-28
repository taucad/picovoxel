// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/{BasePipe,BasePipeSegment}.cs
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
import { LineModulation, SurfaceModulation } from './modulations.ts';

/** Spine point, local X and local Y at one length ratio. */
type PipeAxes = readonly [spine: Vec3, localX: Vec3, localY: Vec3];

/**
 * Adds the `outer × inner` grid of distinct surface points once, outer-major,
 * and returns the index of point (0, 0). C# computes each point once per
 * adjacent quad (up to four times) and gives every triangle fresh vertices;
 * the coordinates and triangles here are the same, the vertices shared.
 */
function addPointGrid(
  builder: MeshBuilder,
  outerSteps: number,
  innerSteps: number,
  point: (outer: number, inner: number) => Vec3,
): number {
  const first = builder.vertexCount;
  for (let outer = 0; outer < outerSteps; outer += 1) {
    for (let inner = 0; inner < innerSteps; inner += 1) {
      builder.addVertex(point(outer, inner));
    }
  }
  return first;
}

/** The two triangles of quad (pt0, pt1, pt2, pt3) by vertex index, in C#'s order and winding. */
function addGridQuad(
  builder: MeshBuilder,
  pt0: number,
  pt1: number,
  pt2: number,
  pt3: number,
  flip: boolean,
): void {
  if (!flip) {
    builder.addIndexedTriangle(pt0, pt1, pt2);
    builder.addIndexedTriangle(pt0, pt2, pt3);
  } else {
    builder.addIndexedTriangle(pt0, pt2, pt1);
    builder.addIndexedTriangle(pt0, pt3, pt2);
  }
}

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

  voxConstruct(pk: Pico): Voxels {
    return this.mshConstruct(pk).toVoxels();
  }

  mshConstruct(pk: Pico): Mesh {
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
    // Loops run while step < steps, so a fractional step count visits ceil(steps) stations.
    const radii = Math.ceil(this.radialSteps);
    const first = addPointGrid(builder, Math.ceil(this.polarSteps), radii, (phiStep, radiusStep) =>
      this.surfacePoint(lengthRatio, this.phiRatioFromStep(phiStep), this.radiusRatioFromStep(radiusStep)),
    );
    const at = (phiStep: number, radiusStep: number) => first + phiStep * radii + radiusStep;
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        addGridQuad(
          builder,
          at(phiStep - 1, radiusStep - 1),
          at(phiStep - 1, radiusStep),
          at(phiStep, radiusStep),
          at(phiStep, radiusStep - 1),
          flip,
        );
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
    // Length-major, so each length station's frame axes are sampled once (axesAt).
    const phis = Math.ceil(this.polarSteps);
    const first = addPointGrid(builder, Math.ceil(this.lengthSteps), phis, (lengthStep, phiStep) =>
      this.surfacePoint(this.lengthRatioFromStep(lengthStep), this.phiRatioFromStep(phiStep), radiusRatio),
    );
    const at = (phiStep: number, lengthStep: number) => first + lengthStep * phis + phiStep;
    for (let phiStep = 1; phiStep < this.polarSteps; phiStep += 1) {
      for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
        addGridQuad(
          builder,
          at(phiStep - 1, lengthStep - 1),
          at(phiStep - 1, lengthStep),
          at(phiStep, lengthStep),
          at(phiStep, lengthStep - 1),
          flip,
        );
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

  private axesCache: readonly [number, PipeAxes] | undefined;

  /**
   * Spine point and local axes at a length ratio. They depend on the length
   * ratio alone, and tessellation visits one length station for a whole row of
   * points, so the last station is kept (C# re-samples them for every point).
   */
  protected axesAt(lengthRatio: number): PipeAxes {
    const cached = this.axesCache;
    if (cached !== undefined && cached[0] === lengthRatio) {
      return cached[1];
    }
    const axes: PipeAxes = [
      this.frames.spineAt(lengthRatio),
      this.frames.localXAt(lengthRatio),
      this.frames.localYAt(lengthRatio),
    ];
    this.axesCache = [lengthRatio, axes];
    return axes;
  }

  /** Surface point; radiusRatio spans inner→outer (C# `vecGetSurfacePoint`). */
  surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const [spine, localX, localY] = this.axesAt(lengthRatio);
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

  override mshConstruct(pk: Pico): Mesh {
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
    const radii = Math.ceil(this.radialSteps);
    const first = addPointGrid(builder, Math.ceil(this.lengthSteps), radii, (lengthStep, radiusStep) =>
      this.surfacePoint(this.lengthRatioFromStep(lengthStep), phiRatio, this.radiusRatioFromStep(radiusStep)),
    );
    const at = (lengthStep: number, radiusStep: number) => first + lengthStep * radii + radiusStep;
    for (let lengthStep = 1; lengthStep < this.lengthSteps; lengthStep += 1) {
      for (let radiusStep = 1; radiusStep < this.radialSteps; radiusStep += 1) {
        addGridQuad(
          builder,
          at(lengthStep - 1, radiusStep - 1),
          at(lengthStep - 1, radiusStep),
          at(lengthStep, radiusStep),
          at(lengthStep, radiusStep - 1),
          flip,
        );
      }
    }
  }

  /** Phi spans mid ± range/2 at the length ratio (C# override). */
  override surfacePoint(lengthRatio: number, phiRatio: number, radiusRatio: number): Vec3 {
    const [spine, localX, localY] = this.axesAt(lengthRatio);
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
