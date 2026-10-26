// patches/openvdb/0002-exact-adaptive-merge.patch speeds up VolumeToMesh's adaptive
// merge without changing what it merges. Each digest below came from the serial wasm
// built WITHOUT that patch (stock OpenVDB at the pinned 7c03e1f0, every other source identical); this
// build must reproduce them byte for byte. 112 cases matched in that comparison
// (two voxel sizes, four fixtures, seven adaptivities, relax off and on); these are a
// representative subset. The uniform path (adaptivity 0) is covered by every pin in
// the suite, since the patch leaves it untouched.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPico, type Pico, type Voxels } from '../src/index.ts';

let pk: Pico;
let fixtures: Record<'box' | 'bumpy', Voxels>;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5, lane: 'fast' });
  fixtures = {
    box: pk.createVoxels({
      shape: 'implicit',
      boundsMin: [-11, -7, -4],
      boundsMax: [11, 7, 4],
      sdf: ['max', ['-', ['abs', 'x'], 10], ['-', ['abs', 'y'], 6], ['-', ['abs', 'z'], 3]],
    }),
    bumpy: pk
      .createVoxels({ shape: 'sphere', radius: 8 })
      .union(pk.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 })),
  };
});
afterAll(() => pk.dispose());

// `${fixture}/${adaptivity}/${relax}` -> `${triangleCount}:${sha256(vertices, triangles) first 20 hex}`
const STOCK_OPENVDB: Record<string, string> = {
  'box/0.01/0': '2044:ca1a449d0145a20c5d2c',
  'box/0.5/0': '1332:4653d46758b1d48a234f',
  'box/0.75/1': '1290:fa54436bf99dff8da124',
  'bumpy/0.01/0': '3190:6e1be3a1c1481442b033',
  'bumpy/0.1/0': '1034:923f0052030d4e421516',
  'bumpy/0.1/1': '1034:fb0c741f139f20c9253e',
  'bumpy/0.25/0': '442:515cd64f310220f42a41',
  'bumpy/0.5/1': '330:42cc0d3e24b905b8ebbe',
  'bumpy/0.999/0': '174:491606f01ce75e0a9f0f',
};

test('the tuned adaptive merge reproduces stock OpenVDB byte for byte', () => {
  for (const [key, expected] of Object.entries(STOCK_OPENVDB)) {
    const [name, adaptivity, relax] = key.split('/') as ['box' | 'bumpy', string, string];
    const mesh = fixtures[name].toMesh({ adaptivity: Number(adaptivity), relax: relax === '1' });
    const digest = createHash('sha256')
      .update(Buffer.from(mesh.vertices.buffer))
      .update(Buffer.from(mesh.triangles.buffer))
      .digest('hex')
      .slice(0, 20);
    expect(`${mesh.triangleCount}:${digest}`, key).toBe(expected);
  }
});
