// R12 — the offset design vocabulary (SG9): analytic offsets, bit-exact
// composition differentials (fillet ≙ its doubleOffset definition, smoothen ≙ raw
// TripleOffset), both shell forms with sign/swap semantics, trim, projectZSlice.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico, type Voxels } from '../src/index.ts';
import { hexFloat } from './helpers.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
});
afterAll(() => pk.dispose());

const sphereVolume = (radius: number) => (4 / 3) * Math.PI * radius ** 3;
const sphere = (radius: number) => pk.createVoxels({ shape: 'sphere', radius });

test('offset: analytic growth and shrink on a sphere', () => {
  const base = sphere(10);
  const grown = base.offset({ distance: 2 });
  const shrunk = base.offset({ distance: -2 });
  assert.ok(Math.abs(grown.volume - sphereVolume(12)) / sphereVolume(12) < 0.03, `grown ${grown.volume}`);
  assert.ok(Math.abs(shrunk.volume - sphereVolume(8)) / sphereVolume(8) < 0.03, `shrunk ${shrunk.volume}`);
});

test('doubleOffset(+d, −d) is morphological closing: ≈ identity on a convex body', () => {
  const base = sphere(10);
  const closed = base.doubleOffset({ first: 2, second: -2 });
  assert.ok(
    Math.abs(closed.volume - base.volume) / base.volume < 0.05,
    `closing changed a convex body: ${closed.volume}`,
  );
});

test('fillet ≙ its defining doubleOffset composition (bit-exact)', () => {
  const base = sphere(8).union(
    pk.createVoxels({ shape: 'beam', start: [0, 0, 0], end: [14, 0, 0], radius: 3 }),
  );
  // C# voxFillet(r) = voxOverOffset(r, 0) = DoubleOffset(r, −r + 0).
  const viaFillet = base.fillet({ rounding: 2 });
  const viaDouble = base.doubleOffset({ first: 2, second: -2 });
  assert.ok(viaFillet.equals(viaDouble), 'fillet must be exactly DoubleOffset(r, −r)');
  assert.equal(
    hexFloat(viaFillet.volume),
    hexFloat(viaDouble.volume),
    'hex-float volumes must match bit-for-bit',
  );

  // finalSurfaceDistance shifts the second offset: DoubleOffset(r, −r + f).
  const viaFilletFinal = base.fillet({ rounding: 2, finalSurfaceDistance: 1 });
  const viaDoubleFinal = base.doubleOffset({ first: 2, second: -1 });
  assert.ok(viaFilletFinal.equals(viaDoubleFinal));
});

test('smoothen ≙ raw Voxels_TripleOffset differential (bit-exact)', () => {
  const base = sphere(8).union(
    pk.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 }),
  );
  const smoothed = base.smoothen({ distance: 1 });

  // Raw path: copy the same source, run the export directly.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Emscripten module functions do not use this
  const { cwrap } = pk.module;
  const hCreateCopy = cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (
    l: bigint,
    v: bigint,
  ) => bigint;
  const tripleOffset = cwrap('Voxels_TripleOffset', null, ['bigint', 'bigint', 'number']) as (
    l: bigint,
    v: bigint,
    d: number,
  ) => void;
  const bIsEqual = cwrap('Voxels_bIsEqual', 'boolean', ['bigint', 'bigint', 'bigint']) as (
    l: bigint,
    a: bigint,
    b: bigint,
  ) => boolean;
  const fVolume = cwrap('Voxels_fCalculateVolume', 'number', ['bigint', 'bigint']) as (
    l: bigint,
    v: bigint,
  ) => number;
  const destroy = cwrap('Voxels_Destroy', null, ['bigint', 'bigint']) as (l: bigint, v: bigint) => void;

  const rawCopy = hCreateCopy(pk.handle, base.handle);
  tripleOffset(pk.handle, rawCopy, 1);
  assert.ok(bIsEqual(pk.handle, smoothed.handle, rawCopy), 'facade smoothen must be the raw TripleOffset');
  assert.equal(hexFloat(smoothed.volume), hexFloat(fVolume(pk.handle, rawCopy)));
  destroy(pk.handle, rawCopy);
});

test('shell({ offset: +d }): wall OUTSIDE — void has the original shape', () => {
  const base = sphere(10);
  const shell = base.shell({ offset: 2 });
  const expected = sphereVolume(12) - sphereVolume(10);
  assert.ok(Math.abs(shell.volume - expected) / expected < 0.06, `${shell.volume} vs ${expected}`);
  assert.equal(shell.isInside([0, 0, 0]), false, 'centre must be void');
  assert.equal(shell.isInside([11, 0, 0]), true, 'wall band must be solid');
});

