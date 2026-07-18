// Port of LEAP71_ShapeKernel Examples/Ex_OverOffsetShowCase.cs (Apache-2.0, © LEAP 71).
// Two crossing boxes united, then filleted (the C# voxFillet(3) variant).

import type { PicoGK, Voxels } from 'picogk-js';
import { BaseBox, localFrame } from 'picogk-js/shapekernel';

export function task(pk: PicoGK): Voxels[] {
  const box1 = new BaseBox(localFrame.identity, 10, 40, 30);
  const box2 = new BaseBox(localFrame.identity, 40, 40, 10);
  const united = box1.voxConstruct(pk).union(box2.voxConstruct(pk));
  const filleted = united.fillet({ rounding: 3 });
  return [filleted];
}
