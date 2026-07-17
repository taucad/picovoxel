// picogk-js/three — the BufferGeometry bridge (subpaths doc, Part 2).
//
// `three` is an OPTIONAL peer: only importers of this subpath pay for it. Runtime
// imports are limited to BufferGeometry/BufferAttribute, which run headless in
// node — the tests need no browser.

import { BufferAttribute, BufferGeometry } from 'three';
import { PicoGkError } from './errors.ts';
import type { Mesh } from './mesh.ts';
import type { PicoGK } from './session.ts';

export interface ToBufferGeometryOptions {
  /**
   * Compute vertex normals (default true). PicoGK meshes carry no normals; an
   * unlit black blob is the #1 first-run failure. Opt out for flat/custom shading.
   */
  computeNormals?: boolean;
}

/**
 * Converts a picogk-js Mesh into a three BufferGeometry. The facade's
 * copy-on-read is the safety boundary: the arrays handed to the attributes are
 * fresh copies the geometry then owns — no second copy is made here.
 */
export function toBufferGeometry(mesh: Mesh, options: ToBufferGeometryOptions = {}): BufferGeometry {
  const { computeNormals = true } = options;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.vertices, 3));
  geometry.setIndex(new BufferAttribute(mesh.triangles, 1));
  if (computeNormals) geometry.computeVertexNormals();
  return geometry;
}

/**
 * Converts an INDEXED BufferGeometry into a picogk-js Mesh via the bulk import
 * path. Non-indexed geometry is rejected honestly rather than silently welded —
 * run it through BufferGeometryUtils.mergeVertices first.
 */
export function meshFromBufferGeometry(session: PicoGK, geometry: BufferGeometry): Mesh {
  const index = geometry.getIndex();
  if (!index) {
    throw new PicoGkError(
      'PICOGK_INVALID_ARGUMENT',
      'meshFromBufferGeometry needs an indexed BufferGeometry. ' +
        'Weld yours first with BufferGeometryUtils.mergeVertices(geometry).',
    );
  }
  const position = geometry.getAttribute('position');
  if (!position) {
    throw new PicoGkError('PICOGK_INVALID_ARGUMENT', 'BufferGeometry has no position attribute.');
  }
  return session.createMesh({
    vertices: position.array as ArrayLike<number>,
    triangles: index.array as ArrayLike<number>,
  });
}
