// Derived from LEAP71_ShapeKernel — ShapeKernel/Frames/Frames.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R4); see NOTICE.
//
// A chain of local frames along a spine — ShapeKernel's transport machinery.
// MIN_ROTATION carries the previous sample's local X forward as the next
// alignment target (parallel transport), which keeps a swept cross-section
// from corkscrewing as the spine bends. `alignWithTargetX` is upstream's
// brute-force 0.01°-step search over the half-turn, ported verbatim —
// authoring math, Finding 8 rules it stays in JS unless phase splits prove it
// hot. The C# constructor overloads become static factories.

import { type Frame, frame } from '../numerics/frame.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import { localFrame } from './localFrame.ts';
import { splineOps } from './splineOperations.ts';
import type { Spline } from './splines.ts';
import { vecOps } from './vecOperations.ts';

export type FrameType = 'cylindrical' | 'spherical' | 'z' | 'minRotation';

export class Frames implements Spline {
  private spine: Vec3[] = [];
  private localX: Vec3[] = [];
  private localY: Vec3[] = [];
  private localZ: Vec3[] = [];
  private lastLocalX: Vec3 | null = null;

  private constructor() {}

  /** Extrude a const local frame along a straight line (C# `Frames(fLength, oConstLocalFrame, ...)`). */
  static alongLine(length: number, constFrame: Frame, reparametrisationSpacing = 1): Frames {
    const start = constFrame.pos;
    const end = vec3.add(start, vec3.scale(constFrame.lz, length));
    return Frames.alongSpline([start, end], constFrame, reparametrisationSpacing);
  }

  /** Extrude a const local frame along a spline (C# `Frames(aPoints, oConstLocalFrame, ...)`). */
  static alongSpline(points: readonly Vec3[], constFrame: Frame, reparametrisationSpacing = 1): Frames {
    const frames = new Frames();
    frames.spine = splineOps.reparametrizedBySpacing(points, reparametrisationSpacing);
    for (let i = 0; i < frames.spine.length; i += 1) {
      frames.localZ.push(constFrame.lz);
      frames.localX.push(constFrame.lx);
      frames.localY.push(constFrame.ly);
    }
    return frames;
  }

  /**
   * Tangential Z along the spline, X aligned to a const target direction,
   * then NURBS post-smoothing (C# `Frames(aPoints, vecTargetX, ...)`).
   */
  static withTargetX(points: readonly Vec3[], targetX: Vec3, reparametrisationSpacing = 1): Frames {
    const frames = new Frames();
    const target = vec3.safeNormalized(targetX);
    frames.spine = splineOps.reparametrizedBySpacing(points, reparametrisationSpacing);
    frames.localZ = frames.tangentDirections();
    for (let i = 0; i < frames.spine.length; i += 1) {
      frames.localX.push(Frames.alignWithTargetX(frames.localZ[i]!, target));
    }
    for (let i = 0; i < frames.spine.length; i += 1) {
      frames.localY.push(localFrame.localY(frames.localZ[i]!, frames.localX[i]!));
    }
    // Post processing: smooth every channel with matching sample counts.
    const samples = frames.spine.length;
    frames.spine = splineOps.nurbsSpline(frames.spine, samples);
    frames.localX = splineOps.nurbsSpline(frames.localX, samples);
    frames.localY = splineOps.nurbsSpline(frames.localY, samples);
    frames.localZ = splineOps.nurbsSpline(frames.localZ, samples);
    return frames;
  }

  /**
   * Tangential Z along the spline, X from a coordinate-system-dependent target
   * — incl. MIN_ROTATION parallel transport (C# `Frames(aPoints, eFrameType, ...)`).
   */
  static ofType(points: readonly Vec3[], frameType: FrameType, reparametrisationSpacing = 1): Frames {
    const frames = new Frames();
    frames.spine = splineOps.reparametrizedBySpacing(points, reparametrisationSpacing);
    frames.localZ = frames.tangentDirections();
    for (let i = 0; i < frames.spine.length; i += 1) {
      frames.localX.push(frames.alignWithFramesType(frames.spine[i]!, frames.localZ[i]!, frameType));
    }
    for (let i = 0; i < frames.spine.length; i += 1) {
      frames.localY.push(localFrame.localY(frames.localZ[i]!, frames.localX[i]!));
    }
    return frames;
  }

  /** Transform all points and axes onto a frame's coordinate system, in place (C# `ApplyToFrame`). */
  applyToFrame(f: Frame): void {
    for (let i = 0; i < this.spine.length; i += 1) {
      this.spine[i] = frame.ptToWorld(f, this.spine[i]!);
      this.localX[i] = frame.dirToWorld(f, this.localX[i]!);
      this.localY[i] = frame.dirToWorld(f, this.localY[i]!);
      this.localZ[i] = frame.dirToWorld(f, this.localZ[i]!);
    }
  }

