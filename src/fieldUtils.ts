// R14 (real-world-subjects blueprint) — the two headless FieldUtils helpers
// PicoGK_SimulationExample consumes, ported from PicoGK Utils/FieldUtils.cs
// (Apache-2.0, © 2023-2026 LEAP 71; see NOTICE) over the existing
// `traverse()` surface — no ABI change (Finding 3 exception).

import type { ScalarField, VectorField } from './fields.ts';
import { vec3 } from './numerics/vector.ts';
import type { Pico } from './session.ts';
import type { Vec3 } from './types.ts';
import type { Voxels } from './voxels.ts';

export interface SurfaceNormalFieldOptions {
  /** Active values with |sd| above this (voxel units) are skipped (C# `fSurfaceThresholdVx`, default 0.5). */
  surfaceThresholdVx?: number;
  /** Keep only normals within the tolerance of this direction (C# `vecDirectionFilter`). */
  directionFilter?: Vec3;
  /** Allowed |1 - dot| deviation, 0..1 (C# `fDirectionFilterTolerance`). */
  directionFilterTolerance?: number;
  /** Component-wise scale applied to stored normals (C# `vecScaleBy`). */
  scaleBy?: Vec3;
}

/**
 * Builds a VectorField of surface normals from a voxel field's narrow band
 * (C# `SurfaceNormalFieldExtractor.oExtract`).
 */
export function surfaceNormalFieldExtractor(
  pk: Pico,
  voxels: Voxels,
  options: SurfaceNormalFieldOptions = {},
): VectorField {
  const threshold = options.surfaceThresholdVx ?? 0.5;
  const tolerance = options.directionFilterTolerance ?? 0;
  const scaleBy = options.scaleBy ?? vec3.one;
  const rawFilter = options.directionFilter ?? vec3.zero;
  const filtered = rawFilter[0] !== 0 || rawFilter[1] !== 0 || rawFilter[2] !== 0;
  const filter = filtered ? vec3.normalized(rawFilter) : vec3.zero;

  const destination = pk.createVectorField();
  const source = voxels.toScalarField();
  source.traverse((x, y, z, value) => {
    if (Math.abs(value) > threshold) return;
    const position: Vec3 = [x, y, z];
    const normal = voxels.surfaceNormal(position);
    if (filtered) {
      const deviation = Math.abs(1 - vec3.dot(normal, filter));
      if (deviation > tolerance) return;
    }
    destination.set(position, [normal[0] * scaleBy[0], normal[1] * scaleBy[1], normal[2] * scaleBy[2]]);
  });
  return destination;
}

/** Writes every active value of `source` into `target` (C# `VectorFieldMerge.Merge`). */
export function vectorFieldMerge(source: VectorField, target: VectorField): void {
  source.traverse((x, y, z, vx, vy, vz) => {
    target.set([x, y, z], [vx, vy, vz]);
  });
}
