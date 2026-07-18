// Port of LEAP71_ShapeKernel Examples/Ex_ImplicitGyroidSphere.cs (Apache-2.0, © LEAP 71).
// The implicit sphere renders through the parallel tape path; the gyroid mask
// goes through maskedByImplicit's tape variant (R9).

import type { PicoGK, Voxels } from 'picogk-js';
import { ImplicitGyroid, ImplicitSphere } from 'picogk-js/shapekernel';

export function task(pk: PicoGK): Voxels[] {
  const radius = 10;
  const sdfSphere = new ImplicitSphere([0, 0, 0], radius);
  const sdfPattern = new ImplicitGyroid(3, 1);
  const bound = 1.2 * radius;
  const voxSphere = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-bound, -bound, -bound],
    boundsMax: [bound, bound, bound],
    sdf: sdfSphere.expression,
  });
  const voxGyroidSphere = voxSphere.maskedByImplicit({ sdf: sdfPattern.expression });
  return [voxGyroidSphere, voxSphere];
}