test('shell({ offset: −d }): dimensions unchanged — void carved inside', () => {
  const base = sphere(10);
  const shell = base.shell({ offset: -2 });
  const expected = sphereVolume(10) - sphereVolume(8);
  assert.ok(Math.abs(shell.volume - expected) / expected < 0.06, `${shell.volume} vs ${expected}`);
  assert.equal(shell.isInside([0, 0, 0]), false, 'centre must be void');
  assert.equal(shell.isInside([9, 0, 0]), true, 'wall band must be solid');
  // Outer dimensions preserved: bounds match the original within a voxel.
  const originalBounds = base.bounds();
  const shellBounds = shell.bounds();
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(shellBounds.max[axis]! - originalBounds.max[axis]!) < 0.5);
  }
});

test('shell({ inner, outer }): wall between both offsets; reversed args swap (bit-exact)', () => {
  const base = sphere(10);
  const shell = base.shell({ inner: -2, outer: 2 });
  const expected = sphereVolume(12) - sphereVolume(8);
  assert.ok(Math.abs(shell.volume - expected) / expected < 0.06, `${shell.volume} vs ${expected}`);

  const reversed = base.shell({ inner: 2, outer: -2 });
  assert.ok(shell.equals(reversed), 'C# swaps reversed offsets — must be identical');
});

test('shell smoothInner actually smooths (upstream B4 discarded it — we port the intent)', () => {
  // A bumpy body: sphere with a rod, so the inner void has concave detail to strip.
  const base = sphere(8).union(
    pk.createVoxels({ shape: 'beam', start: [0, 0, 0], end: [11, 0, 0], radius: 2 }),
  );
  const plain = base.shell({ inner: -1.5, outer: 1.5 });
  const smoothed = base.shell({ inner: -1.5, outer: 1.5, smoothInner: 2 });
  assert.ok(!plain.equals(smoothed), 'smoothInner must change the result');
  assert.ok(smoothed.volume > 0);
});

test('trim: everything outside the box is gone', () => {
  const base = sphere(10);
  const trimmed = base.trim({ min: [0, 0, 0], max: [15, 15, 15] });
  const expected = sphereVolume(10) / 8; // one octant
  assert.ok(Math.abs(trimmed.volume - expected) / expected < 0.08, `${trimmed.volume} vs ${expected}`);
  const bounds = trimmed.bounds();
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(bounds.min[axis]! > -0.6, `trimmed bounds leaked below the box on axis ${axis}`);
  }
  assert.ok(base.volume > trimmed.volume * 7, 'source must be untouched (purity)');
});

test('projectZSlice: the start slice is stamped through to endZ', () => {
  const base = sphere(5);
  const projected = base.projectZSlice({ startZ: 0, endZ: 8 });
  // Behavioural invariants rather than an exact analytic — the native op also
  // stamps the narrow band, inflating a closed-form volume model.
  assert.equal(projected.isInside([0, 0, 6]), true, 'stamped column must be solid above the sphere');
  assert.equal(projected.isInside([0, 0, -4]), true, 'original lower body must survive');
  assert.equal(projected.isInside([6.5, 0, 6]), false, 'outside the stamped radius');
  assert.equal(projected.isInside([0, 0, 10.5]), false, 'beyond endZ (+band)');
  assert.ok(projected.volume > base.volume, 'projection must add material here');
  assert.equal(base.isInside([0, 0, 6]), false, 'source must be untouched (purity)');
});

// ── SK-0.8 — the fastRenorm opt-in ──
//
// Two things need pinning and they pull in opposite directions: the DEFAULT path must
// be the untuned upstream call bit-for-bit (the byte-locked example fixtures cover the
// whole-model case; this covers each entry point directly), and the OPT-IN must
// actually engage. A knob that silently no-ops would pass every accuracy gate.

/** The raw offset surface, straight off the module — same escape hatch the smoothen differential above uses. */
const rawOffsets = () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Emscripten module functions do not use this
  const { cwrap } = pk.module;
  return {
    copy: cwrap('Voxels_hCreateCopy', 'bigint', ['bigint', 'bigint']) as (l: bigint, v: bigint) => bigint,
    offset: cwrap('Voxels_Offset', null, ['bigint', 'bigint', 'number']) as (
      l: bigint,
      v: bigint,
      d: number,
    ) => void,
    double: cwrap('Voxels_DoubleOffset', null, ['bigint', 'bigint', 'number', 'number']) as (
      l: bigint,
      v: bigint,
      a: number,
      b: number,
    ) => void,
    triple: cwrap('Voxels_TripleOffset', null, ['bigint', 'bigint', 'number']) as (
      l: bigint,
      v: bigint,
      d: number,
    ) => void,
    tuned: cwrap('Voxels_OffsetTuned', null, [
      'bigint',
      'bigint',
      'number',
      'number',
      'number',
      'number',
    ]) as (l: bigint, v: bigint, p: number, n: number, scheme: number, count: number) => void,
    equal: cwrap('Voxels_bIsEqual', 'boolean', ['bigint', 'bigint', 'bigint']) as (
      l: bigint,
      a: bigint,
      b: bigint,
    ) => boolean,
    volume: cwrap('Voxels_fCalculateVolume', 'number', ['bigint', 'bigint']) as (
      l: bigint,
      v: bigint,
    ) => number,
    destroy: cwrap('Voxels_Destroy', null, ['bigint', 'bigint']) as (l: bigint, v: bigint) => void,
  };
};

