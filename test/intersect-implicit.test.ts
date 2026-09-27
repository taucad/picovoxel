// SKv2-0 V0.10 — IntersectImplicit: F17 support-restricted eval + the U1
// narrow-band fix. Oracles: 1.0 mm identity with the truncated-band originals
// (the bands coincide there), callback≡tape cross-path identity, and the
// <1/3 mm correctness restoration against a reference construction built
// entirely from paths that never had the truncation.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';
import type { SdfExpression } from '../src/tape.ts';

// A plane-cut: simple, analytic, and its surface crosses the sphere interior.
const planeSdf: SdfExpression = ['+', 'z', 0.3];
const planeFn = (x: number, y: number, z: number) => z + 0.3;

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 1.0 });
});
afterAll(() => pk.dispose());

const rawHash = (pkAt: Pico, handle: bigint): string => {
  const gh = pkAt.module.cwrap('Voxels_GetGridHash', null, [
    'bigint',
    'bigint',
    'number',
    'number',
    'number',
    'number',
  ]) as (l: bigint, v: bigint, a: number, b: number, c: number, d: number) => void;
  const p = pkAt.module._malloc(48);
  gh(pkAt.handle, handle, p, p + 16, p + 24, p + 32);
  let hash = '';
  for (let w = 0; w < 4; w++) {
    const word = pkAt.module.HEAPU32[(p + 4 * w) >>> 2]!;
    for (let b = 0; b < 4; b++) hash += ((word >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
  }
  pkAt.module._free(p);
  return hash;
};

test('1.0 mm: Fast ≡ the shipped tape path exactly; callback original matches under the R9 oracles', async () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const viaFastTape = sphere.maskedByImplicit({ sdf: planeSdf });
  const viaFastCallback = sphere.maskedByImplicit({ sdf: planeFn });

  // (a) G0-exact vs the shipped tape export (bands coincide at 1.0 mm, and
  // the fill semantics are shared) — and the two Fast paths agree exactly,
  // which the OLD callback/tape pair never did at the G0 level (the vendored
  // callback path prunes its fresh grid pre-intersection, flipping ~190
  // band-edge active states on this fixture; invisible to equals/mesh/volume).
  const { compileSdfExpression } = await import('../src/tape.ts');
  const t = compileSdfExpression(planeSdf);
  const instr = pk.module._malloc(t.instructions.length * 4);
  pk.module.HEAPU32.set(t.instructions, instr >>> 2);
  const consts = pk.module._malloc(Math.max(8, t.constants.length * 8));
  pk.module.HEAPF64.set(t.constants, consts >>> 3);
  const copy = pk.module.cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (
    l: bigint,
    v: bigint,
  ) => bigint;
  const oldTape = pk.module.cwrap('Voxels_IntersectImplicitTape', null, [
    'bigint',
    'bigint',
    'number',
    'number',
    'number',
    'number',
  ]) as (l: bigint, v: bigint, i: number, ic: number, c: number, cc: number) => void;
  const referenceHandle = copy(pk.handle, sphere.handle);
  oldTape(pk.handle, referenceHandle, instr, t.instructions.length / 2, consts, t.constants.length);
  const referenceHash = rawHash(pk, referenceHandle);
  assert.equal(
    viaFastTape.gridHash().hash,
    referenceHash,
    'tape Fast must be G0-exact vs the shipped tape path at 1.0 mm',
  );
  assert.equal(
    viaFastCallback.gridHash().hash,
    referenceHash,
    'callback Fast must now agree with the tape semantics exactly',
  );

  // (b) The vendored callback original, under the oracles that gated it (R9):
  // sign-classification equality, bit-identical volume, same mesh counts.
  const rawCb = pk.module.cwrap('Voxels_IntersectImplicit', null, ['bigint', 'bigint', 'number']) as (
    l: bigint,
    v: bigint,
    fn: number,
  ) => void;
  const pointer = pk.module.addFunction((vecPtr: number) => {
    const f = pk.module.HEAPF32;
    return planeFn(f[vecPtr >>> 2]!, f[(vecPtr + 4) >>> 2]!, f[(vecPtr + 8) >>> 2]!);
  }, 'fi');
  const oldCbHandle = copy(pk.handle, sphere.handle);
  try {
    rawCb(pk.handle, oldCbHandle, pointer);
  } finally {
    pk.module.removeFunction(pointer);
  }
  const bIsEqual = pk.module.cwrap('Voxels_bIsEqual', 'boolean', ['bigint', 'bigint', 'bigint']) as (
    l: bigint,
    a: bigint,
    b: bigint,
  ) => boolean;
  assert.equal(
    bIsEqual(pk.handle, viaFastCallback.handle, oldCbHandle),
    true,
    'sign classification must match the vendored original',
  );
  // (raw .volume is representation-sensitive by documentation — the R9 gate
  // used equals + properties/mesh, not the fast approximation.)
  assert.equal(
    viaFastCallback.toMesh().triangleCount,
    (() => {
      const mh = pk.module.cwrap('Mesh_hCreateFromVoxels', 'bigint', ['bigint', 'bigint']) as (
        l: bigint,
        v: bigint,
      ) => bigint;
      const tc = pk.module.cwrap('Mesh_nTriangleCount', 'number', ['bigint', 'bigint']) as (
        l: bigint,
        m: bigint,
      ) => number;
      return tc(pk.handle, mh(pk.handle, oldCbHandle));
    })(),
    'mesh triangle count identical',
  );
});

test('fine cells: callback ≡ tape on the Fast pair, and U1 is really fixed', async () => {
  const fine = await createPico({ voxelSize: 0.25 });
  try {
    const sphere = fine.createVoxels({ shape: 'sphere', radius: 6 });
    const viaTape = sphere.maskedByImplicit({ sdf: planeSdf });
    const viaCallback = sphere.maskedByImplicit({ sdf: planeFn });
    assert.equal(viaCallback.gridHash().hash, viaTape.gridHash().hash, 'the two Fast paths must agree');

    // Reference construction from never-truncated paths: a fresh implicit
    // render over covering bounds, intersected with the sphere.
    const half = fine.createVoxels({
      shape: 'implicit',
      boundsMin: [-8, -8, -8],
      boundsMax: [8, 8, 8],
      sdf: planeSdf,
    });
    const reference = half.intersect(sphere);
    // Semantic oracles vs the reference construction (band structure differs
    // legitimately between a user-bounds render and a support-restricted one):
    assert.equal(
      viaTape.equals(reference),
      true,
      'Fast must classify identically to the reference construction',
    );
    assert.equal(viaTape.toMesh().triangleCount, reference.toMesh().triangleCount, 'same mesh');

    // The truncated-band original at 0.25 mm has band (int)0.75 = 0 — a
    // structurally different (broken) result. Document the divergence.
    const copy = fine.module.cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (
      l: bigint,
      v: bigint,
    ) => bigint;
    const raw = fine.module.cwrap('Voxels_IntersectImplicit', null, ['bigint', 'bigint', 'number']) as (
      l: bigint,
      v: bigint,
      fn: number,
    ) => void;
    const pointer = fine.module.addFunction((vecPtr: number) => {
      const f = fine.module.HEAPF32;
      return planeFn(f[vecPtr >>> 2]!, f[(vecPtr + 4) >>> 2]!, f[(vecPtr + 8) >>> 2]!);
    }, 'fi');
    const broken = copy(fine.handle, sphere.handle);
    try {
      // Band (int)0.75 = 0 → a zero-background "level set": the vendored
      // path doesn't even survive — the strongest possible form of the U1
      // defect at fine cells (at 0.4–0.7 mm it silently mis-bands instead).
      assert.throws(
        () => raw(fine.handle, broken, pointer),
        'the truncated-band original must fail at 0.25 mm — that IS the U1 bug',
      );
    } finally {
      fine.module.removeFunction(pointer);
    }
  } finally {
    fine.dispose();
  }
}, 240_000);
