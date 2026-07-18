// Derived from LEAP71_ShapeKernel — ShapeKernel/Functions/{ShLatticeFunctions,
// ShExportFunctions}.cs + Utilities/GridOperations.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picogk-js (blueprint R6); see NOTICE.
//
// The session-first `Sh` facade SUBSET: lattice builders and byte-producing
// export helpers. Deliberately not reproduced (graded in
// MIGRATING-FROM-CSHARP.md): the C#-[Obsolete] voxel/boolean/query
// pass-throughs (the facade methods exist on Voxels), the path-based export
// plumbing (bytes in, bytes out), TGA/PNG/CSV exports, and every `Preview*`
// function (viewer-bound — R16).

import type { Lattice } from '../lattice.ts';
import type { Mesh } from '../mesh.ts';
import type { PicoGK } from '../session.ts';
import { sliceVoxels, slicesToCli } from '../slicing.ts';
import type { Vec3 } from '../types.ts';
import type { Voxels } from '../voxels.ts';

/** Row/column swap for point grids (C# `GridOperations.aGetInverseGrid`). */
export function inverseGrid(grid: readonly (readonly Vec3[])[]): Vec3[][] {
  const inverse: Vec3[][] = [];
  for (let i = 0; i < grid[0]!.length; i += 1) {
    const points: Vec3[] = [];
    for (let j = 0; j < grid.length; j += 1) {
      points.push(grid[j]![i]!);
    }
    inverse.push(points);
  }
  return inverse;
}

/** ShapeKernel `Sh` — the headless subset, session-first. */
export const sh = {
  /** Beams along a point list (C# `latFromLine`). */
  latFromLine(pk: PicoGK, points: readonly Vec3[], beam: number): Lattice {
    const lattice = pk.createLattice();
    sh.addLine(lattice, points, beam);
    return lattice;
  },

  /** Adds a point list to an existing lattice (C# `AddLine`). */
  addLine(lattice: Lattice, points: readonly Vec3[], beam: number): void {
    for (let i = 1; i < points.length; i += 1) {
      lattice.addBeam({ start: points[i - 1]!, end: points[i]!, radius: beam, roundCap: true });
    }
  },

  /** Node-only lattice from a point cloud (C# `latFromPoints`). */
  latFromPoints(pk: PicoGK, points: readonly Vec3[], beam: number): Lattice {
    const lattice = pk.createLattice();
    for (const pt of points) lattice.addSphere({ center: pt, radius: beam });
    return lattice;
  },

  /** Beams along multiple point lists (C# `latFromEdges`). */
  latFromEdges(pk: PicoGK, edges: readonly (readonly Vec3[])[], beam: number): Lattice {
    const lattice = pk.createLattice();
    for (const edge of edges) sh.addLine(lattice, edge, beam);
    return lattice;
  },

  /** Node-only lattice from one point (C# `latFromPoint`). */
  latFromPoint(pk: PicoGK, pt: Vec3, beam: number): Lattice {
    const lattice = pk.createLattice();
    lattice.addSphere({ center: pt, radius: beam });
    return lattice;
  },

  /**
   * Lattice from a grid: rows then transposed columns. Ported VERBATIM
   * including the upstream quirk — each row REPLACES the lattice
   * (`oLattice = latFromLine(...)` in a loop), so only the LAST row survives
   * alongside the full column pass (C# `latFromGrid`).
   */
  latFromGrid(pk: PicoGK, grid: readonly (readonly Vec3[])[], beam: number): Lattice {
    let lattice = pk.createLattice();
    for (const row of grid) {
      lattice = sh.latFromLine(pk, row, beam);
    }
    for (const column of inverseGrid(grid)) {
      sh.addLine(lattice, column, beam);
    }
    return lattice;
  },

  /** One beam, constant radius (C# `latFromBeam`). */
  latFromBeam(pk: PicoGK, pt1: Vec3, pt2: Vec3, beam: number, rounded: boolean): Lattice {
    const lattice = pk.createLattice();
    lattice.addBeam({ start: pt1, end: pt2, radius: beam, roundCap: rounded });
    return lattice;
  },

  /** One beam, variable radius (C# `latFromBeam` overload). */
  latFromTaperedBeam(pk: PicoGK, pt1: Vec3, pt2: Vec3, beam1: number, beam2: number, rounded: boolean): Lattice {
    const lattice = pk.createLattice();
    lattice.addBeam({ start: pt1, end: pt2, startRadius: beam1, endRadius: beam2, roundCap: rounded });
    return lattice;
  },

  /** Binary STL bytes of a mesh (C# `ExportMeshToSTLFile` — bytes, not paths). */
  exportMeshToStl(mesh: Mesh): Uint8Array {
    return mesh.toStl();
  },

  /** Binary STL bytes of a voxel field via meshing (C# `ExportVoxelsToSTLFile`). */
  exportVoxelsToStl(voxels: Voxels): Uint8Array {
    return voxels.toMesh().toStl();
  },

  /** VDB bytes of a voxel field (C# `ExportVoxelsToVDBFile`). */
  exportVoxelsToVdb(pk: PicoGK, voxels: Voxels): Uint8Array {
    const vdb = pk.createVdb();
    vdb.add(voxels);
    return vdb.toBytes();
  },

  /** CLI slice bytes of a voxel field (C# `ExportVoxelsToCLIFile`). */
  exportVoxelsToCli(voxels: Voxels): Uint8Array {
    return slicesToCli(sliceVoxels(voxels));
  },
} as const;
