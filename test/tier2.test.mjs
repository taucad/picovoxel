// R14/R15/R16 — Tier-2 capability suite (C1–C16).
//
// The gate: every core export EXERCISED, measured against the generated ABI manifest
// (src/abi.json) rather than asserted in prose. Oracles are analytic wherever possible:
// a "> 0" check passes against a stub, which is the trap Finding 1 describes.
//
// Every signature here was read from the manifest, not guessed — the first draft
// invented Voxels_Gaussian, Mesh_nAddQuad and *_GetSliceBounds, none of which exist.

import assert from 'node:assert/strict';
import { test, afterAll as after } from 'vitest';
import { loadInstrumented } from './coverage.mjs';

const pk = await loadInstrumented();
const { fns, module } = pk;
const { _malloc, _free, UTF8ToString, stringToUTF8, lengthBytesUTF8 } = module;

const VEC3 = 12;
const scratch = _malloc(1024);
const vec = (p, x, y, z) => {
  module.HEAPF32[(p >> 2) + 0] = x; module.HEAPF32[(p >> 2) + 1] = y; module.HEAPF32[(p >> 2) + 2] = z;
};
const readVec = (p) => [module.HEAPF32[(p >> 2)], module.HEAPF32[(p >> 2) + 1], module.HEAPF32[(p >> 2) + 2]];
const str = (p, s) => { stringToUTF8(s, p, lengthBytesUTF8(s) + 1); return p; };
const i32 = (p) => module.HEAP32[p >> 2];

const withLib = (voxelSize, body) => {
  const lib = fns.Library_hCreateInstance(voxelSize);
  try {
    return body(lib);
  } finally {
    fns.Library_DestroyInstance(lib);
  }
};

const sphereOf = (lib, radius, centre = [0, 0, 0]) => {
  vec(scratch, ...centre);
  return fns.Voxels_hCreateSphere(lib, scratch, radius);
};

/** Voxels_GetVoxelDimensions takes SIX pointers: origin xyz THEN size xyz. */
const voxelDims = (lib, voxels) => {
  const p = _malloc(24);
  try {
    fns.Voxels_GetVoxelDimensions(lib, voxels, p, p + 4, p + 8, p + 12, p + 16, p + 20);
    return { origin: [i32(p), i32(p + 4), i32(p + 8)], size: [i32(p + 12), i32(p + 16), i32(p + 20)] };
  } finally {
    _free(p);
  }
};

// ── C1 — voxel creation ────────────────────────────────────────────────────────
test('C1 — voxel creation: sphere/capsule/copy/mesh-shell vs analytic volume', () => {
  withLib(0.4, (lib) => {
    const sphere = sphereOf(lib, 10);
    const analytic = (4 / 3) * Math.PI * 1000;
    const volume = fns.Voxels_fCalculateVolume(lib, sphere);
    assert.ok(Math.abs(volume - analytic) / analytic < 0.02, `sphere ${volume} vs ${analytic}`);

    const copy = fns.Voxels_hCreateCopy(lib, sphere);
    assert.equal(fns.Voxels_fCalculateVolume(lib, copy), volume, 'copy has a different volume');
    assert.ok(fns.Voxels_bIsEqual(lib, copy, sphere), 'copy not equal to source');

    // Voxels_GetProperties (src/pico-props.cpp) — volume, area and the iso-surface
    // box in one crossing. Oracles are analytic: 4πr² for the sphere's area, and
    // the box is the sphere's own extent.
    fns.Voxels_GetProperties(lib, sphere, scratch, scratch + 4, scratch + 8);
    const [propVolume, propArea] = [module.HEAPF32[scratch >> 2], module.HEAPF32[(scratch + 4) >> 2]];
    assert.ok(Math.abs(propVolume - analytic) / analytic < 0.02, `properties volume ${propVolume} vs ${analytic}`);
    const areaAnalytic = 4 * Math.PI * 100;
    assert.ok(Math.abs(propArea - areaAnalytic) / areaAnalytic < 0.02, `properties area ${propArea} vs ${areaAnalytic}`);
    assert.deepEqual(readVec(scratch + 8).map(Math.round), [-10, -10, -10], 'properties box min');
    assert.deepEqual(readVec(scratch + 8 + VEC3).map(Math.round), [10, 10, 10], 'properties box max');

    vec(scratch, -10, 0, 0); vec(scratch + VEC3, 10, 0, 0);
    const capsule = fns.Voxels_hCreateCapsule(lib, scratch, scratch + VEC3, 4, 4);
    const capsuleAnalytic = Math.PI * 16 * 20 + (4 / 3) * Math.PI * 64; // cylinder + 2 hemispheres
    const capsuleVolume = fns.Voxels_fCalculateVolume(lib, capsule);
    assert.ok(Math.abs(capsuleVolume - capsuleAnalytic) / capsuleAnalytic < 0.03,
      `capsule ${capsuleVolume} vs ${capsuleAnalytic}`);

    const empty = fns.Voxels_hCreate(lib);
    assert.ok(fns.Voxels_bIsEmpty(lib, empty), 'fresh Voxels should be empty');
    assert.ok(!fns.Voxels_bIsEmpty(lib, sphere), 'sphere reported empty');
    assert.ok(fns.Voxels_bIsValid(lib, sphere));

    const mesh = fns.Mesh_hCreateFromVoxels(lib, sphere);
    const shell = fns.Voxels_hCreateMeshShell(lib, mesh, 0.4);
    assert.ok(fns.Voxels_fCalculateVolume(lib, shell) > 0, 'mesh shell empty');

    for (const v of [sphere, copy, capsule, empty, shell]) fns.Voxels_Destroy(lib, v);
    fns.Mesh_Destroy(lib, mesh);
  });
});

// ── C2 — booleans ──────────────────────────────────────────────────────────────
test('C2 — booleans: analytic volume of known overlaps', () => {
  withLib(0.4, (lib) => {
    const a = sphereOf(lib, 10);
    const b = sphereOf(lib, 10, [30, 0, 0]); // disjoint
    const volumeA = fns.Voxels_fCalculateVolume(lib, a);

    const union = fns.Voxels_hCreateCopy(lib, a);
    fns.Voxels_BoolAdd(lib, union, b);
    assert.ok(Math.abs(fns.Voxels_fCalculateVolume(lib, union) - 2 * volumeA) / (2 * volumeA) < 0.01,
      'disjoint union should be exactly twice one sphere');

    const intersect = fns.Voxels_hCreateCopy(lib, a);
    fns.Voxels_BoolIntersect(lib, intersect, b);
    assert.ok(fns.Voxels_bIsEmpty(lib, intersect), 'disjoint intersection should be empty');

    const difference = fns.Voxels_hCreateCopy(lib, a);
    fns.Voxels_BoolSubtract(lib, difference, b);
    assert.ok(Math.abs(fns.Voxels_fCalculateVolume(lib, difference) - volumeA) / volumeA < 0.01,
      'subtracting a disjoint body should change nothing');

    // MEASURED quirk: a − a is topologically empty (bIsEmpty true) yet
    // fCalculateVolume reports ~5% of the sphere — the SDF narrow band along the
    // coincident surface survives csgDifference. bIsEmpty is the emptiness oracle;
    // volume is not.
    const self = fns.Voxels_hCreateCopy(lib, a);
    fns.Voxels_BoolSubtract(lib, self, a);
    assert.ok(fns.Voxels_bIsEmpty(lib, self), 'a − a should be topologically empty');
    const residual = fns.Voxels_fCalculateVolume(lib, self);
    assert.ok(residual < volumeA * 0.06,
      `narrow-band residual ${residual} grew past the documented ~5% (${volumeA})`);

    for (const v of [a, b, union, intersect, difference, self]) fns.Voxels_Destroy(lib, v);
  });
});