const bumpyBody = () =>
  sphere(8).union(pk.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 }));

test('the default path is the untuned upstream call, bit-for-bit (all four entry points)', () => {
  const r = rawOffsets();
  const base = bumpyBody();
  const cases: [string, Voxels, (h: bigint) => void][] = [
    ['offset(+2)', base.offset({ distance: 2 }), (h) => r.offset(pk.handle, h, 2)],
    ['offset(-1)', base.offset({ distance: -1 }), (h) => r.offset(pk.handle, h, -1)],
    ['doubleOffset(2,-2)', base.doubleOffset({ first: 2, second: -2 }), (h) => r.double(pk.handle, h, 2, -2)],
    ['smoothen(1)', base.smoothen({ distance: 1 }), (h) => r.triple(pk.handle, h, 1)],
    ['fillet(2)', base.fillet({ rounding: 2 }), (h) => r.double(pk.handle, h, 2, -2)],
  ];
  for (const [label, facade, untuned] of cases) {
    const expected = r.copy(pk.handle, base.handle);
    untuned(expected);
    assert.ok(r.equal(pk.handle, facade.handle, expected), `${label} drifted from the untuned export`);
    assert.equal(hexFloat(facade.volume), hexFloat(r.volume(pk.handle, expected)), `${label} volume drifted`);
    r.destroy(pk.handle, expected);
    facade.dispose();
  }
});

test('Voxels_OffsetTuned with default settings IS the untuned export (bit-exact)', () => {
  // The whole opt-in rests on this: the new TU reproduces upstream exactly when asked
  // to, so the only thing fastRenorm changes is the renormalization scheme.
  const r = rawOffsets();
  const base = bumpyBody();
  const p = pk.module._malloc(16);
  const write = (ds: number[]) =>
    ds.forEach((d, i) => {
      pk.module.HEAPF32[(p >> 2) + i] = d;
    });
  const sequences: [string, number[], (h: bigint) => void][] = [
    ['Offset(+2)', [2], (h) => r.offset(pk.handle, h, 2)],
    ['Offset(-2)', [-2], (h) => r.offset(pk.handle, h, -2)],
    ['DoubleOffset(2,-2)', [2, -2], (h) => r.double(pk.handle, h, 2, -2)],
    ['TripleOffset(1)', [1, -2, 1], (h) => r.triple(pk.handle, h, 1)],
  ];
  for (const [label, distances, untuned] of sequences) {
    const a = r.copy(pk.handle, base.handle);
    untuned(a);
    for (const [scheme, count] of [
      [-1, -1],
      [4, 3],
    ]) {
      // "leave defaults" and "spell them out"
      const b = r.copy(pk.handle, base.handle);
      write(distances);
      r.tuned(pk.handle, b, p, distances.length, scheme!, count!);
      assert.ok(r.equal(pk.handle, a, b), `${label} @(${scheme},${count}) is not the untuned export`);
      assert.equal(
        hexFloat(r.volume(pk.handle, a)),
        hexFloat(r.volume(pk.handle, b)),
        `${label} @(${scheme},${count}) volume`,
      );
      r.destroy(pk.handle, b);
    }
    r.destroy(pk.handle, a);
  }
  pk.module._free(p);
});

