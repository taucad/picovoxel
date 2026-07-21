// HelixHeatX headless entry (blueprint R11). The caller supplies the session
// — and with it the voxel size, exactly as upstream's Library.Go(voxelSize,
// HelixHeatX.Task) does. Returns the final part plus the authoring-time split
// the benchmark protocol reports (Finding 8 promotion trigger).

import type { Pico, Voxels } from 'picovoxel';
import { HelixHeatX } from './helixHeatX.ts';

export interface HeatXResult {
  voxels: Voxels;
  /** Pure-JS authoring milliseconds (lattice/point loops). */
  authorMs: number;
}

export function task(pk: Pico): HeatXResult {
  const heatX = new HelixHeatX(pk);
  const voxels = heatX.voxConstruct();
  return { voxels, authorMs: heatX.authorMs };
}