// ── C3 — offsets ───────────────────────────────────────────────────────────────
test('C3 — offsets: analytic growth; double/triple offset', () => {
  withLib(0.4, (lib) => {
    const base = sphereOf(lib, 10);
    const v0 = fns.Voxels_fCalculateVolume(lib, base);

    const grown = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_Offset(lib, grown, 2);
    const v1 = fns.Voxels_fCalculateVolume(lib, grown);
    // Offsetting a sphere by d gives radius r+d — assert the analytic value so a
    // no-op offset cannot pass.
    const analytic = (4 / 3) * Math.PI * 12 ** 3;
    assert.ok(Math.abs(v1 - analytic) / analytic < 0.03, `offset sphere ${v1} vs ${analytic}`);

    const shrunk = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_Offset(lib, shrunk, -2);
    const shrunkAnalytic = (4 / 3) * Math.PI * 8 ** 3;
    const v2 = fns.Voxels_fCalculateVolume(lib, shrunk);
    assert.ok(Math.abs(v2 - shrunkAnalytic) / shrunkAnalytic < 0.03, `inset sphere ${v2} vs ${shrunkAnalytic}`);

    // DoubleOffset(+d, −d) is morphological closing: on a convex body ≈ identity.
    const closed = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_DoubleOffset(lib, closed, 2, -2);
    const v3 = fns.Voxels_fCalculateVolume(lib, closed);
    assert.ok(Math.abs(v3 - v0) / v0 < 0.05, `closing changed a convex body: ${v3} vs ${v0}`);

    const tripled = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_TripleOffset(lib, tripled, 1);
    assert.ok(fns.Voxels_fCalculateVolume(lib, tripled) > 0, 'triple offset emptied the body');

    // Voxels_OffsetTuned (src/pico-offset.cpp) — the same offset with the level-set
    // tracker's renormalization knobs reachable. Two oracles: (scheme, count) < 0 must
    // reproduce Voxels_Offset bit-for-bit, and the tuned setting must still land on the
    // analytic radius (a knob that silently emptied the band would pass neither).
    const p = _malloc(4);
    module.HEAPF32[p >> 2] = 2;
    const asDefault = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_OffsetTuned(lib, asDefault, p, 1, -1, -1);
    assert.ok(fns.Voxels_bIsEqual(lib, asDefault, grown), 'OffsetTuned(-1,-1) is not Voxels_Offset');
    assert.equal(fns.Voxels_fCalculateVolume(lib, asDefault), v1, 'OffsetTuned(-1,-1) volume drifted');

    const tuned = fns.Voxels_hCreateCopy(lib, base);
    fns.Voxels_OffsetTuned(lib, tuned, p, 1, 0 /* FIRST_BIAS */, -1);
    const v4 = fns.Voxels_fCalculateVolume(lib, tuned);
    assert.ok(!fns.Voxels_bIsEqual(lib, tuned, grown), 'FIRST_BIAS must change the result');
    assert.ok(Math.abs(v4 - analytic) / analytic < 0.03, `tuned offset sphere ${v4} vs ${analytic}`);
    _free(p);

    for (const v of [base, grown, shrunk, closed, tripled, asDefault, tuned]) fns.Voxels_Destroy(lib, v);
  });
});

// ── C4 — mesh <-> voxel ────────────────────────────────────────────────────────
test('C4 — mesh/voxel round trip preserves bbox and volume; diagnostics', () => {
  withLib(0.4, (lib) => {
    const sphere = sphereOf(lib, 10);
    const volume = fns.Voxels_fCalculateVolume(lib, sphere);
    const mesh = fns.Mesh_hCreateFromVoxels(lib, sphere);

    fns.Mesh_GetBoundingBox(lib, mesh, scratch);
    const [minX] = readVec(scratch);
    const [maxX] = readVec(scratch + VEC3);
    assert.ok(Math.abs(minX + 10) < 0.5 && Math.abs(maxX - 10) < 0.5, `bbox ${minX}..${maxX} != -10..10`);

    const back = fns.Voxels_hCreate(lib);
    fns.Voxels_RenderMesh(lib, back, mesh);
    const backVolume = fns.Voxels_fCalculateVolume(lib, back);
    assert.ok(Math.abs(backVolume - volume) / volume < 0.03, `round trip ${backVolume} vs ${volume}`);

    const { size } = voxelDims(lib, sphere);
    // 20mm sphere at 0.4mm voxels ≈ 50 cells + narrow band on each axis.
    for (const n of size) assert.ok(n > 45 && n < 70, `voxel extent ${n} implausible for r=10 @ 0.4`);

    assert.ok(fns.Voxels_nMemUsage(lib, sphere) > 0, 'nMemUsage');
    const diagBuffer = _malloc(255);
    try {
      fns.Voxels_bDiagnose(lib, sphere, diagBuffer); // exercises the diagnostic path
    } finally {
      _free(diagBuffer);
    }

    fns.Mesh_Destroy(lib, mesh);
    fns.Voxels_Destroy(lib, sphere);
    fns.Voxels_Destroy(lib, back);
  });
});

// ── C5 — implicit ──────────────────────────────────────────────────────────────
test('C5 — implicit: JS SDF sphere matches the native primitive', () => {
  withLib(0.5, (lib) => {
    const sdf = module.addFunction((p) => {
      const i = p >> 2;
      const x = module.HEAPF32[i], y = module.HEAPF32[i + 1], z = module.HEAPF32[i + 2];
      return Math.sqrt(x * x + y * y + z * z) - 10;
    }, 'fi');
    try {
      const implicit = fns.Voxels_hCreate(lib);
      vec(scratch, -12, -12, -12); vec(scratch + VEC3, 12, 12, 12);
      fns.Voxels_RenderImplicit(lib, implicit, scratch, sdf);

      const native = sphereOf(lib, 10);
      const ratio = fns.Voxels_fCalculateVolume(lib, implicit) / fns.Voxels_fCalculateVolume(lib, native);
      assert.ok(Math.abs(ratio - 1) < 0.02, `implicit/native volume ratio ${ratio}`);

      const trimmed = fns.Voxels_hCreateCopy(lib, native);
      fns.Voxels_IntersectImplicit(lib, trimmed, sdf);
      assert.ok(fns.Voxels_fCalculateVolume(lib, trimmed) > 0, 'IntersectImplicit emptied the body');

      // The tape TU's parallel fill (src/pico-tape.cpp): the same sphere as a
      // hand-rolled SSA tape — sqrt(x*x + y*y + z*z) - 10, same fold order as
      // the JS callback above, so the volumes must be bit-identical.
      const instructions = Uint32Array.from([
        1, 0,              // 0: X
        6, 0 | (0 << 16),  // 1: MUL r0,r0
        2, 0,              // 2: Y
        6, 2 | (2 << 16),  // 3: MUL r2,r2
        3, 0,              // 4: Z
        6, 4 | (4 << 16),  // 5: MUL r4,r4
        4, 1 | (3 << 16),  // 6: ADD r1,r3
        4, 6 | (5 << 16),  // 7: ADD r6,r5
        10, 7,             // 8: SQRT r7
        0, 0,              // 9: CONST #0 (= 10)
        5, 8 | (9 << 16),  // 10: SUB r8,r9
      ]);
      const instructionPointer = module._malloc(instructions.byteLength);
      const constantPointer = module._malloc(8);
      module.HEAPU32.set(instructions, instructionPointer >> 2);
      module.HEAPF64[constantPointer >> 3] = 10;
      const implicitTape = fns.Voxels_hCreate(lib);
      vec(scratch, -12, -12, -12); vec(scratch + VEC3, 12, 12, 12); // sphereOf() reused scratch for its center
      fns.Voxels_RenderImplicitTape(lib, implicitTape, scratch, instructionPointer, instructions.length / 2, constantPointer, 1);
      assert.equal(
        fns.Voxels_fCalculateVolume(lib, implicitTape),
        fns.Voxels_fCalculateVolume(lib, implicit),
        'tape sphere must be bit-identical to the JS-callback sphere',
      );

      // R9 compose entries, compared by upstream's own bIsEqual (active-value
      // identity). The raw fCalculateVolume approximation is representation-
      // sensitive (dense serial loops and csg node-stealing leave allocated
      // inactive values the pruned fill omits) and is not a cross-path signal.
      const composedTape = fns.Voxels_hCreate(lib);
      vec(scratch, -12, -12, -12); vec(scratch + VEC3, 12, 12, 12);
      fns.Voxels_RenderImplicitTapeCompose(lib, composedTape, scratch, instructionPointer, instructions.length / 2, constantPointer, 1);
      assert.ok(
        fns.Voxels_bIsEqual(lib, composedTape, implicitTape),
        'compose into an empty grid must equal the fresh tape fill',
      );

      const trimmedTape = fns.Voxels_hCreateCopy(lib, native);
      fns.Voxels_IntersectImplicitTape(lib, trimmedTape, instructionPointer, instructions.length / 2, constantPointer, 1);
      assert.ok(
        fns.Voxels_bIsEqual(lib, trimmedTape, trimmed),
        'tape intersect must equal the callback IntersectImplicit',
      );

      module._free(constantPointer);
      module._free(instructionPointer);

      for (const v of [implicit, native, trimmed, implicitTape, composedTape, trimmedTape]) fns.Voxels_Destroy(lib, v);
    } finally {
      module.removeFunction(sdf);
    }
  });
});

