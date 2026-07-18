// Port of LEAP71_LatticeLibrary Examples/Ex_ImplicitLibraryModularTask.cs (Apache-2.0, © LEAP 71).
// C# default components: RawTransitionTPMSPattern × ScaleTrafo(10,10,10) ×
// FullWallLogic × ConstantBeamThickness(0.5). ImplicitModular composes
// arbitrary callbacks → serial callback mask path.

import type { PicoGK, Voxels } from 'picogk-js';
import {
  ConstantBeamThickness,
  FullWallLogic,
  ImplicitModular,
  RawTransitionTpmsPattern,
  ScaleTrafo,
} from 'picogk-js/latticelibrary';
import { BasePipe, localFrame } from 'picogk-js/shapekernel';

export function task(pk: PicoGK): Voxels[] {
  const voxBounding = new BasePipe(localFrame.identity, 50, 20, 50).voxConstruct(pk);
  const pattern = new ImplicitModular(
    new RawTransitionTpmsPattern(),
    new ConstantBeamThickness(0.5),
    new ScaleTrafo(10, 10, 10),
    new FullWallLogic(),
  );
  const voxImplicit = voxBounding.maskedByImplicit({ sdf: pattern.sdf });
  return [voxImplicit, voxBounding];
}
