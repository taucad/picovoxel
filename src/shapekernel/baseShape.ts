// Derived from LEAP71_ShapeKernel — ShapeKernel/BaseShapes/BaseShape.cs
// Copyright (c) 2023-2026 LEAP 71 — https://leap71.com
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript for picovoxel; see NOTICE.
//
// Explicit-session surface: shapes are pure authoring objects —
// the session enters only at the construction boundary, so `voxConstruct` and
// `mshConstruct` take the PicoGK session instead of using an ambient Library.
// MeshBuilder mirrors upstream's convenience `Mesh.nAddTriangle(v0, v1, v2)`
// (three fresh vertices per triangle, no dedup) but accumulates into flat
// arrays and crosses the ABI ONCE through the bulk mesh path. Shapes that
// tessellate a grid (BasePipe) add each distinct point once through addVertex
// and index it: same coordinates, same triangles in the same order, fewer vertices.

import type { Mesh } from '../mesh.ts';
import type { Pico } from '../session.ts';
import type { Vec3 } from '../types.ts';
import type { Lattice } from '../lattice.ts';
import type { Voxels } from '../voxels.ts';

/** Point-wise vertex transformation applied during construction (C# `fnVertexTransformation`). */
export type VertexTransformation = (pt: Vec3) => Vec3;

/** C# `ISurfaceBaseShape`. */
export interface SurfaceBaseShape {
  surfacePoint(ratio1: number, ratio2: number, ratio3: number): Vec3;
}

/** C# `ISpineBaseShape`. */
export interface SpineBaseShape {
  spinePoint(ratio1: number): Vec3;
}

/** C# `IMeshBaseShape`. */
export interface MeshBaseShape {
  mshConstruct(pk: Pico): Mesh;
}

/** C# `ILatticeBaseShape`. */
export interface LatticeBaseShape {
  latConstruct(pk: Pico): Lattice;
}

/** C# `BaseShape` — the vertex-transformation seam every shape shares. */
export abstract class BaseShape {
  protected trafo: VertexTransformation = (pt) => pt;

  /** Point-wise transformation applied during construction (C# `SetTransformation`). */
  setTransformation(trafo: VertexTransformation): void {
    this.trafo = trafo;
  }

  abstract voxConstruct(pk: Pico): Voxels;
}

/** Accumulates upstream-style per-triangle geometry, built through ONE bulk `createMesh` call. */
export class MeshBuilder {
  private readonly vertices: number[] = [];
  private readonly triangles: number[] = [];

  /** Number of vertices added so far: the index the next {@link MeshBuilder.addVertex} returns. */
  get vertexCount(): number {
    return this.vertices.length / 3;
  }

  /** Adds one vertex and returns its index, for {@link MeshBuilder.addIndexedTriangle} (C# `Mesh.nAddVertex`). */
  addVertex(pt: Vec3): number {
    const index = this.vertices.length / 3;
    this.vertices.push(pt[0], pt[1], pt[2]);
    return index;
  }

  /** One triangle over vertices already added, by index (C# `Mesh.nAddTriangle(Triangle)`). */
  addIndexedTriangle(a: number, b: number, c: number): void {
    this.triangles.push(a, b, c);
  }

  /** Three fresh vertices + one triangle, exactly like C# `Mesh.nAddTriangle(v0, v1, v2)`. */
  addTriangle(a: Vec3, b: Vec3, c: Vec3): void {
    const base = this.vertices.length / 3;
    this.vertices.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.triangles.push(base, base + 1, base + 2);
  }

  /** The two-triangle quad both upstream mesh helpers and shape mantles use. */
  addQuad(pt1: Vec3, pt2: Vec3, pt3: Vec3, pt4: Vec3): void {
    this.addTriangle(pt4, pt1, pt2);
    this.addTriangle(pt2, pt3, pt4);
  }

  build(pk: Pico): Mesh {
    return pk.createMesh({ vertices: this.vertices, triangles: this.triangles });
  }
}