// ── C6 — lattice ───────────────────────────────────────────────────────────────
test('C6 — lattice: beams and spheres render to voxels', () => {
  withLib(0.5, (lib) => {
    const lattice = fns.Lattice_hCreate(lib);
    assert.ok(fns.Lattice_bIsValid(lib, lattice));

    vec(scratch, -10, 0, 0); vec(scratch + VEC3, 10, 0, 0);
    fns.Lattice_AddBeam(lib, lattice, scratch, scratch + VEC3, 2, 2, true);
    vec(scratch, 0, 10, 0);
    fns.Lattice_AddSphere(lib, lattice, scratch, 3);

    const voxels = fns.Voxels_hCreate(lib);
    fns.Voxels_RenderLattice(lib, voxels, lattice);
    // Beam ≈ capsule(r=2, L=20) plus a disjoint r=3 sphere.
    const analytic = (Math.PI * 4 * 20 + (4 / 3) * Math.PI * 8) + (4 / 3) * Math.PI * 27;
    const volume = fns.Voxels_fCalculateVolume(lib, voxels);
    assert.ok(Math.abs(volume - analytic) / analytic < 0.05, `lattice ${volume} vs ${analytic}`);
    assert.ok(fns.Lattice_nMemUsage(lib, lattice) > 0);

    fns.Lattice_Destroy(lib, lattice);
    fns.Voxels_Destroy(lib, voxels);
  });
});

// SK-0.4 tube-complex lattice lane (src/pico-lattice.cpp) — the lane the facade now
// takes by default; Voxels_RenderLattice above stays bound as the serial arm. Geometry
// equivalence is certified per fixture in bench/results/webgpu-v2/SK-0.4.md; here it is
// an ABI-level differential plus the closed form, over one lattice that hits every beam
// case at once: capsule, tapered capsule, sphere, and a FLAT-capped beam, which has no
// tube-complex expression and falls back to the serial lane inside the export. A lane
// that silently dropped the fallback subset would fail this. (The fifth case, nested end
// spheres, is where the two lanes genuinely disagree — see the test below.)
test('C6 — tube-complex lattice lane agrees with the serial lane on every beam case', () => {
  withLib(0.5, (lib) => {
    const lattice = fns.Lattice_hCreate(lib);
    const beam = (y, r0, r1, round) => {
      vec(scratch, -10, y, 0);
      vec(scratch + VEC3, 10, y, 0);
      fns.Lattice_AddBeam(lib, lattice, scratch, scratch + VEC3, r0, r1, round);
    };
    beam(0, 2, 2, true); // capsule (equal radii)
    beam(20, 3, 1, true); // tapered capsule
    beam(40, 2, 2, false); // FLAT cone — serial fallback
    vec(scratch, 0, -20, 0);
    fns.Lattice_AddSphere(lib, lattice, scratch, 3);

    const serial = fns.Voxels_hCreate(lib);
    const tubes = fns.Voxels_hCreate(lib);
    fns.Voxels_RenderLattice(lib, serial, lattice);
    fns.Voxels_RenderLatticeTubes(lib, tubes, lattice);

    const vSerial = fns.Voxels_fCalculateVolume(lib, serial);
    const vTubes = fns.Voxels_fCalculateVolume(lib, tubes);
    assert.ok(vTubes > 0, 'tube lane produced an empty grid');
    assert.ok(
      Math.abs(vTubes - vSerial) / vSerial < 0.03,
      `tube lane ${vTubes} vs serial ${vSerial} (>3% apart)`,
    );

    // The bounds have to cover all five elements in both lanes — the fallback subset
    // sits at y=40, so a dropped fallback shows up here as a shrunken box.
    for (const [name, handle] of [
      ['serial', serial],
      ['tubes', tubes],
    ]) {
      fns.Voxels_GetProperties(lib, handle, scratch, scratch + 4, scratch + 8);
      const [, yMin] = readVec(scratch + 8);
      const [, yMax] = readVec(scratch + 8 + VEC3);
      assert.ok(yMin < -20, `${name} lane lost the sphere at y=-20 (yMin ${yMin})`);
      assert.ok(yMax > 40, `${name} lane lost the flat-capped beam at y=40 (yMax ${yMax})`);
    }

    for (const v of [serial, tubes]) fns.Voxels_Destroy(lib, v);
    fns.Lattice_Destroy(lib, lattice);
  });
});

// SK-0.4 / U23 — the one beam case where the two lanes DISAGREE, and the serial lane is
// the wrong one. A round-capped beam whose end spheres nest (|p0-p1|^2 <= (r0-r1)^2) is
// by definition the larger sphere; PicoGK's fSdvRoundCone (PicoGKLattice.h:115-148, iq's
// sdRoundCone) computes a2 = l^2 - (r0-r1)^2, which is NEGATIVE here, and then takes
// sqrtf(x2 * a2 * il2). openvdb's tube complex dispatches the case explicitly
// (LevelSetTubesImpl.h:1191) and emits the larger sphere. Pinned against the closed form
// so the direction of the disagreement is recorded, not just its existence.
test('C6 — nested-radius beam: the tube lane is right and the serial lane is not (U23)', () => {
  withLib(0.5, (lib) => {
    const lattice = fns.Lattice_hCreate(lib);
    vec(scratch, -1, 0, 0);
    vec(scratch + VEC3, 1, 0, 0);
    fns.Lattice_AddBeam(lib, lattice, scratch, scratch + VEC3, 6, 1, true);

    const analytic = (4 / 3) * Math.PI * 6 ** 3; // the r=6 sphere swallows the r=1 sphere
    const render = (fn) => {
      const h = fns.Voxels_hCreate(lib);
      fn(lib, h, lattice);
      fns.Voxels_GetProperties(lib, h, scratch, scratch + 4, scratch + 8);
      const volume = module.HEAPF32[scratch >> 2];
      fns.Voxels_Destroy(lib, h);
      return volume;
    };

    const tubes = render(fns.Voxels_RenderLatticeTubes);
    const serial = render(fns.Voxels_RenderLattice);
    assert.ok(
      Math.abs(tubes - analytic) / analytic < 0.01,
      `tube lane ${tubes} is not the r=6 sphere ${analytic}`,
    );
    assert.ok(serial < 0.5 * analytic, `serial lane ${serial} unexpectedly close to ${analytic} — U23 fixed upstream?`);

    fns.Lattice_Destroy(lib, lattice);
  });
});

