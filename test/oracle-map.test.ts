// The oracle map: every export this repo adds to the ABI (a `PICOGK_API` in
// src/pico-*.cpp) names at least one test that checks it against an oracle —
// an analytic value, the upstream path it replaces, or a second independent
// path — not merely that it was called (R14 in tier2 proves that much).
//
// Each entry names the test by file and exact title; the test's body must
// reach the export (by name, or through the facade member given as `via`) and
// assert. A new export without an entry, a renamed test, or an entry whose
// export is gone fails here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { parseOwnExports } from '../scripts/parse-abi.mjs';

interface OracleTest {
  file: string;
  title: string;
  /**
   * What the test reaches the export through — a facade member, or a local
   * helper that calls one and asserts; default: the export's own name.
   */
  via?: string;
  oracle: string;
}

const TIER2 = 'tier2.test.mjs';

const ORACLES: Record<string, OracleTest[]> = {
  Mesh_GetVertices: [
    {
      file: TIER2,
      title: 'C9 — manual mesh construction, element access, bulk readback',
      oracle: 'per-element reads',
    },
    {
      file: 'bulk-mesh.test.mjs',
      title: 'bulk exports clamp to the caller buffer and report what they wrote',
      oracle: 'caller-buffer bounds',
    },
  ],
  Mesh_GetTriangles: [
    {
      file: TIER2,
      title: 'C9 — manual mesh construction, element access, bulk readback',
      oracle: 'per-element reads',
    },
  ],
  Mesh_AddVertices: [
    {
      file: TIER2,
      title: 'C9 — manual mesh construction, element access, bulk readback',
      oracle: 'per-element adds',
    },
    {
      file: 'bulk-mesh.test.mjs',
      title: 'R8 — bulk import refuses null/empty input without touching the mesh',
      oracle: 'a refused call appends nothing',
    },
  ],
  Mesh_AddTriangles: [
    {
      file: TIER2,
      title: 'C9 — manual mesh construction, element access, bulk readback',
      oracle: 'per-element adds',
    },
    {
      file: 'bulk-mesh.test.mjs',
      title: 'R8 — bulk import refuses null/empty input without touching the mesh',
      oracle: 'a refused call appends nothing',
    },
  ],
  Voxels_RenderImplicitTape: [
    {
      file: TIER2,
      title: 'C5 — implicit: JS SDF sphere matches the native primitive',
      oracle: 'the native sphere',
    },
    {
      file: 'tape.test.ts',
      title: 'tape gyroid is exactly the JS-callback gyroid: volume, counts, STL bytes',
      via: "shape: 'implicit'",
      oracle: 'the upstream callback fill, byte for byte',
    },
  ],
  Voxels_RenderImplicitTapeCompose: [
    {
      file: TIER2,
      title: 'C5 — implicit: JS SDF sphere matches the native primitive',
      oracle: 'the native sphere',
    },
    {
      file: 'tape.test.ts',
      title: 'withImplicit(expression) composes into NON-empty voxels exactly like the callback',
      via: 'withImplicit',
      oracle: 'the upstream callback compose',
    },
  ],
  Voxels_IntersectImplicitTape: [
    {
      file: TIER2,
      title: 'C5 — implicit: JS SDF sphere matches the native primitive',
      oracle: 'the native sphere',
    },
    {
      file: 'intersect-implicit.test.ts',
      title: '1.0 mm: Fast ≡ the shipped tape path exactly; callback original matches under the R9 oracles',
      oracle: 'the fast pair, exactly',
    },
  ],
  Lattice_AddBeams: [
    {
      file: TIER2,
      title: 'C6 — bulk lattice authoring reconstructs the per-element lattice exactly',
      oracle: 'per-element authoring',
    },
    {
      file: 'lattice-polyline.test.ts',
      title: 'SK-0.3 — batched authoring is bit-identical to per-element crossings',
      via: 'addBeam',
      oracle: 'per-element crossings, bit for bit',
    },
  ],
  Lattice_AddSpheres: [
    {
      file: TIER2,
      title: 'C6 — bulk lattice authoring reconstructs the per-element lattice exactly',
      oracle: 'per-element authoring',
    },
    {
      file: 'lattice-polyline.test.ts',
      title: 'SK-0.3 — batched authoring is bit-identical to per-element crossings',
      via: 'addSphere',
      oracle: 'per-element crossings, bit for bit',
    },
  ],
  Voxels_GetProperties: [
    {
      file: TIER2,
      title: 'C1 — voxel creation: sphere/capsule/copy/mesh-shell vs analytic volume',
      oracle: 'analytic volume',
    },
    {
      file: 'voxels-properties.test.ts',
      title: 'properties().area is the level-set surface area',
      via: 'properties()',
      oracle: 'analytic surface area',
    },
  ],
  Voxels_GetGridHash: [
    {
      file: TIER2,
      title: 'C17 — grid hash: stable, representation-blind, content-sensitive',
      oracle: 'stability, representation blindness, content sensitivity',
    },
    {
      file: 'grid-hash.test.ts',
      title: 'G0 grid hash — content changes move the hash (mutation test)',
      via: 'gridHash()',
      oracle: 'mutations move the hash',
    },
  ],
  Voxels_DensifyInterior: [
    {
      file: TIER2,
      title: 'C17 — grid hash: stable, representation-blind, content-sensitive',
      oracle: 'the hash of the same field',
    },
    {
      file: 'grid-hash.test.ts',
      title: 'G0 grid hash — tile vs dense-leaf encodings of one field hash equal',
      via: 'densifyInterior()',
      oracle: 'the hash of the same field',
    },
  ],
  Voxels_OffsetTuned: [
    { file: TIER2, title: 'C3 — offsets: analytic growth; double/triple offset', oracle: 'analytic growth' },
    {
      file: 'voxels-offsets.test.ts',
      title: 'Voxels_OffsetTuned with default settings IS the untuned export (bit-exact)',
      oracle: 'the untuned upstream export, bit for bit',
    },
  ],
  Voxels_RenderLatticeTubes: [
    {
      file: TIER2,
      title: 'C6 — tube-complex lattice lane agrees with the serial lane on every beam case',
      oracle: 'the serial upstream lattice renderer',
    },
    {
      file: TIER2,
      title: 'C6 — nested-radius beam: the tube lane is right and the serial lane is not (U23)',
      oracle: 'analytic volume where upstream is wrong',
    },
  ],
  Voxels_hBoolAddCopy: [
    {
      file: TIER2,
      title: 'C18 — csg*Copy: value-identical to the mutating path, inputs untouched',
      oracle: 'the mutating upstream boolean',
    },
    {
      file: 'booleans-copy.test.ts',
      title: 'variadic union/subtract chain pairwise ≡ sequential pairs',
      via: 'union(',
      oracle: 'sequential pairs',
    },
  ],
  Voxels_hBoolSubtractCopy: [
    {
      file: TIER2,
      title: 'C18 — csg*Copy: value-identical to the mutating path, inputs untouched',
      oracle: 'the mutating upstream boolean',
    },
    {
      file: 'booleans-copy.test.ts',
      title: 'variadic union/subtract chain pairwise ≡ sequential pairs',
      via: 'subtract(',
      oracle: 'sequential pairs',
    },
  ],
  Voxels_hBoolIntersectCopy: [
    {
      file: TIER2,
      title: 'C18 — csg*Copy: value-identical to the mutating path, inputs untouched',
      oracle: 'the mutating upstream boolean',
    },
  ],
  Voxels_bIsEqualFast: [
    {
      file: TIER2,
      title: 'C18 — csg*Copy: value-identical to the mutating path, inputs untouched',
      oracle: "the dense upstream Voxels_bIsEqual's verdict",
    },
    {
      file: 'bisequal.test.ts',
      title: 'equal / sign-differ / coincident-surface verdicts, upstream-identical',
      via: 'agree(', // calls voxels.equals() both ways and asserts it against the raw scan
      oracle: "the dense upstream scan's verdict, both operand orders",
    },
  ],
  Voxels_ProjectZSliceFast: [
    {
      file: TIER2,
      title: 'C19 — ProjectZSliceFast: upstream-identical at 1.0 mm, corrected seal elsewhere',
      oracle: 'the upstream export where the seal counts coincide',
    },
    {
      file: 'zslice.test.ts',
      title: 'direct per-column min oracle on an analytic sphere, both directions',
      via: 'projectZSlice',
      oracle: 'a per-column minimum computed directly',
    },
  ],
  Voxels_IntersectImplicitFast: [
    {
      file: TIER2,
      title: 'C20 — IntersectImplicit{,Tape}Fast: cross-path exact, content-sensitive',
      oracle: 'the tape path, exactly',
    },
  ],
  Voxels_IntersectImplicitTapeFast: [
    {
      file: TIER2,
      title: 'C20 — IntersectImplicit{,Tape}Fast: cross-path exact, content-sensitive',
      oracle: 'the callback path, exactly',
    },
    {
      file: 'tape.test.ts',
      title: 'maskedByImplicit(expression) is exactly the callback gyroid-in-sphere',
      via: 'maskedByImplicit',
      oracle: 'the callback path, byte for byte',
    },
  ],
  Voxels_RayCastBatch: [
    {
      file: TIER2,
      title: 'C21 — RayCastBatch/ClosestPointBatch: counts and content sane',
      oracle: 'analytic sphere hits',
    },
    {
      file: 'query-batch.test.ts',
      title: 'raycastBatch ≡ serial raycastToSurface, exact per ray, hit/miss 100% off-grazing',
      via: 'raycastBatch',
      oracle: 'the serial upstream raycast, per ray',
    },
  ],
  Voxels_ClosestPointBatch: [
    {
      file: TIER2,
      title: 'C21 — RayCastBatch/ClosestPointBatch: counts and content sane',
      oracle: 'analytic sphere',
    },
    {
      file: 'query-batch.test.ts',
      title: 'closestPointsOnSurface: sub-voxel, in-band, within one voxel of the true minimum',
      via: 'closestPointsOnSurface',
      oracle: 'the true minimum distance',
    },
  ],
};

