// Numerics foundation (real-world-subjects blueprint R1).
// Ports PicoGK Shapes/3D/Frame3d.cs as the ONE canonical rigid-frame type
// (Finding 9 of the blueprint): a local coordinate system — position plus a
// right-handed orthonormal basis — used for placement ("build this shape
// *here*, pointing *that way*") and transport (frame chains along a spine).
// ShapeKernel-TS's LocalFrame is this type plus construction helpers; the C#
// LocalFrame⇄Frame3d duplication is deliberately not reproduced.
//
// Internal `safeNormalize` is Frame3d's exact-zero guard (returns the input
// unchanged), NOT vec3.safeNormalized's tolerance-based zero — the distinction
// is load-bearing for degenerate-input parity with C#.

import { PicoError } from '../errors.ts';
import type { Mat4, Vec3 } from '../types.ts';
import type { Rad } from './angles.ts';
import { mat4 } from './matrix.ts';
import { type Quat, quat } from './quaternion.ts';
import { type Vec2, vec3 } from './vector.ts';

/** A rigid transform stored as explicit axes (C# `PicoGK.Shapes.Frame3d`): origin + right-handed orthonormal basis. */
export interface Frame {
  /** Origin of the frame in world coordinates (C# `vecPos`). */
  readonly pos: Vec3;
  /** Local X axis in world coordinates (C# `vecLx`). */
  readonly lx: Vec3;
  /** Local Y axis in world coordinates (C# `vecLy`). */
  readonly ly: Vec3;
  /** Local Z axis in world coordinates (C# `vecLz`). */
  readonly lz: Vec3;
}