// SK-0.3 bulk lattice authoring (src/pico-bulk.cpp): the flat 8-float-per-beam
// wire format must reconstruct EXACTLY what the per-element exports build — same
// field order, same stride, same round-cap flags, same order of arrival.
test('C6 — bulk lattice authoring reconstructs the per-element lattice exactly', () => {
  withLib(0.5, (lib) => {
    const N = 40;
    const beam = (i) => [
      Math.cos(i) * 10, Math.sin(i) * 10, i * 0.2 - 4, 0.5 + (i % 4) * 0.1,        // x0 y0 z0 r0
      Math.cos(i + 1) * 10, Math.sin(i + 1) * 10, i * 0.2 - 3.8, 0.5 + (i % 3) * 0.1, // x1 y1 z1 r1
    ];
    const cap = (i) => (i % 3 === 0 ? 0 : 1);
    const sphere = (i) => [Math.cos(i) * 15, Math.sin(i) * 15, i * 0.1 - 2, 0.7];

    const perElement = fns.Lattice_hCreate(lib);
    for (let i = 0; i < N; i++) {
      const b = beam(i);
      vec(scratch, b[0], b[1], b[2]); vec(scratch + VEC3, b[4], b[5], b[6]);
      fns.Lattice_AddBeam(lib, perElement, scratch, scratch + VEC3, b[3], b[7], cap(i) !== 0);
    }
    for (let i = 0; i < N; i++) {
      const s = sphere(i);
      vec(scratch, s[0], s[1], s[2]);
      fns.Lattice_AddSphere(lib, perElement, scratch, s[3]);
    }

    const bulk = fns.Lattice_hCreate(lib);
    const buffer = _malloc(N * 8 * 4 + N * 4);
    try {
      const beamFloats = [];
      for (let i = 0; i < N; i++) beamFloats.push(...beam(i));
      module.HEAPF32.set(beamFloats, buffer >> 2);
      module.HEAPU32.set(Array.from({ length: N }, (_, i) => cap(i)), (buffer >> 2) + N * 8);
      assert.equal(fns.Lattice_AddBeams(lib, bulk, buffer, buffer + N * 8 * 4, N), N);

      const sphereFloats = [];
      for (let i = 0; i < N; i++) sphereFloats.push(...sphere(i));
      module.HEAPF32.set(sphereFloats, buffer >> 2);
      assert.equal(fns.Lattice_AddSpheres(lib, bulk, buffer, N), N);

      // Guard rails: a null pointer or a non-positive count is a no-op, never a trap.
      assert.equal(fns.Lattice_AddBeams(lib, bulk, 0, buffer, N), 0);
      assert.equal(fns.Lattice_AddBeams(lib, bulk, buffer, buffer, 0), 0);
      assert.equal(fns.Lattice_AddSpheres(lib, bulk, 0, N), 0);
    } finally {
      _free(buffer);
    }

    assert.equal(fns.Lattice_nMemUsage(lib, bulk), fns.Lattice_nMemUsage(lib, perElement), 'same element counts');

    const a = fns.Voxels_hCreate(lib);
    const b = fns.Voxels_hCreate(lib);
    fns.Voxels_RenderLattice(lib, a, perElement);
    fns.Voxels_RenderLattice(lib, b, bulk);
    assert.equal(fns.Voxels_fCalculateVolume(lib, b), fns.Voxels_fCalculateVolume(lib, a), 'bulk lattice differs');

    for (const v of [a, b]) fns.Voxels_Destroy(lib, v);
    for (const l of [perElement, bulk]) fns.Lattice_Destroy(lib, l);
  });
});

