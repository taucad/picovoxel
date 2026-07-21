// Derived from LEAP71_ShapeKernel — ShapeKernel/Frames/LocalFrame.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel (blueprint R4); see NOTICE.
//
// Per Finding 9 of the real-world-subjects blueprint there is ONE frame type:
// a LocalFrame IS the numerics `Frame`. This module ports only the
// construction helpers — the C# LocalFrame⇄Frame3d implicit-conversion bridge
// is unnecessary and not reproduced. Semantic note kept from upstream:
// LocalFrame construction normalizes Z and X and takes Y = Z×X WITHOUT
// re-orthogonalizing X against Z (unlike `frame.fromZX`'s Gram-Schmidt) — a
// caller-supplied skew X stays skew, exactly as C# behaves. Zero-length axes
// throw, where Frame3d would silently safe-normalize.

import { PicoError } from '../errors.ts';
import { type Frame, frame } from '../numerics/frame.ts';
import { vec3 } from '../numerics/vector.ts';
import type { Vec3 } from '../types.ts';
import { vecOps } from './vecOperations.ts';

function normalizedAxis(v: Vec3, name: string): Vec3 {
  if (vec3.lengthSquared(v) === 0) {
    throw new PicoError('PICO_INVALID_ARGUMENT', `Local ${name} Coordinate has a length of Zero!`);
  }
  const length = vec3.length(v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** ShapeKernel `LocalFrame` construction helpers over the numerics `Frame`. */
export const localFrame = {
  /** World-aligned frame at the origin (C# `LocalFrame()`). */
  identity: frame.world,

  /** World-aligned axes at a position (C# `LocalFrame(vecPos)`). */
  create: (pos: Vec3): Frame => ({ pos, lx: vec3.unitX, ly: vec3.unitY, lz: vec3.unitZ }),

  /** Same axes as the base frame at a new position (C# `LocalFrame(oBaseFrame, vecNewPos)`). */
  at: (base: Frame, newPos: Vec3): Frame => ({ pos: newPos, lx: base.lx, ly: base.ly, lz: base.lz }),

  /**
   * Position + local Z; X is an arbitrary orthogonal direction to Z
   * (C# `LocalFrame(vecPos, vecLocalZ)`).
   */
  createZ(pos: Vec3, localZ: Vec3): Frame {
    const lz = normalizedAxis(localZ, 'Z');
    const lx = vecOps.orthogonalDir(lz);
    return { pos, lx, ly: localFrame.localY(lz, lx), lz };
  },

  /**
   * Position + local Z + local X; Y completes the right-handed system
   * (C# `LocalFrame(vecPos, vecLocalZ, vecLocalX)`; X is NOT re-orthogonalized).
   */
  createZX(pos: Vec3, localZ: Vec3, localX: Vec3): Frame {
    const lz = normalizedAxis(localZ, 'Z');
    const lx = normalizedAxis(localX, 'X');
    return { pos, lx, ly: localFrame.localY(lz, lx), lz };
  },

  /** Translated frame, axes unchanged (C# `oTranslate` / `oGetTranslatedFrame`). */
  translated: (f: Frame, delta: Vec3): Frame => localFrame.createZX(vec3.add(f.pos, delta), f.lz, f.lx),

  /** All axes rotated about an axis, position unchanged (C# `oRotate` / `oGetRotatedFrame`). */
  rotated(f: Frame, deltaPhi: number, axis: Vec3): Frame {
    const lx = vecOps.rotateAroundAxis(f.lx, deltaPhi, axis);
    const lz = vecOps.rotateAroundAxis(f.lz, deltaPhi, axis);
    return localFrame.createZX(f.pos, lz, lx);
  },

  /** Selected axes negated, position unchanged (C# `oGetInvertFrame`; rotates rather than truly inverting). */
  inverted(f: Frame, mirrorZ: boolean, mirrorX: boolean): Frame {
    const lz = mirrorZ ? vec3.neg(f.lz) : f.lz;
    const lx = mirrorX ? vec3.neg(f.lx) : f.lx;
    return localFrame.createZX(f.pos, lz, lx);
  },

  /** Y completing Z and X right-handedly (C# `vecGetLocalY`; a plain cross, no normalization). */
  localY: (localZ: Vec3, localX: Vec3): Vec3 => vec3.cross(localZ, localX),
} as const;