/** Frame3d's private vecSafeNormalize: exact-zero guard, input returned unchanged when zero. */
function safeNormalize(v: Vec3): Vec3 {
  if (vec3.lengthSquared(v) <= 0) return v;
  const length = vec3.length(v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Gram-Schmidt as Frame3d's ctor does it: Z wins, X made orthogonal, Y = Z×X (right-handed). */
function orthonormalize(approxZ: Vec3, approxX: Vec3): { lz: Vec3; lx: Vec3; ly: Vec3 } {
  const lz = safeNormalize(approxZ);
  const lx = safeNormalize(vec3.sub(approxX, vec3.scale(lz, vec3.dot(approxX, lz))));
  return { lz, lx, ly: vec3.cross(lz, lx) };
}

function lift(v: Vec2 | Vec3): Vec3 {
  return v.length === 2 ? [v[0], v[1], 0] : v;
}

/** `Frame` factories and operations (C# `Frame3d` surface; `frm` prefixes dropped). */
export const frame = {
  /** The world coordinate system (C# `frmWorld`). */
  world: { pos: vec3.zero, lx: vec3.unitX, ly: vec3.unitY, lz: vec3.unitZ } as Frame,

  /** World-aligned axes at a position (C# `frmFromPos` / `Frame3d(vecPos)`). */
  fromPos: (pos: Vec3): Frame => ({ pos, lx: vec3.unitX, ly: vec3.unitY, lz: vec3.unitZ }),

  /**
   * From approximate Z and X directions; enforces orthonormality and
   * right-handedness, Z winning (C# `frmFromZX`).
   */
  fromZX(pos: Vec3, approxZ: Vec3, approxX: Vec3): Frame {
    const { lz, lx, ly } = orthonormalize(approxZ, approxX);
    return { pos, lx, ly, lz };
  },

  /** From a row-vector rigid matrix — rows [X; Y; Z; origin] (C# `frmFromMatrix4x4`). */
  fromMat4(m: Mat4): Frame {
    if (m.length !== 16) {
      throw new PicoError('PICO_INVALID_ARGUMENT', `frame matrix needs 16 elements, got ${m.length}.`);
    }
    return frame.fromZX([m[12]!, m[13]!, m[14]!], [m[8]!, m[9]!, m[10]!], [m[0]!, m[1]!, m[2]!]);
  },

  /** Local point (2D points lie in the frame's XY plane) → world (C# `vecPtToWorld`). */
  ptToWorld(f: Frame, local: Vec2 | Vec3): Vec3 {
    const [x, y, z] = lift(local);
    return vec3.add(f.pos, vec3.add(vec3.scale(f.lx, x), vec3.add(vec3.scale(f.ly, y), vec3.scale(f.lz, z))));
  },

  /** Local direction → world direction, safe-normalized (C# `vecDirToWorld`). */
  dirToWorld(f: Frame, localDir: Vec2 | Vec3): Vec3 {
    const [x, y, z] = lift(localDir);
    return safeNormalize(vec3.add(vec3.scale(f.lx, x), vec3.add(vec3.scale(f.ly, y), vec3.scale(f.lz, z))));
  },

  /** World point → local coordinates (C# `vecPtFromWorld`). */
  ptFromWorld(f: Frame, world: Vec3): Vec3 {
    const r = vec3.sub(world, f.pos);
    return [vec3.dot(r, f.lx), vec3.dot(r, f.ly), vec3.dot(r, f.lz)];
  },

  /** World direction → local direction, safe-normalized (C# `vecDirFromWorld`). */
  dirFromWorld(f: Frame, worldDir: Vec3): Vec3 {
    return safeNormalize([vec3.dot(worldDir, f.lx), vec3.dot(worldDir, f.ly), vec3.dot(worldDir, f.lz)]);
  },

  /** Combined transform: `a` applied to `b` (C# `frmCompose` / `Frame3d * Frame3d`). */
  compose(a: Frame, b: Frame): Frame {
    return frame.fromZX(frame.ptToWorld(a, b.pos), frame.dirToWorld(a, b.lz), frame.dirToWorld(a, b.lx));
  },

  /**
   * The inverse transform — maps world to local (C# `frmInverse`), **fixed
   * here** (upstream bug B5, fixed upstream in 0e6cf6b6; see upstream/LEDGER.md):
   * C# copies `vecLz`/`vecLx` verbatim into the inverse, inverting the
   * translation but NOT the rotation, so `frmCompose(frmInverse())` is only
   * the identity for rotation-free frames. The inverse rotation is Rᵀ, whose
   * basis columns are the ROWS of R.
   */
  inverse(f: Frame): Frame {
    const invPos: Vec3 = [-vec3.dot(f.lx, f.pos), -vec3.dot(f.ly, f.pos), -vec3.dot(f.lz, f.pos)];
    const rowZ: Vec3 = [f.lx[2], f.ly[2], f.lz[2]];
    const rowX: Vec3 = [f.lx[0], f.ly[0], f.lz[0]];
    // Rebuild through fromZX to reuse the ctor's orthonormalization.
    return frame.fromZX(invPos, rowZ, rowX);
  },

  /** Origin moved by a local-space distance (C# `frmMovedLocal`). */
  movedLocal(f: Frame, distance: Vec3): Frame {
    const pos = vec3.add(
      f.pos,
      vec3.add(
        vec3.scale(f.lx, distance[0]),
        vec3.add(vec3.scale(f.ly, distance[1]), vec3.scale(f.lz, distance[2])),
      ),
    );
    return frame.fromZX(pos, f.lz, f.lx);
  },

  /** Origin moved along local X (C# `frmMovedLocalX`). */
  movedLocalX: (f: Frame, distance: number): Frame =>
    frame.fromZX(vec3.add(f.pos, vec3.scale(f.lx, distance)), f.lz, f.lx),

  /** Origin moved along local Y (C# `frmMovedLocalY`). */
  movedLocalY: (f: Frame, distance: number): Frame =>
    frame.fromZX(vec3.add(f.pos, vec3.scale(f.ly, distance)), f.lz, f.lx),

  /** Origin moved along local Z (C# `frmMovedLocalZ`). */
  movedLocalZ: (f: Frame, distance: number): Frame =>
    frame.fromZX(vec3.add(f.pos, vec3.scale(f.lz, distance)), f.lz, f.lx),

  /** Origin moved by a world-space distance (C# `frmMovedWorld`). */
  movedWorld: (f: Frame, distance: Vec3): Frame => frame.fromZX(vec3.add(f.pos, distance), f.lz, f.lx),

  /** Origin moved along world X (C# `frmMovedWorldX`). */
  movedWorldX: (f: Frame, distance: number): Frame => frame.movedWorld(f, [distance, 0, 0]),

  /** Origin moved along world Y (C# `frmMovedWorldY`). */
  movedWorldY: (f: Frame, distance: number): Frame => frame.movedWorld(f, [0, distance, 0]),

  /** Origin moved along world Z (C# `frmMovedWorldZ`). */
  movedWorldZ: (f: Frame, distance: number): Frame => frame.movedWorld(f, [0, 0, distance]),

  /** Rotated about a world-space axis through the frame's origin (C# `frmRotatedWorld`). */
  rotatedWorld(f: Frame, axis: Vec3, angle: Rad): Frame {
    const q = quat.fromAxisAngle(safeNormalize(axis), angle);
    return frame.fromZX(f.pos, quat.transform(f.lz, q), quat.transform(f.lx, q));
  },

  /** Same orientation at a new origin (C# `frmRepositioned`). */
  repositioned: (f: Frame, newPos: Vec3): Frame => frame.fromZX(newPos, f.lz, f.lx),

  /**
   * As a row-vector rigid `Mat4` — basis in rows, translation in 12–14; the
   * layout `mesh.transform({ matrix })` consumes (C# `matAsMatrix4x4`).
   */
  toMat4: (f: Frame): Mat4 =>
    [
      f.lx[0],
      f.lx[1],
      f.lx[2],
      0,
      f.ly[0],
      f.ly[1],
      f.ly[2],
      0,
      f.lz[0],
      f.lz[1],
      f.lz[2],
      0,
      f.pos[0],
      f.pos[1],
      f.pos[2],
      1,
    ] as const,

  /** Scale-then-frame model matrix for drawing scaled geometry (C# `matComposeWithScale`). */
  composeWithScale: (f: Frame, scale: Vec3): Mat4 => mat4.multiply(mat4.createScale(scale), frame.toMat4(f)),

  /** The transform as rotation quaternion + origin (C# `AsRigid`; out-params → returned object). */
  asRigid: (f: Frame): { rotation: Quat; origin: Vec3 } => ({
    rotation: quat.fromMat4(frame.toMat4(f)),
    origin: f.pos,
  }),

  /**
   * Interpolate two frames: slerp the rotations (shortest arc), lerp the
   * positions; `t` clamped to 0..1 (C# `frmInterpolate`).
   */
  interpolate(a: Frame, b: Frame, t: number): Frame {
    const clamped = Math.min(1, Math.max(0, t));
    const q0 = frame.asRigid(a).rotation;
    let q1 = frame.asRigid(b).rotation;
    if (quat.dot(q0, q1) < 0) q1 = quat.neg(q1);
    const q = quat.slerp(q0, q1, clamped);
    return frame.fromZX(
      vec3.lerp(a.pos, b.pos, clamped),
      quat.transform(vec3.unitZ, q),
      quat.transform(vec3.unitX, q),
    );
  },

  /** Exact component equality (C# `Equals`). */
  equals(a: Frame, b: Frame): boolean {
    const same = (u: Vec3, v: Vec3): boolean => u[0] === v[0] && u[1] === v[1] && u[2] === v[2];
    return same(a.pos, b.pos) && same(a.lx, b.lx) && same(a.ly, b.ly) && same(a.lz, b.lz);
  },
} as const;