test('fastRenorm engages, and stays inside the SK-0.8 accuracy gates', () => {
  // Gates (A/B data: bench/results/webgpu-v2/sk-0.8-ab.json): volume and area within 3% of the L0
  // output — the tolerance the analytic offset test at the top of this file already
  // uses — bounds within one voxel, and the non-negotiable one: openvdb's own
  // tools::checkLevelSet must still report a CLEAN field. That last gate is what
  // rejected every lower-sweep-count setting in the sweep, so it is the gate that
  // actually chose FIRST_BIAS-at-three-sweeps over the faster candidates.
  const voxel = 0.4;
  const diagnose = (v: Voxels): string => {
    const bDiagnose = pk.module.cwrap('Voxels_bDiagnose', 'boolean', ['bigint', 'bigint', 'number']) as (
      l: bigint,
      h: bigint,
      p: number,
    ) => boolean;
    const p = pk.module._malloc(255);
    try {
      bDiagnose(pk.handle, v.handle, p);
      return pk.module.UTF8ToString(p);
    } finally {
      pk.module._free(p);
    }
  };

  const base = bumpyBody();
  const cases: [string, (fast: boolean) => Voxels][] = [
    ['offset', (fast) => base.offset({ distance: 2, fastRenorm: fast })],
    ['doubleOffset', (fast) => base.doubleOffset({ first: 2, second: -2, fastRenorm: fast })],
    ['smoothen', (fast) => base.smoothen({ distance: 1, fastRenorm: fast })],
    ['fillet', (fast) => base.fillet({ rounding: 2, fastRenorm: fast })],
    ['shell', (fast) => base.shell({ inner: -1, outer: 1, fastRenorm: fast })],
  ];
  for (const [label, run] of cases) {
    const slow = run(false);
    const fast = run(true);
    assert.ok(!slow.equals(fast), `${label}: fastRenorm did not change the result — the knob is a no-op`);

    const a = slow.properties();
    const b = fast.properties();
    assert.ok(Math.abs(b.volume - a.volume) / a.volume < 0.03, `${label} volume ${b.volume} vs ${a.volume}`);
    assert.ok(Math.abs(b.area - a.area) / a.area < 0.03, `${label} area ${b.area} vs ${a.area}`);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(
        Math.abs(b.bounds.min[axis]! - a.bounds.min[axis]!) < voxel,
        `${label} bounds min drifted past a voxel on axis ${axis}`,
      );
      assert.ok(
        Math.abs(b.bounds.max[axis]! - a.bounds.max[axis]!) < voxel,
        `${label} bounds max drifted past a voxel on axis ${axis}`,
      );
    }
    assert.equal(diagnose(fast), '', `${label}: fastRenorm left the level set unhealthy`);
    slow.dispose();
    fast.dispose();
  }
});

// ── SKv2-0 V0.4 — the session-level fastRenorm default ──
//
// §14.1 precedence: explicit per-op > session default > library default (false).
// Cross-session comparisons ride the G0 grid hash — canonical content identity
// is comparable across sessions where handle equality is not.
test('session fastRenorm default engages the whole family, and per-op values win both ways', async () => {
  const fastPk = await createPico({ voxelSize: 0.4, fastRenorm: true });
  try {
    const body = (p: Pico) =>
      p
        .createVoxels({ shape: 'sphere', radius: 8 })
        .union(p.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 }));
    const base = body(pk);
    const fastBase = body(fastPk);
    const cases: [string, (v: Voxels, o: { fastRenorm?: boolean }) => Voxels][] = [
      ['offset', (v, o) => v.offset({ distance: 2, ...o })],
      ['doubleOffset', (v, o) => v.doubleOffset({ first: 2, second: -2, ...o })],
      ['smoothen', (v, o) => v.smoothen({ distance: 1, ...o })],
      ['fillet', (v, o) => v.fillet({ rounding: 2, ...o })],
      ['shell', (v, o) => v.shell({ inner: -1, outer: 1, ...o })],
    ];
    for (const [label, run] of cases) {
      // The session default reproduces the per-op opt-in exactly…
      const viaSession = run(fastBase, {});
      const viaExplicit = run(base, { fastRenorm: true });
      assert.equal(
        viaSession.gridHash().hash,
        viaExplicit.gridHash().hash,
        `${label}: session default ≠ per-op opt-in`,
      );
      // …an explicit true inside the fast session is honoured (and redundant)…
      const viaBoth = run(fastBase, { fastRenorm: true });
      assert.equal(
        viaBoth.gridHash().hash,
        viaSession.gridHash().hash,
        `${label}: explicit true inside the fast session drifted`,
      );
      // …and an explicit false restores the byte-locked upstream path exactly.
      const viaOptOut = run(fastBase, { fastRenorm: false });
      const viaDefault = run(base, {});
      assert.equal(
        viaOptOut.gridHash().hash,
        viaDefault.gridHash().hash,
        `${label}: per-op false did not restore the L0 path`,
      );
      assert.notEqual(
        viaSession.gridHash().hash,
        viaDefault.gridHash().hash,
        `${label}: the session default was a no-op`,
      );
      for (const v of [viaSession, viaExplicit, viaBoth, viaOptOut, viaDefault]) v.dispose();
    }
    base.dispose();
    fastBase.dispose();
  } finally {
    fastPk.dispose();
  }
});
