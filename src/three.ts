// picovoxel/three — the BufferGeometry bridge.
//
// `three` is an OPTIONAL peer: only importers of this subpath pay for it. Runtime
// imports are limited to BufferGeometry/BufferAttribute, which run headless in
// node — the tests need no browser.

import { BufferAttribute, BufferGeometry } from 'three';
import { PicoError } from './errors.ts';
import type { Mesh } from './mesh.ts';
import type { Pico } from './session.ts';

export interface ToBufferGeometryOptions {
  /**
   * Compute vertex normals (default true). PicoGK meshes carry no normals; an
   * unlit black blob is the #1 first-run failure. Opt out for flat/custom shading.
   */
  computeNormals?: boolean;
}

/**
 * Converts a picovoxel Mesh into a three BufferGeometry. The facade's
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
 * Converts an INDEXED BufferGeometry into a picovoxel Mesh via the bulk import
 * path. Non-indexed geometry is rejected honestly rather than silently welded —
 * run it through BufferGeometryUtils.mergeVertices first.
 */
export function meshFromBufferGeometry(session: Pico, geometry: BufferGeometry): Mesh {
  const index = geometry.getIndex();
  if (!index) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      'meshFromBufferGeometry needs an indexed BufferGeometry. ' +
        'Weld yours first with BufferGeometryUtils.mergeVertices(geometry).',
    );
  }
  const position = geometry.getAttribute('position');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- three's typing omits the undefined getAttribute returns for a missing attribute
  if (!position) {
    throw new PicoError('PICO_INVALID_ARGUMENT', 'BufferGeometry has no position attribute.');
  }
  return session.createMesh({
    vertices: position.array,
    triangles: index.array,
  });
}