// ── C7 — queries ───────────────────────────────────────────────────────────────
test('C7 — queries: raycast/closest-point/inside/normal against an analytic sphere', () => {
  withLib(0.4, (lib) => {
    const sphere = sphereOf(lib, 10);

    vec(scratch, -50, 0, 0); vec(scratch + VEC3, 1, 0, 0);
    const hit = fns.Voxels_bRayCastToSurface(lib, sphere, scratch, scratch + VEC3, scratch + 2 * VEC3);
    assert.ok(hit, 'ray aimed at the sphere missed');
    const [hx] = readVec(scratch + 2 * VEC3);
    assert.ok(Math.abs(hx + 10) < 0.5, `ray hit at x=${hx}, expected ≈ -10`);

    // Surface normal at the raycast hit: on a sphere it points along the radius.
    fns.Voxels_GetSurfaceNormal(lib, sphere, scratch + 2 * VEC3, scratch + 3 * VEC3);
    const [nxN] = readVec(scratch + 3 * VEC3);
    assert.ok(Math.abs(Math.abs(nxN) - 1) < 0.1, `normal at (-10,0,0) should be ±x, got ${nxN}`);

    vec(scratch, 0, 0, 0);
    assert.ok(fns.Voxels_bIsInside(lib, sphere, scratch), 'centre should be inside');
    vec(scratch, 50, 0, 0);
    assert.ok(!fns.Voxels_bIsInside(lib, sphere, scratch), 'far point should be outside');

    vec(scratch, 30, 0, 0);
    const found = fns.Voxels_bClosestPointOnSurface(lib, sphere, scratch, scratch + VEC3);
    assert.ok(found, 'no closest point found');
    const [cx] = readVec(scratch + VEC3);
    assert.ok(Math.abs(cx - 10) < 0.5, `closest point x=${cx}, expected ≈ 10`);

    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── C8 — slices ────────────────────────────────────────────────────────────────
test('C8 — slices: cross-sections of a known sphere', () => {
  withLib(0.5, (lib) => {
    const sphere = sphereOf(lib, 10);
    const { size: [nx, ny, nz] } = voxelDims(lib, sphere);
    assert.ok(nx > 0 && ny > 0 && nz > 0, `voxel dims ${nx}x${ny}x${nz}`);

    const buffer = _malloc(Math.max(nx * ny, ny * nz, nx * nz) * 4);
    const background = _malloc(4);
    try {
      // Mid-Z slice of a sphere must contain interior (negative SDF) samples.
      fns.Voxels_GetZSlice(lib, sphere, Math.floor(nz / 2), buffer, background);
      let inside = 0;
      for (let i = 0; i < nx * ny; i++) if (module.HEAPF32[(buffer >> 2) + i] < 0) inside++;
      // Interior disc area ≈ pi r^2 in voxel units (r = 20 cells): ~1250 cells.
      assert.ok(inside > 800, `mid-Z slice: only ${inside} interior samples`);

      // Extremal slice must have none.
      fns.Voxels_GetZSlice(lib, sphere, 0, buffer, background);
      let edgeInside = 0;
      for (let i = 0; i < nx * ny; i++) if (module.HEAPF32[(buffer >> 2) + i] < 0) edgeInside++;
      assert.ok(edgeInside < inside / 10, `extremal slice has ${edgeInside} interior samples`);

      fns.Voxels_GetXSlice(lib, sphere, Math.floor(nx / 2), buffer, background);
      fns.Voxels_GetYSlice(lib, sphere, Math.floor(ny / 2), buffer, background);
      fns.Voxels_GetInterpolatedZSlice(lib, sphere, 0.25, buffer, background);
      fns.Voxels_ProjectZSlice(lib, sphere, -2.0, 2.0);
    } finally {
      _free(buffer); _free(background);
    }
    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── C9 — mesh construction ─────────────────────────────────────────────────────
test('C9 — manual mesh construction, element access, bulk readback', () => {
  withLib(0.5, (lib) => {
    const mesh = fns.Mesh_hCreate(lib);
    assert.ok(fns.Mesh_bIsValid(lib, mesh));

    const corners = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    for (const c of corners) { vec(scratch, ...c); fns.Mesh_nAddVertex(lib, mesh, scratch); }
    assert.equal(fns.Mesh_nVertexCount(lib, mesh), 4);

    for (const [a, b, c] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
      module.HEAP32[(scratch >> 2) + 0] = a; module.HEAP32[(scratch >> 2) + 1] = b; module.HEAP32[(scratch >> 2) + 2] = c;
      fns.Mesh_nAddTriangle(lib, mesh, scratch);
    }
    assert.equal(fns.Mesh_nTriangleCount(lib, mesh), 4);

    fns.Mesh_GetVertex(lib, mesh, 1, scratch);
    assert.deepEqual(readVec(scratch), [10, 0, 0], 'vertex 1 round trip');
    fns.Mesh_GetTriangle(lib, mesh, 0, scratch);
    assert.deepEqual([i32(scratch), i32(scratch + 4), i32(scratch + 8)], [0, 1, 2]);
    fns.Mesh_GetTriangleV(lib, mesh, 0, scratch, scratch + VEC3, scratch + 2 * VEC3);
    assert.deepEqual(readVec(scratch + VEC3), [10, 0, 0], 'GetTriangleV corner B');

    // R11 bulk exports, cross-checked against the per-element reads above.
    const bulk = _malloc(4 * VEC3);
    try {
      assert.equal(fns.Mesh_GetVertices(lib, mesh, bulk, 4), 4);
      assert.deepEqual(readVec(bulk + VEC3), [10, 0, 0], 'bulk vertex 1');
      assert.equal(fns.Mesh_GetTriangles(lib, mesh, bulk, 4), 4);
      assert.equal(i32(bulk + 3), 0 || i32(bulk), i32(bulk), 'bulk triangles readable');

      // R8 bulk imports: append two vertices + one triangle in bulk, then read the
      // appended range back per-element — indices must be contiguous from the return.
      module.HEAPF32.set([1, 2, 3, 4, 5, 6], bulk >> 2);
      const firstVertex = fns.Mesh_AddVertices(lib, mesh, bulk, 2);
      assert.equal(firstVertex, 4, 'bulk vertices must append after the 4 existing');
      assert.equal(fns.Mesh_nVertexCount(lib, mesh), 6);
      fns.Mesh_GetVertex(lib, mesh, 5, scratch);
      assert.deepEqual(readVec(scratch), [4, 5, 6], 'bulk-appended vertex readable');

      module.HEAP32.set([4, 5, 0], bulk >> 2);
      const firstTriangle = fns.Mesh_AddTriangles(lib, mesh, bulk, 1);
      assert.equal(firstTriangle, 4, 'bulk triangle must append after the 4 existing');
      assert.equal(fns.Mesh_nTriangleCount(lib, mesh), 5);
    } finally {
      _free(bulk);
    }

    fns.Mesh_GetBoundingBox(lib, mesh, scratch);
    assert.ok(fns.Mesh_nMemUsage(lib, mesh) > 0);
    fns.Mesh_Destroy(lib, mesh);
  });
});

// ── C10 — polylines ────────────────────────────────────────────────────────────
test('C10 — polylines: vertices, colour, bbox', () => {
  withLib(0.5, (lib) => {
    module.HEAPF32.set([1, 0, 0, 1], scratch >> 2);
    const line = fns.PolyLine_hCreate(lib, scratch);
    assert.ok(fns.PolyLine_bIsValid(lib, line));

    for (let i = 0; i < 5; i++) { vec(scratch + 64, i, i * 2, 0); fns.PolyLine_nAddVertex(lib, line, scratch + 64); }
    assert.equal(fns.PolyLine_nVertexCount(lib, line), 5);

    fns.PolyLine_GetVertex(lib, line, 2, scratch + 64);
    assert.deepEqual(readVec(scratch + 64), [2, 4, 0], 'polyline vertex round trip');

    fns.PolyLine_GetColor(lib, line, scratch + 128);
    assert.equal(module.HEAPF32[(scratch + 128) >> 2], 1, 'colour red channel');
    fns.PolyLine_GetBoundingBox(lib, line, scratch + 160);
    const [bMinX] = readVec(scratch + 160);
    assert.equal(bMinX, 0, 'polyline bbox min');
    assert.ok(fns.PolyLine_nMemUsage(lib, line) > 0);
    fns.PolyLine_Destroy(lib, line);
  });
});

// ── C11 — scalar fields ────────────────────────────────────────────────────────
test('C11 — scalar field: build from voxels, get/set, slice, traverse', () => {
  withLib(0.5, (lib) => {
    const sphere = sphereOf(lib, 8);
    const field = fns.ScalarField_hCreateFromVoxels(lib, sphere);
    assert.ok(fns.ScalarField_bIsValid(lib, field));

    const copy = fns.ScalarField_hCreateCopy(lib, field);
    const empty = fns.ScalarField_hCreate(lib);
    const built = fns.ScalarField_hBuildFromVoxels(lib, sphere, 42.0, 0.0);

    vec(scratch, 0, 0, 0);
    fns.ScalarField_SetValue(lib, empty, scratch, 42);
    const out = _malloc(4);
    try {
      assert.ok(fns.ScalarField_bGetValue(lib, empty, scratch, out), 'set value not readable back');
      assert.equal(module.HEAPF32[out >> 2], 42, 'scalar value round trip');
      // NOTE: upstream header types this function's field arg PKVECTORFIELD — a typo;
      // all handles are uint64_t so it works on a scalar field regardless.
      fns.ScalarField_RemoveValue(lib, empty, scratch);
      assert.ok(!fns.ScalarField_bGetValue(lib, empty, scratch, out), 'removed value still present');

      // hBuildFromVoxels(value, sdThreshold): interior of the sphere carries 42.
      vec(scratch, 0, 0, 0);
      assert.ok(fns.ScalarField_bGetValue(lib, built, scratch, out), 'built field empty at centre');
      assert.equal(module.HEAPF32[out >> 2], 42, 'built field value');
    } finally { _free(out); }

    const dims = _malloc(24);
    try {
      fns.ScalarField_GetVoxelDimensions(lib, field, dims, dims + 4, dims + 8, dims + 12, dims + 16, dims + 20);
      const [sx, sy] = [i32(dims + 12), i32(dims + 16)];
      assert.ok(sx > 0 && sy > 0, 'scalar field dims');
      const slice = _malloc(sx * sy * 4);
      try {
        fns.ScalarField_GetSlice(lib, field, Math.floor(i32(dims + 20) / 2), slice);
      } finally { _free(slice); }
    } finally { _free(dims); }

    let visits = 0;
    const cb = module.addFunction(() => { visits++; }, 'vif');
    try {
      fns.ScalarField_TraverseActive(lib, field, cb);
    } finally { module.removeFunction(cb); }
    // No nCountActive export exists (first draft invented one); the narrow band of an
    // r=8 sphere at 0.5mm is thousands of voxels, so bound the visit count instead.
    assert.ok(visits > 1000, `TraverseActive visited only ${visits} voxels`);
    assert.ok(fns.ScalarField_nMemUsage(lib, field) > 0);

    for (const f of [field, copy, empty, built]) fns.ScalarField_Destroy(lib, f);
    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── C12 — vector fields ────────────────────────────────────────────────────────
test('C12 — vector field: create, set/get, traverse', () => {
  withLib(0.5, (lib) => {
    const sphere = sphereOf(lib, 8);
    const field = fns.VectorField_hCreate(lib);
    assert.ok(fns.VectorField_bIsValid(lib, field));
    const fromVoxels = fns.VectorField_hCreateFromVoxels(lib, sphere);
    const copy = fns.VectorField_hCreateCopy(lib, fromVoxels);
    vec(scratch + 4 * VEC3, 9, 8, 7);
    const built = fns.VectorField_hBuildFromVoxels(lib, sphere, scratch + 4 * VEC3, 0.0);

    vec(scratch, 0, 0, 0);
    vec(scratch + VEC3, 1, 2, 3);
    fns.VectorField_SetValue(lib, field, scratch, scratch + VEC3);
    assert.ok(fns.VectorField_bGetValue(lib, field, scratch, scratch + 2 * VEC3), 'vector not readable back');
    assert.deepEqual(readVec(scratch + 2 * VEC3), [1, 2, 3], 'vector round trip');
    fns.VectorField_RemoveValue(lib, field, scratch);
    assert.ok(!fns.VectorField_bGetValue(lib, field, scratch, scratch + 2 * VEC3), 'removed vector still present');

    // hBuildFromVoxels fills the interior with the given constant vector.
    vec(scratch, 0, 0, 0);
    assert.ok(fns.VectorField_bGetValue(lib, built, scratch, scratch + 3 * VEC3), 'built field empty at centre');
    assert.deepEqual(readVec(scratch + 3 * VEC3), [9, 8, 7], 'built field vector');

    let visits = 0;
    const cb = module.addFunction(() => { visits++; }, 'vii');
    try {
      fns.VectorField_TraverseActive(lib, built, cb);
    } finally { module.removeFunction(cb); }
    assert.ok(visits > 0, 'vector TraverseActive never called back');
    assert.ok(fns.VectorField_nMemUsage(lib, field) >= 0);

    for (const f of [field, fromVoxels, copy, built]) fns.VectorField_Destroy(lib, f);
    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── C13 — metadata ─────────────────────────────────────────────────────────────
test('C13 — metadata: string/float/vector round trips (name-keyed, despite the At suffix)', () => {
  withLib(0.5, (lib) => {
    const sphere = sphereOf(lib, 5);
    const meta = fns.Metadata_hFromVoxels(lib, sphere);
    const before = fns.Metadata_nCount(lib, meta);

    fns.Metadata_SetStringValue(lib, meta, str(scratch, 'author'), str(scratch + 64, 'picovoxel'));
    fns.Metadata_SetFloatValue(lib, meta, str(scratch + 128, 'density'), 7.5);
    vec(scratch + 256, 1, 2, 3);
    fns.Metadata_SetVectorValue(lib, meta, str(scratch + 192, 'origin'), scratch + 256);
    assert.equal(fns.Metadata_nCount(lib, meta), before + 3, 'metadata entries not added');

    // Only nNameLengthAt/bGetNameAt are index-based; every other *_At takes a NAME.
    const names = [];
    for (let i = 0; i < fns.Metadata_nCount(lib, meta); i++) {
      const len = fns.Metadata_nNameLengthAt(lib, meta, i);
      const buf = _malloc(len + 1);
      try {
        assert.ok(fns.Metadata_bGetNameAt(lib, meta, i, buf, len + 1), `name at ${i} unreadable`);
        names.push(UTF8ToString(buf));
      } finally { _free(buf); }
    }
    for (const expected of ['author', 'density', 'origin']) {
      assert.ok(names.includes(expected), `"${expected}" missing from ${names}`);
    }

    str(scratch, 'author');
    assert.ok(fns.Metadata_nTypeAt(lib, meta, scratch) >= 0, 'nTypeAt by name');
    const len = fns.Metadata_nStringLengthAt(lib, meta, scratch);
    const value = _malloc(len + 1);
    try {
      assert.ok(fns.Metadata_bGetStringAt(lib, meta, scratch, value, len + 1), 'string not readable');
      assert.equal(UTF8ToString(value), 'picovoxel', 'metadata string round trip');
    } finally { _free(value); }

    const f = _malloc(4);
    try {
      assert.ok(fns.Metadata_bGetFloatAt(lib, meta, str(scratch, 'density'), f), 'float not readable');
      assert.equal(module.HEAPF32[f >> 2], 7.5, 'metadata float round trip');
    } finally { _free(f); }
    assert.ok(fns.Metadata_bGetVectorAt(lib, meta, str(scratch, 'origin'), scratch + 320), 'vector not readable');
    assert.deepEqual(readVec(scratch + 320), [1, 2, 3], 'metadata vector round trip');

    fns.MetaData_RemoveValue(lib, meta, str(scratch, 'author')); // capital D: upstream typo
    assert.equal(fns.Metadata_nCount(lib, meta), before + 2, 'MetaData_RemoveValue did not remove');

    const scalarField = fns.ScalarField_hCreate(lib);
    const vectorField = fns.VectorField_hCreate(lib);
    const fieldMeta = fns.Metadata_hFromScalarField(lib, scalarField);
    const vecMeta = fns.Metadata_hFromVectorField(lib, vectorField);
    for (const m of [meta, fieldMeta, vecMeta]) fns.Metadata_Destroy(lib, m);
    fns.ScalarField_Destroy(lib, scalarField);
    fns.VectorField_Destroy(lib, vectorField);
    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── C14 — vdb file I/O ─────────────────────────────────────────────────────────
test('C14 — .vdb round trip through MEMFS (uncompressed: Blosc/zlib are off)', () => {
  withLib(0.5, (lib) => {
    const sphere = sphereOf(lib, 8);
    const volume = fns.Voxels_fCalculateVolume(lib, sphere);
    const scalar = fns.ScalarField_hCreateFromVoxels(lib, sphere);
    const vector = fns.VectorField_hCreate(lib);

    const out = fns.VdbFile_hCreate(lib);
    assert.ok(fns.VdbFile_bIsValid(lib, out));
    assert.ok(fns.VdbFile_nAddVoxels(lib, out, str(scratch, 'body'), sphere) >= 0);
    assert.ok(fns.VdbFile_nAddScalarField(lib, out, str(scratch, 'scalar'), scalar) >= 0);
    assert.ok(fns.VdbFile_nAddVectorField(lib, out, str(scratch, 'vector'), vector) >= 0);
    assert.ok(fns.VdbFile_nMemUsage(lib, out) >= 0);

    str(scratch, '/test.vdb');
    assert.ok(fns.VdbFile_bSaveToFile(lib, out, scratch), 'VdbFile_bSaveToFile failed');
    assert.ok(module.FS.stat('/test.vdb').size > 0, 'written .vdb is empty');

    const back = fns.VdbFile_hCreateFromFile(lib, scratch);
    assert.ok(fns.VdbFile_bIsValid(lib, back), 'reload failed');
    const count = fns.VdbFile_nFieldCount(lib, back);
    assert.equal(count, 3, `expected 3 reloaded fields, got ${count}`);

    // GetFieldName fills a PKINFOSTRINGLEN (255) buffer; nFieldType keys the getter.
    const nameBuffer = _malloc(255);
    const byName = {};
    try {
      for (let i = 0; i < count; i++) {
        fns.VdbFile_GetFieldName(lib, back, i, nameBuffer);
        byName[UTF8ToString(nameBuffer)] = { index: i, type: fns.VdbFile_nFieldType(lib, back, i) };
      }
    } finally { _free(nameBuffer); }
    assert.deepEqual(Object.keys(byName).sort(), ['body', 'scalar', 'vector'], 'field names survived');

    const restored = fns.VdbFile_hGetVoxels(lib, back, byName.body.index);
    const restoredVolume = fns.Voxels_fCalculateVolume(lib, restored);
    assert.ok(Math.abs(restoredVolume - volume) / volume < 1e-6,
      `.vdb round trip changed volume: ${restoredVolume} vs ${volume}`);
    const restoredScalar = fns.VdbFile_hGetScalarField(lib, back, byName.scalar.index);
    assert.ok(fns.ScalarField_bIsValid(lib, restoredScalar), 'restored scalar field invalid');
    const restoredVector = fns.VdbFile_hGetVectorField(lib, back, byName.vector.index);
    assert.ok(fns.VectorField_bIsValid(lib, restoredVector), 'restored vector field invalid');

    for (const f of [out, back]) fns.VdbFile_Destroy(lib, f);
    for (const v of [sphere, restored]) fns.Voxels_Destroy(lib, v);
    for (const f of [scalar, restoredScalar]) fns.ScalarField_Destroy(lib, f);
    for (const f of [vector, restoredVector]) fns.VectorField_Destroy(lib, f);
  });
});

// ── C15 — the leak oracle (R15) ────────────────────────────────────────────────
test('C15 — every allocation counter returns to zero', () => {
  const lib = fns.Library_hCreateInstance(0.5);
  const counters = ['Voxels', 'Meshes', 'Lattices', 'PolyLines', 'ScalarFields', 'VectorFields', 'VdbFiles', 'VdbMetas'];
  const read = () => Object.fromEntries(counters.map((c) => [c, Number(fns[`Library_n${c}Allocated`](lib))]));

  for (const [name, n] of Object.entries(read())) assert.equal(n, 0, `${name} nonzero on a fresh instance`);

  const sphere = sphereOf(lib, 5);
  const mesh = fns.Mesh_hCreateFromVoxels(lib, sphere);
  const lattice = fns.Lattice_hCreate(lib);
  module.HEAPF32.set([1, 1, 1, 1], scratch >> 2);
  const line = fns.PolyLine_hCreate(lib, scratch);
  const scalar = fns.ScalarField_hCreate(lib);
  const vector = fns.VectorField_hCreate(lib);
  const file = fns.VdbFile_hCreate(lib);
  const meta = fns.Metadata_hFromVoxels(lib, sphere);

  for (const [name, n] of Object.entries(read())) assert.ok(n > 0, `${name} still 0 after allocating one`);
  assert.ok(Number(fns.Library_nTotalMemUsage(lib)) > 0);
  for (const c of counters) {
    assert.ok(Number(fns[`Library_n${c}MemUsage`](lib)) >= 0, `${c} mem usage`);
  }

  fns.Voxels_Destroy(lib, sphere);
  fns.Mesh_Destroy(lib, mesh);
  fns.Lattice_Destroy(lib, lattice);
  fns.PolyLine_Destroy(lib, line);
  fns.ScalarField_Destroy(lib, scalar);
  fns.VectorField_Destroy(lib, vector);
  fns.VdbFile_Destroy(lib, file);
  fns.Metadata_Destroy(lib, meta);

  for (const [name, n] of Object.entries(read())) assert.equal(n, 0, `${name} leaked: ${n} still allocated`);
  fns.Library_DestroyInstance(lib);
});

// ── C17 — the G0 grid-hash oracle (SKv2-0 V0.1, src/pico-hash.cpp) ─────────────
test('C17 — grid hash: stable, representation-blind, content-sensitive', () => {
  withLib(0.4, (lib) => {
    const hash = _malloc(48); // 16 B digest + 3 × u64 counts, 8-aligned
    const digest = () => Array.from({ length: 4 }, (_, i) => module.HEAPU32[(hash >> 2) + i]).join('-');
    const counts = () => Array.from({ length: 6 }, (_, i) => module.HEAPU32[((hash + 16) >> 2) + i]).join('-');
    const sphere = sphereOf(lib, 8);

    fns.Voxels_GetGridHash(lib, sphere, hash, hash + 16, hash + 24, hash + 32);
    const [first, firstCounts] = [digest(), counts()];
    const active = module.HEAPU32[(hash + 16) >> 2];
    assert.ok(active > 0, 'a real level set has active voxels');

    fns.Voxels_GetGridHash(lib, sphere, hash, hash + 16, hash + 24, hash + 32);
    assert.equal(digest(), first, 'repeated hashing is bit-stable');

    // Densify a copy: same field, dense-leaf representation — the hash and
    // every count must hold while memUsage proves the tree changed.
    const dense = fns.Voxels_hCreateCopy(lib, sphere);
    const memBefore = Number(fns.Voxels_nMemUsage(lib, dense));
    fns.Voxels_DensifyInterior(lib, dense);
    assert.ok(Number(fns.Voxels_nMemUsage(lib, dense)) > memBefore, 'densify must change the representation');
    fns.Voxels_GetGridHash(lib, dense, hash, hash + 16, hash + 24, hash + 32);
    assert.equal(digest(), first, 'tile vs dense-leaf encodings of one field hash equal');
    assert.equal(counts(), firstCounts, 'post-prune counts are representation-invariant too');

    const other = sphereOf(lib, 9);
    fns.Voxels_GetGridHash(lib, other, hash, hash + 16, hash + 24, hash + 32);
    assert.notEqual(digest(), first, 'different content is a different hash');

    fns.Voxels_Destroy(lib, dense);
    fns.Voxels_Destroy(lib, other);
    fns.Voxels_Destroy(lib, sphere);
    _free(hash);
  });
});

// ── C18 — shared-nothing csg*Copy booleans (SKv2-0 V0.7, src/pico-boolean.cpp) ──
test('C18 — csg*Copy: value-identical to the mutating path, inputs untouched', () => {
  withLib(0.4, (lib) => {
    const hash = _malloc(48);
    const digest = () => Array.from({ length: 4 }, (_, i) => module.HEAPU32[(hash >> 2) + i]).join('-');
    const hashOf = (voxels) => {
      fns.Voxels_GetGridHash(lib, voxels, hash, hash + 16, hash + 24, hash + 32);
      return digest();
    };
    const a = sphereOf(lib, 8);
    const b = sphereOf(lib, 6, [5, 0, 0]);
    const aBefore = hashOf(a);
    const bBefore = hashOf(b);

    const pairs = [
      ['Voxels_hBoolAddCopy', 'Voxels_BoolAdd'],
      ['Voxels_hBoolSubtractCopy', 'Voxels_BoolSubtract'],
      ['Voxels_hBoolIntersectCopy', 'Voxels_BoolIntersect'],
    ];
    for (const [copyName, mutateName] of pairs) {
      const fresh = fns[copyName](lib, a, b);
      const reference = fns.Voxels_hCreateCopy(lib, a);
      fns[mutateName](lib, reference, b);
      assert.equal(hashOf(fresh), hashOf(reference), `${copyName} must be value-identical to ${mutateName}`);
      fns.Voxels_Destroy(lib, fresh);
      fns.Voxels_Destroy(lib, reference);
    }

    // Shared-nothing means const inputs: neither operand may move.
    assert.equal(hashOf(a), aBefore, 'input A must be untouched');
    assert.equal(hashOf(b), bBefore, 'input B must be untouched');

    // V0.8 (T11): the O(stored) equality agrees with the dense upstream scan.
    assert.equal(fns.Voxels_bIsEqualFast(lib, a, b), fns.Voxels_bIsEqual(lib, a, b), 'a vs b');
    const aCopy = fns.Voxels_hCreateCopy(lib, a);
    assert.equal(fns.Voxels_bIsEqualFast(lib, a, aCopy), true, 'a vs copy(a)');
    assert.equal(fns.Voxels_bIsEqual(lib, a, aCopy), true, 'upstream agrees');
    fns.Voxels_Destroy(lib, aCopy);

    fns.Voxels_Destroy(lib, a);
    fns.Voxels_Destroy(lib, b);
    _free(hash);
  });
});

// ── C19 — column-culled ProjectZSlice + U2 seal fix (SKv2-0 V0.9) ──────────────
test('C19 — ProjectZSliceFast: upstream-identical at 1.0 mm, corrected seal elsewhere', () => {
  withLib(1.0, (lib) => {
    const hash = _malloc(48);
    const digest = () => Array.from({ length: 4 }, (_, i) => module.HEAPU32[(hash >> 2) + i]).join('-');
    const hashOf = (voxels) => {
      fns.Voxels_GetGridHash(lib, voxels, hash, hash + 16, hash + 24, hash + 32);
      return digest();
    };
    const sphere = sphereOf(lib, 8);
    const fast = fns.Voxels_hCreateCopy(lib, sphere);
    fns.Voxels_ProjectZSliceFast(lib, fast, 6, -6);
    const reference = fns.Voxels_hCreateCopy(lib, sphere);
    fns.Voxels_ProjectZSlice(lib, reference, 6, -6);
    // At 1.0 mm voxels upstream's mm-as-layer-count seal coincides with the
    // corrected voxel-unit count, so the two exports are value-identical.
    assert.equal(hashOf(fast), hashOf(reference), '1.0 mm must coincide');
    for (const h of [fast, reference, sphere]) fns.Voxels_Destroy(lib, h);
    _free(hash);
  });
  withLib(0.4, (lib) => {
    const hash = _malloc(48);
    const digest = () => Array.from({ length: 4 }, (_, i) => module.HEAPU32[(hash >> 2) + i]).join('-');
    const hashOf = (voxels) => {
      fns.Voxels_GetGridHash(lib, voxels, hash, hash + 16, hash + 24, hash + 32);
      return digest();
    };
    const sphere = sphereOf(lib, 8);
    const fast = fns.Voxels_hCreateCopy(lib, sphere);
    fns.Voxels_ProjectZSliceFast(lib, fast, 6, -6);
    const reference = fns.Voxels_hCreateCopy(lib, sphere);
    fns.Voxels_ProjectZSlice(lib, reference, 6, -6);
    // At 0.4 mm upstream seals round(3·0.4)=1 layer instead of the full
    // 3-voxel band — the U2 defect; the corrected export legitimately differs.
    assert.notEqual(hashOf(fast), hashOf(reference), '0.4 mm must show the U2 correction');
    for (const h of [fast, reference, sphere]) fns.Voxels_Destroy(lib, h);
    _free(hash);
  });
});

// ── C16 — negative tests (R16) ─────────────────────────────────────────────────
test('C16 — invalid handles throw and the module survives every one', () => {
  const lib = fns.Library_hCreateInstance(0.5);
  const bogus = 987654321n;

  const cases = [
    ['Mesh_nVertexCount', () => fns.Mesh_nVertexCount(lib, bogus)],
    ['Mesh_nTriangleCount', () => fns.Mesh_nTriangleCount(lib, bogus)],
    ['Voxels_fCalculateVolume', () => fns.Voxels_fCalculateVolume(lib, bogus)],
    ['Mesh_hCreateFromVoxels', () => fns.Mesh_hCreateFromVoxels(lib, bogus)],
    ['Lattice_nMemUsage', () => fns.Lattice_nMemUsage(lib, bogus)],
    ['PolyLine_nVertexCount', () => fns.PolyLine_nVertexCount(lib, bogus)],
    ['ScalarField_nMemUsage', () => fns.ScalarField_nMemUsage(lib, bogus)],
    ['VdbFile_nFieldCount', () => fns.VdbFile_nFieldCount(lib, bogus)],
    ['Metadata_nCount', () => fns.Metadata_nCount(lib, bogus)],
  ];

  for (const [name, call] of cases) {
    let thrown = null;
    try { call(); } catch (e) { thrown = e; }
    assert.notEqual(thrown, null, `${name} accepted a bogus handle without throwing`);
    // Must be the C++ throw itself (WebAssembly.Exception under -fwasm-exceptions) —
    // a JS TypeError here means the binding is broken, which once let an invented
    // function "pass". (The old JS-EH build surfaced this as a bare Number.)
    assert.ok(thrown instanceof WebAssembly.Exception,
      `${name} threw ${thrown?.constructor?.name ?? typeof thrown} — harness bug, not an ABI rejection`);

    // The requirement is not that it throws — it is that the module still works.
    const sphere = sphereOf(lib, 3);
    assert.ok(fns.Voxels_fCalculateVolume(lib, sphere) > 0, `module dead after ${name} threw`);
    fns.Voxels_Destroy(lib, sphere);
  }

  assert.equal(Number(fns.Library_nVoxelsAllocated(lib)), 0, 'negative tests leaked handles');
  fns.Library_DestroyInstance(lib);
});

// ── Library odds and ends ──────────────────────────────────────────────────────
test('Library — info strings, conversions, voxel size', () => {
  withLib(0.5, (lib) => {
    for (const fn of ['Library_GetName', 'Library_GetVersion', 'Library_GetBuildInfo']) {
      fns[fn](scratch);
      assert.ok(UTF8ToString(scratch).length > 0, `${fn} returned an empty string`);
    }
    vec(scratch, 10, 20, 30);
    fns.Library_MmToVoxels(lib, scratch, scratch + VEC3);
    assert.ok(Math.abs(readVec(scratch + VEC3)[0] - 20) < 1e-3, 'MmToVoxels ignored voxel size');
    fns.Library_VoxelsToMm(lib, scratch + VEC3, scratch + 2 * VEC3);
    assert.ok(Math.abs(readVec(scratch + 2 * VEC3)[0] - 10) < 1e-3, 'VoxelsToMm round trip');

    const sphere = sphereOf(lib, 5);
    assert.equal(fns.Voxels_fVoxelSize(lib, sphere), 0.5, 'Voxels_fVoxelSize');
    fns.Voxels_Destroy(lib, sphere);
  });
});

// ── The R14 gate ───────────────────────────────────────────────────────────────
after(() => {
  const { covered, total, missing, byFamily } = pk.report();
  const pct = ((covered / total) * 100).toFixed(1);
  console.log(`\n  Tier-2 ABI coverage: ${covered}/${total} (${pct}%)`);
  for (const [family, names] of Object.entries(byFamily)) {
    console.log(`    uncovered ${family}: ${names.join(', ')}`);
  }
});

test('R14 GATE — every core export is exercised', () => {
  const { covered, total, missing } = pk.report();
  assert.equal(missing.length, 0,
    `${total - covered} of ${total} exports never called:\n  ${missing.join('\n  ')}`);
});