  /** MIN_ROTATION carries the last local X; other types delegate to targetXFor (C# `vecAlignWithFramesType`). */
  private alignWithFramesType(pt: Vec3, localZ: Vec3, frameType: FrameType): Vec3 {
    if (frameType === 'minRotation') {
      if (this.lastLocalX === null) {
        const target = Frames.targetXFor(pt, 'z');
        this.lastLocalX = Frames.alignWithTargetX(localZ, target);
      }
      const localX = Frames.alignWithTargetX(localZ, this.lastLocalX);
      this.lastLocalX = localX;
      return localX;
    }
    return Frames.alignWithTargetX(localZ, Frames.targetXFor(pt, frameType));
  }

  /**
   * Best in-plane direction matching the target: brute-force 0.01° sweep over
   * the half turn, then flipped for alignment (C# `vecAlignWithTargetX`).
   */
  static alignWithTargetX(localZ: Vec3, targetX: Vec3): Vec3 {
    const initLocalX = vecOps.orthogonalDir(localZ);
    const initLocalY = vec3.cross(initLocalX, localZ);
    let maxDot = Math.abs(vec3.dot(initLocalX, targetX));
    let finalLocalX = initLocalX;
    for (let angleDeg = 0; angleDeg < 180; angleDeg += 0.01) {
      const phi = ((2 * Math.PI) / 360) * angleDeg;
      const candidate = vec3.add(
        vec3.scale(initLocalX, Math.cos(phi)),
        vec3.scale(initLocalY, Math.sin(phi)),
      );
      const dot = Math.abs(vec3.dot(candidate, targetX));
      if (dot > maxDot) {
        finalLocalX = candidate;
        maxDot = dot;
      }
    }
    return vec3.safeNormalized(vecOps.flipForAlignment(finalLocalX, targetX));
  }

  /** The alignment target per frame type (C# `vecGetTargetX`). */
  static targetXFor(pt: Vec3, frameType: FrameType): Vec3 {
    if (frameType === 'cylindrical') return vec3.safeNormalized([pt[0], pt[1], 0]);
    if (frameType === 'spherical') return vec3.safeNormalized(pt);
    return vec3.unitZ;
  }

  /** Forward differences, endpoints repeated for continuity (C# `aGetTangentDirections`). */
  private tangentDirections(): Vec3[] {
    const tangents: Vec3[] = [];
    for (let i = 1; i < this.spine.length - 1; i += 1) {
      tangents.push(vec3.safeNormalized(vec3.sub(this.spine[i]!, this.spine[i - 1]!)));
    }
    tangents.unshift(tangents[0]!);
    tangents.push(tangents[tangents.length - 1]!);
    return tangents;
  }

  private sampleChannel(channel: readonly Vec3[], lengthRatio: number): Vec3 {
    const clamped = Math.min(1, Math.max(0, lengthRatio));
    const step = clamped * (channel.length - 1);
    const lower = Math.trunc(Math.min(step, channel.length - 1));
    const upper = Math.trunc(Math.min(step + 1, channel.length - 1));
    return vec3.lerp(channel[lower]!, channel[upper]!, step - lower);
  }

  /** Spine position at a length ratio 0..1 (C# `vecGetSpineAlongLength`). */
  spineAt(lengthRatio: number): Vec3 {
    return this.sampleChannel(this.spine, lengthRatio);
  }

  /** Local X at a length ratio (C# `vecGetLocalXAlongLength`). */
  localXAt(lengthRatio: number): Vec3 {
    return this.sampleChannel(this.localX, lengthRatio);
  }

  /** Local Y at a length ratio (C# `vecGetLocalYAlongLength`). */
  localYAt(lengthRatio: number): Vec3 {
    return this.sampleChannel(this.localY, lengthRatio);
  }

  /** Local Z at a length ratio (C# `vecGetLocalZAlongLength`). */
  localZAt(lengthRatio: number): Vec3 {
    return this.sampleChannel(this.localZ, lengthRatio);
  }

  /** The full local frame at a length ratio (C# `oGetLocalFrame`). */
  frameAt(lengthRatio: number): Frame {
    return localFrame.createZX(
      this.spineAt(lengthRatio),
      this.localZAt(lengthRatio),
      this.localXAt(lengthRatio),
    );
  }

  /** The spine points (C# `aGetPoints()`); with `samples`, reparametrized to that count. */
  points(samples?: number): Vec3[] {
    if (samples === undefined) return this.spine;
    return splineOps.reparametrizedByCount(this.spine, samples);
  }
}
