// Port of LEAP71_LatticeLibrary Examples/Ex_ImplicitLibraryRegularTask.cs (Apache-2.0, © LEAP 71).
// C# default preset: ImplicitSchwarzDiamond. The mask runs through
// maskedByImplicit's tape variant (R9) — the accelerated path.

import type { PicoGK, Voxels } from 'picogk-js';
import { ImplicitSchwarzDiamond } from 'picogk-js/latticelibrary';
import { BaseBox, localFrame } from 'picogk-js/shapekernel';

export function task(pk: PicoGK): Voxels[] {
  const voxBounding = new BaseBox(localFrame.identity, 50, 50, 50).voxConstruct(pk);
  const pattern = new ImplicitSchwarzDiamond(10, 0.5);
  const voxImplicit = voxBounding.maskedByImplicit({ sdf: pattern.expression });
  return [voxImplicit, voxBounding];
}
