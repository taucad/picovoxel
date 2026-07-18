// Port of LEAP71_ShapeKernel Examples/Ex_MeshTrafoShowCase.cs (Apache-2.0, © LEAP 71).
// Voxels → mesh → per-vertex rotation → voxels (the C# fnRotate variant).

import type { PicoGK, Vec3, Voxels } from 'picogk-js';
import { BaseBox, localFrame, meshUtility, vecOps } from 'picogk-js/shapekernel';

export const rotate = (pt: Vec3): Vec3 => vecOps.rotateAroundAxis(pt, (45 / 180) * Math.PI, [0, 0, 1]);

export function task(pk: PicoGK): Voxels[] {
  const box = new BaseBox(localFrame.create([0, 100, 0]), 50, 40, 30);
  const voxBox = box.voxConstruct(pk);
  const meshBox = voxBox.toMesh();
  const transformed = meshUtility.applyTransformation(pk, meshBox, rotate);
  return [voxBox, transformed.toVoxels()];
}