const ROOT = join(import.meta.dirname, '..');
const ownExports = readdirSync(join(ROOT, 'src'))
  .filter((file) => /^pico-[a-z-]+\.cpp$/u.test(file))
  .flatMap((file) => parseOwnExports(readFileSync(join(ROOT, 'src', file), 'utf8')) as { name: string }[])
  .map((fn) => fn.name)
  .sort();

/** The body of the top-level test titled `title`: up to the next top-level test, or the end of the file. */
const testBody = (file: string, title: string): string | undefined => {
  const source = readFileSync(join(import.meta.dirname, file), 'utf8');
  const start = ['"', "'", '`']
    .map((quote) => source.indexOf(`\ntest(${quote}${title}${quote}`))
    .find((index) => index >= 0);
  if (start === undefined) return undefined;
  const next = source.indexOf('\ntest(', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

test('every own export has an entry, and every entry is an own export', () => {
  assert.ok(ownExports.length > 0);
  assert.deepEqual(
    Object.keys(ORACLES).sort(),
    ownExports,
    'test/oracle-map.test.ts must map every PICOGK_API in src/pico-*.cpp to an oracle-bearing test',
  );
});

for (const [name, tests] of Object.entries(ORACLES)) {
  test(`${name}: its oracle tests exist, reach it and assert`, () => {
    assert.ok(tests.length > 0, `${name} names no oracle test`);
    for (const { file, title, via = name } of tests) {
      const body = testBody(file, title);
      assert.ok(body, `test/${file} has no top-level test titled "${title}"`);
      assert.ok(body.includes(via), `"${title}" (test/${file}) never reaches ${name} through ${via}`);
      assert.match(body, /\bassert\b|\bexpect\(/u, `"${title}" (test/${file}) asserts nothing`);
    }
  });
}
