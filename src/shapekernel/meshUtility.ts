// Derived from LEAP71_ShapeKernel — ShapeKernel/Utilities/MeshUtility.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.
//
// Per-vertex mesh transforms in the upstream style: triangles are exploded
// (three fresh vertices each, no dedup), exactly what C# nAddTriangle-based
// rebuilds produce. Vertices cross the ABI in bulk both ways.
// C# `Append` is not reproduced — the facade's pure `mesh.merged(other)`
// covers it.

import type { Mesh } from '../mesh.ts';
import { type Frame, frame } from '../numerics/frame.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';
import { MeshBuilder, type VertexTransformation } from './baseShape.ts';

/** ShapeKernel `MeshUtility` (static class → const object; session-first). */
export const meshUtility = {
  /** Mesh from a regular point grid, quad by quad (C# `mshFromGrid`). */
  meshFromGrid(pk: Pico, grid: readonly (readonly Vec3[])[]): Mesh {
    const builder = new MeshBuilder();
    for (let i = 1; i < grid.length; i += 1) {
      for (let j = 1; j < grid[i]!.length; j += 1) {
        builder.addQuad(grid[i - 1]![j - 1]!, grid[i - 1]![j]!, grid[i]![j]!, grid[i]![j - 1]!);
      }
    }
    return builder.build(pk);
  },

  /** Mesh from one quad (C# `mshFromQuad`). */
  meshFromQuad(pk: Pico, pt1: Vec3, pt2: Vec3, pt3: Vec3, pt4: Vec3): Mesh {
    const builder = new MeshBuilder();
    builder.addQuad(pt1, pt2, pt3, pt4);
    return builder.build(pk);
  },

  /** New mesh with the transformation applied per vertex (C# `mshApplyTransformation`). */
  applyTransformation(pk: Pico, mesh: Mesh, trafo: VertexTransformation): Mesh {
    const vertices = mesh.vertices;
    const triangles = mesh.triangles;
    const builder = new MeshBuilder();
    const vertexAt = (index: number): Vec3 =>
      trafo([vertices[3 * index]!, vertices[3 * index + 1]!, vertices[3 * index + 2]!]);
    for (let i = 0; i < triangles.length; i += 3) {
      builder.addTriangle(vertexAt(triangles[i]!), vertexAt(triangles[i + 1]!), vertexAt(triangles[i + 2]!));
    }
    return builder.build(pk);
  },

  /** Voxels → mesh → per-vertex transform → voxels (C# `voxApplyTransformation`). */
  voxApplyTransformation(pk: Pico, voxels: Voxels, trafo: VertexTransformation): Voxels {
    return meshUtility.applyTransformation(pk, voxels.toMesh(), trafo).toVoxels();
  },

  /** Mesh re-expressed from the input frame onto the output frame (C# `mshTranslateMeshOntoFrame`). */
  translateMeshOntoFrame(pk: Pico, mesh: Mesh, inputFrame: Frame, outputFrame: Frame): Mesh {
    return meshUtility.applyTransformation(pk, mesh, (pt) =>
      frame.ptToWorld(outputFrame, frame.ptFromWorld(inputFrame, pt)),
    );
  },
} as const;
