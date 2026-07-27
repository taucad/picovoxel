// SKv2-0 V0.9 — ProjectZSlice: T5×F15 column-culled export + the U2 seal fix.
// The oracle set the charter names: per-column min, per-scale seal counts,
// upstream identity at 1.0 mm (where the buggy and fixed formulas coincide),
// and single≡multi at fine cells (in multi.test.ts's domain; here cross-lane
// via gridHash on the serial entry vs multi entry).

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';
import { createPico as createMulti } from '../src/multi.ts';

const NARROW_BAND = 3; // PICOGK_VOXEL_DEFAULTNARROWBAND

/** Active-layer count of the seal region: z-layers strictly below the
 * projection end that carry active voxels in the projected column. */
const sealLayers = (pk: Pico, voxels: ReturnType<Pico['createVoxels']>, endZ: number): number => {
  const dims = voxels.dimensions();
  const iEnd = Math.round(endZ / pk.voxelSize);
  let layers = 0;
  for (let z = iEnd - 1; z >= dims.origin[2]!; z--) {
    const slice = voxels.getSlice({ index: z - dims.origin[2]! });
    let active = false;
    for (const v of slice.data) if (Math.abs(v) < slice.background) { active = true; break; }
    if (active) layers++;
    else break;
  }
  return layers;
};

test('per-scale seal counts: the fixed export seals the full band at every scale', async () => {
  for (const voxelSize of [1.5, 1.0, 0.5, 0.167]) {
    const pk = await createPico({ voxelSize });
    try {
      const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
      const projected = sphere.projectZSlice({ startZ: 6, endZ: -6 });
      const layers = sealLayers(pk, projected, -6);
      // The seal writes averaged (non-background) values over the whole
      // narrow band; the buggy mm-as-count formula wrote round(3·voxelSize)
      // layers (0 at 0.167 mm — an open cap).
      assert.ok(
        layers >= NARROW_BAND - 1, // the outermost layer may prune to off/background legally
        `@${voxelSize}mm: sealed ${layers} layers — the U2 open-cap defect shape`,
      );
      projected.dispose();
      sphere.dispose();
    } finally {
      pk.dispose();
    }
  }
}, 120_000);

test('1.0 mm: fixed export ≡ upstream export bit-for-bit (formulas coincide)', async () => {
  const pk = await createPico({ voxelSize: 1.0 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
    const viaFast = sphere.projectZSlice({ startZ: 6, endZ: -6 });
    const raw = pk.module.cwrap('Voxels_ProjectZSlice', null, ['bigint', 'bigint', 'number', 'number']) as (
      l: bigint, v: bigint, s: number, e: number) => void;
    const copy = pk.module.cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (l: bigint, v: bigint) => bigint;
    const gh = pk.module.cwrap('Voxels_GetGridHash', null, ['bigint', 'bigint', 'number', 'number', 'number', 'number']) as (
      l: bigint, v: bigint, a: number, b: number, c: number, d: number) => void;
    const reference = copy(pk.handle, sphere.handle);
    raw(pk.handle, reference, 6, -6);
    const p = pk.module._malloc(48);
    gh(pk.handle, reference, p, p + 16, p + 24, p + 32);
    let hash = '';
    for (let w = 0; w < 4; w++) {
      const word = pk.module.HEAPU32[(p + 4 * w) >>> 2]!;
      for (let b = 0; b < 4; b++) hash += ((word >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
    }
    pk.module._free(p);
    assert.equal(viaFast.gridHash().hash, hash, '1.0 mm must be byte-coincident with upstream');
    // Both directions (Up as well as Dn).
    const up = sphere.projectZSlice({ startZ: -6, endZ: 6 });
    assert.ok(up.volume > sphere.volume, 'upward projection adds material');
  } finally {
    pk.dispose();
  }
}, 120_000);

test('column-culled export is single≡multi at 0.5 mm', async () => {
  const single = await createPico({ voxelSize: 0.5 });
  const multi = await createMulti({ voxelSize: 0.5 });
  try {
    const make = (pk: Pico) =>
      pk
        .createVoxels({ shape: 'sphere', radius: 8 })
        .union(pk.createVoxels({ shape: 'beam', start: [-6, 0, 2], end: [6, 0, 2], radius: 2 }))
        .projectZSlice({ startZ: 5, endZ: -5 });
    assert.deepEqual(make(multi).gridHash(), make(single).gridHash());
  } finally {
    single.dispose();
    multi.dispose();
  }
}, 240_000);
