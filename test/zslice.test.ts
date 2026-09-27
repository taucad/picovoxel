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
  for (let z = iEnd - 1; z >= dims.origin[2]; z--) {
    const slice = voxels.getSlice({ index: z - dims.origin[2] });
    let active = false;
    for (const v of slice.data)
      if (Math.abs(v) < slice.background) {
        active = true;
        break;
      }
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
      l: bigint,
      v: bigint,
      s: number,
      e: number,
    ) => void;
    const copy = pk.module.cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (
      l: bigint,
      v: bigint,
    ) => bigint;
    const gh = pk.module.cwrap('Voxels_GetGridHash', null, [
      'bigint',
      'bigint',
      'number',
      'number',
      'number',
      'number',
    ]) as (l: bigint, v: bigint, a: number, b: number, c: number, d: number) => void;
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

// D-pre.4 — the DIRECT oracle: sweep semantics are a per-column running min
// toward startZ (upstream's min-propagation), asserted value-by-value on an
// analytic fixture in both directions. The seal region (z at and beyond iEnd)
// and the never-written startZ layer are excluded; everything between must
// equal min(orig[z..startZ]) exactly (float-exact — the sweep only copies).
test('direct per-column min oracle on an analytic sphere, both directions', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
    type Grid = {
      origin: number[];
      size: number[];
      width: number;
      slices: Float32Array[];
      background: number;
    };
    const readAll = (v: ReturnType<Pico['createVoxels']>): Grid => {
      const d = v.dimensions();
      const first = v.getSlice({ index: 0 });
      const slices: Float32Array[] = [first.data];
      for (let i = 1; i < d.size[2]; i++) slices.push(v.getSlice({ index: i }).data);
      return {
        origin: [...d.origin],
        size: [...d.size],
        width: first.width,
        slices,
        background: first.background,
      };
    };
    const value = (g: Grid, wx: number, wy: number, wz: number): number => {
      const ix = wx - g.origin[0]!;
      const iy = wy - g.origin[1]!;
      const iz = wz - g.origin[2]!;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= g.size[0]! || iy >= g.size[1]! || iz >= g.size[2]!)
        return g.background;
      return g.slices[iz]![iy * g.width + ix]!;
    };
    for (const [startZ, endZ] of [
      [3, -3],
      [-3, 3],
    ] as const) {
      const projected = sphere.projectZSlice({ startZ, endZ });
      const iStart = Math.round(startZ / pk.voxelSize);
      const iEnd = Math.round(endZ / pk.voxelSize);
      const step = iStart > iEnd ? -1 : 1;
      const orig = readAll(sphere);
      const proj = readAll(projected);
      let mismatches = 0;
      let first = '';
      for (let wx = orig.origin[0]!; wx < orig.origin[0]! + orig.size[0]!; wx++) {
        for (let wy = orig.origin[1]!; wy < orig.origin[1]! + orig.size[1]!; wy++) {
          let run = value(orig, wx, wy, iStart);
          for (let wz = iStart + step; wz !== iEnd; wz += step) {
            run = Math.min(run, value(orig, wx, wy, wz));
            const got = value(proj, wx, wy, wz);
            if (got !== run && mismatches++ === 0) {
              first = `(${wx},${wy},${wz}) ${startZ}→${endZ}: got ${got}, expected running min ${run}`;
            }
          }
        }
      }
      assert.equal(mismatches, 0, `per-column min oracle: ${mismatches} mismatches, first at ${first}`);
      projected.dispose();
    }
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
