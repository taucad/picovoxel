// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/{LatticePipe,LatticeManifold}.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R6); see NOTICE.

import type { Lattice } from '../lattice.ts';
import type { Frame } from '../numerics/frame.ts';
import type { PicoGK } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { BaseShape, type LatticeBaseShape, type SpineBaseShape } from './baseShape.ts';
import { Frames } from './frames.ts';
import { LineModulation } from './modulations.ts';

/** Round pipe built from lattice beams along a frame or spine (C# `LatticePipe`). */
export class LatticePipe extends BaseShape implements LatticeBaseShape, SpineBaseShape {
  protected radiusModulation: LineModulation;
  protected lengthSteps: number;
  protected frames: Frames;

  constructor(frameOrFrames: Frame | Frames, lengthOrRadius?: number, radius?: number) {
    super();
    if (frameOrFrames instanceof Frames) {
      // C# LatticePipe(Frames, fRadius = 10)
      this.frames = frameOrFrames;
      this.lengthSteps = 500;
      this.radiusModulation = new LineModulation(lengthOrRadius ?? 10);
    } else {
      // C# LatticePipe(LocalFrame, fLength, fRadius = 10) — length is required.
      this.frames = Frames.alongLine(lengthOrRadius!, frameOrFrames);
      this.lengthSteps = 100;
      this.radiusModulation = new LineModulation(radius ?? 10);
    }
  }

  setRadius(modulation: LineModulation): void {
    this.radiusModulation = modulation;
  }

  /** No lower clamp upstream. */
  setLengthSteps(steps: number): void {
    this.lengthSteps = steps;
  }

  voxConstruct(pk: PicoGK): Voxels {
    return this.latConstruct(pk).toVoxels();
  }

  /** Chained beams along the spine (C# `latConstruct`). */
  latConstruct(pk: PicoGK): Lattice {
    const lattice = pk.createLattice();
    for (let zStep = 1; zStep < this.lengthSteps; zStep += 1) {
      const l0 = (1 / this.lengthSteps) * (zStep - 1);
      const l1 = (1 / this.lengthSteps) * zStep;
      const pt0 = this.spinePoint(l0);
      const pt1 = this.spinePoint(l1);
      lattice.addBeam({
        start: pt0,
        end: pt1,
        startRadius: this.radius(l0),
        endRadius: this.radius(l1),
      });
    }
    return lattice;
  }

  /** Centre-axis position along the pipe (C# `vecGetSpinePoint`). */
  spinePoint(lengthRatio: number): Vec3 {
    return this.trafo(this.frames.spineAt(lengthRatio));
  }

  protected radius(lengthRatio: number): number {
    return this.radiusModulation.modulation(lengthRatio);
  }
}

export interface LatticeManifoldOptions {
  /** Required for the Frame form; ignored for a Frames spine. */
  length?: number;
  radius?: number;
  /** Degrees; dictates the teardrop tip (C# `fMaxOverhangAngle = 45`). */
  maxOverhangAngle?: number;
  /** Extend the teardrop in -Z as well (C# `bExtendBothSides = false`). */
  extendBothSides?: boolean;
  /** C# `fMinPrintableRadius = 0.1`. */
  minPrintableRadius?: number;
}

/**
 * Manifold pipe: a LatticePipe whose cross-section grows teardrop tips so
 * every overhang stays printable (C# `LatticeManifold`).
 */
export class LatticeManifold extends LatticePipe {
  protected readonly maxPrintableRadius: number;
  protected readonly limitAngle: number;
  protected readonly extendBothSides: boolean;

  constructor(frameOrFrames: Frame | Frames, options: LatticeManifoldOptions = {}) {
    if (frameOrFrames instanceof Frames) {
      super(frameOrFrames, options.radius ?? 10);
      this.setLengthSteps(500);
    } else {
      super(frameOrFrames, options.length ?? 20, options.radius ?? 10);
      this.setLengthSteps(100);
    }
    this.maxPrintableRadius = options.minPrintableRadius ?? 0.1;
    this.limitAngle = options.maxOverhangAngle ?? 45;
    this.extendBothSides = options.extendBothSides ?? false;
  }

  override latConstruct(pk: PicoGK): Lattice {
    const lattice = pk.createLattice();
    for (let zStep = 0; zStep < this.lengthSteps; zStep += 1) {
      const lengthRatio = (1 / this.lengthSteps) * zStep;
      const pt = this.spinePoint(lengthRatio);
      const beam = this.radius(lengthRatio);
      // Round pipe point (a zero-length beam = sphere node with caps).
      lattice.addBeam({ start: pt, end: pt, radius: beam });
      this.addTip(lattice, pt, beam, true);
      if (this.extendBothSides) this.addTip(lattice, pt, beam, false);
    }
    return lattice;
  }

  /** Teardrop tip via circular-segment geometry (C# `AddTip`). */
  protected addTip(lattice: Lattice, pt: Vec3, beam: number, zPositive: boolean): void {
    const halfAlpha = 90 - this.limitAngle;
    const r = beam;
    const h = r * (1 - Math.cos((halfAlpha / 180) * Math.PI));
    const s = 2 * r * Math.sin((halfAlpha / 180) * Math.PI);
    const tipLength = Math.tan((halfAlpha / 180) * Math.PI) * (0.5 * s - this.maxPrintableRadius);
    const sign = zPositive ? 1 : -1;
    const midChord: Vec3 = [pt[0], pt[1], pt[2] + sign * (r - h)];
    const tip: Vec3 = [midChord[0], midChord[1], midChord[2] + sign * tipLength];
    lattice.addBeam({
      start: midChord,
      end: tip,
      startRadius: 0.5 * s,
      endRadius: this.maxPrintableRadius,
      roundCap: false,
    });
  }
}
