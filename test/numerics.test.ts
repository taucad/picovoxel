// R1 (real-world-subjects blueprint) — numerics foundation goldens vs .NET
// semantics: exact assertions where the algebra is exact (constants, integer
// inputs, dyadic angle multiples), 1e-12 for composed float64 round-trips
// (frame compose/inverse, slerp) — float64 error over a handful of ops is
// orders below that, so 1e-12 catches real semantic drift without flaking.
// Angle tie-to-even cases use exact-in-f64 multiples of TWO_PI (Math.PI's
// mantissa has 3 trailing zero bits, so 0.25/0.5/0.75/1.5 × TWO_PI are exact).

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PicoError } from '../src/errors.ts';
import {
  cylindrical,
  frame,
  type Frame,
  mat4,
  overhang,
  polar,
  quat,
  type Rad,
  rad,
  scalar,
  spherical,
  tolerances,
  TWO_PI,
  type Vec3,
  vec2,
  vec3,
} from '../src/numerics.ts';

const invalidArg = (error: unknown): boolean =>
  error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT';

function close(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected} (±${eps})`);
}

function closeVec(actual: readonly number[], expected: readonly number[], eps = 1e-12): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) close(actual[i]!, expected[i]!, eps);
}

// ---------------------------------------------------------------- comparison

test('scalar.almostEqual: exact, absolute-tolerance, relative-tolerance, and failing paths', () => {
  assert.ok(scalar.almostEqual(1, 1)); // exact equality short-circuit
  assert.ok(scalar.almostEqual(1, 1 + 1e-7)); // within absTol
  assert.ok(scalar.almostEqual(1e9, 1e9 + 100)); // 100 > absTol but within 1e9·relTol
  assert.ok(!scalar.almostEqual(1, 2));
});

test('scalar almostLessOrEqual / almostMoreOrEqual / almostZero', () => {
  assert.ok(scalar.almostLessOrEqual(1 + 1e-7, 1));
  assert.ok(!scalar.almostLessOrEqual(1.1, 1));
  assert.ok(scalar.almostMoreOrEqual(1 - 1e-7, 1));
  assert.ok(!scalar.almostMoreOrEqual(0.9, 1));
  assert.ok(scalar.almostZero(1e-9));
  assert.ok(!scalar.almostZero(1e-7));
  assert.equal(tolerances.defSquared, tolerances.def * tolerances.def);
  assert.equal(tolerances.zeroSquared, tolerances.zero * tolerances.zero);
});

// -------------------------------------------------------------------- vec2

test('vec2 algebra is exact on integer inputs', () => {
  assert.deepEqual(vec2.add([1, 2], [3, 4]), [4, 6]);
  assert.deepEqual(vec2.sub([1, 2], [3, 4]), [-2, -2]);
  assert.deepEqual(vec2.scale([1, 2], 3), [3, 6]);
  assert.equal(vec2.dot([1, 2], [3, 4]), 11);
  assert.equal(vec2.lengthSquared([3, 4]), 25);
  assert.equal(vec2.length([3, 4]), 5);
  assert.equal(vec2.distanceSquared([1, 1], [4, 5]), 25);
  assert.deepEqual(vec2.lerp([0, 0], [2, 4], 0.5), [1, 2]);
  assert.deepEqual(vec2.asVec3([1, 2]), [1, 2, 0]);
  assert.deepEqual(vec2.asVec3([1, 2], 7), [1, 2, 7]);
  assert.deepEqual(vec2.zero, [0, 0]);
});

test('vec2 normalization: throws on zero, safe variant returns zero', () => {
  assert.deepEqual(vec2.normalized([3, 4]), [0.6, 0.8]);
  assert.throws(() => vec2.normalized([0, 0]), invalidArg);
  assert.deepEqual(vec2.safeNormalized([0, 0]), [0, 0]);
  assert.deepEqual(vec2.safeNormalized([0, 2]), [0, 1]);
});

test('vec2 fuzzy comparisons and finiteness', () => {
  assert.ok(vec2.almostEqual([1, 1], [1, 1 + 1e-7]));
  assert.ok(!vec2.almostEqual([1, 1], [2, 2]));
  assert.ok(vec2.almostZero([1e-9, 1e-9]));
  assert.ok(!vec2.almostZero([1e-3, 0]));
  assert.ok(vec2.isFinite([1, 2]));
  assert.ok(!vec2.isFinite([Number.NaN, 0]));
  assert.ok(!vec2.isFinite([0, Number.POSITIVE_INFINITY]));
});

// -------------------------------------------------------------------- vec3

test('vec3 algebra is exact on integer inputs', () => {
  assert.deepEqual(vec3.add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(vec3.sub([1, 2, 3], [4, 5, 6]), [-3, -3, -3]);
  assert.deepEqual(vec3.neg([1, -2, 3]), [-1, 2, -3]);
  assert.deepEqual(vec3.scale([1, 2, 3], 2), [2, 4, 6]);
  assert.equal(vec3.dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(vec3.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.deepEqual(vec3.cross([0, 1, 0], [1, 0, 0]), [0, 0, -1]);
  assert.equal(vec3.lengthSquared([1, 2, 2]), 9);
  assert.equal(vec3.length([1, 2, 2]), 3);
  assert.equal(vec3.distanceSquared([1, 1, 1], [2, 3, 3]), 9);
  assert.equal(vec3.distance([1, 1, 1], [2, 3, 3]), 3);
  assert.deepEqual(vec3.lerp([0, 0, 0], [2, 4, 8], 0.25), [0.5, 1, 2]);
  assert.deepEqual(vec3.stripZ([1, 2, 3]), [1, 2]);
  assert.deepEqual(vec3.zero, [0, 0, 0]);
  assert.deepEqual(vec3.unitX, [1, 0, 0]);
  assert.deepEqual(vec3.unitY, [0, 1, 0]);
  assert.deepEqual(vec3.unitZ, [0, 0, 1]);
  assert.deepEqual(vec3.one, [1, 1, 1]);
});

test('vec3 normalization: throws on zero, safe variant returns zero', () => {
  assert.deepEqual(vec3.normalized([0, 3, 4]), [0, 0.6, 0.8]);
  assert.throws(() => vec3.normalized([0, 0, 0]), invalidArg);
  assert.deepEqual(vec3.safeNormalized([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(vec3.safeNormalized([0, 0, 5]), [0, 0, 1]);
});

test('vec3.transformed follows the row-vector convention (translation in 12–14)', () => {
  const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] as const;
  assert.deepEqual(vec3.transformed([1, 2, 3], translate), [11, 22, 33]);
  const scaleZ = mat4.createScale([1, 1, 2]);
  assert.deepEqual(vec3.transformed([1, 2, 3], scaleZ), [1, 2, 6]);
  assert.throws(() => vec3.transformed([1, 2, 3], [1, 2, 3]), invalidArg);
});

test('vec3.mirrored reflects across a plane; degenerate normal leaves the point alone', () => {
  assert.deepEqual(vec3.mirrored([1, 2, 3], [0, 0, 0], [0, 0, 1]), [1, 2, -3]);
  assert.deepEqual(vec3.mirrored([1, 2, 3], [0, 0, 1], [0, 0, 2]), [1, 2, -1]); // non-unit normal is normalized
  assert.deepEqual(vec3.mirrored([1, 2, 3], [0, 0, 0], [0, 0, 0]), [1, 2, 3]); // safe-normalized zero normal
});

test('vec3 fuzzy comparisons and finiteness', () => {
  assert.ok(vec3.almostEqual([1, 1, 1], [1, 1, 1 + 1e-7]));
  assert.ok(!vec3.almostEqual([1, 1, 1], [2, 2, 2]));
  assert.ok(vec3.almostZero([1e-9, 0, 1e-9]));
  assert.ok(!vec3.almostZero([1e-3, 0, 0]));
  assert.ok(vec3.isFinite([1, 2, 3]));
  assert.ok(!vec3.isFinite([Number.NaN, 0, 0]));
  assert.ok(!vec3.isFinite([0, Number.NaN, 0]));
  assert.ok(!vec3.isFinite([0, 0, Number.NaN]));
});

// --------------------------------------------------------------------- rad

test('rad constants and conversions match .NET', () => {
  assert.equal(TWO_PI, Math.PI * 2);
  assert.equal(rad.zero, 0);
  assert.equal(rad.full, TWO_PI);
  assert.equal(rad.half, Math.PI);
  assert.equal(rad.quarter, Math.PI / 2);
  close(rad.deg45, Math.PI / 4, 1e-15);
  assert.equal(rad.fromRad(1.25), 1.25);
  close(rad.fromDeg(90), Math.PI / 2, 1e-15);
  close(rad.deg(rad.fromDeg(123)), 123, 1e-12);
});

test('rad.fromNormalized clamps below 0 and above 1', () => {
  assert.equal(rad.fromNormalized(-0.5), rad.zero);
  assert.equal(rad.fromNormalized(1.5), rad.full);
  close(rad.fromNormalized(0.25), Math.PI / 2, 1e-15);
});

test('rad.normalizedSigned: IEEE-remainder semantics incl. tie-to-even at ±π', () => {
  // q = x/2π exactly 0.5 → tie, floor 0 (even) → stays +π (C# IEEERemainder).
  assert.equal(rad.normalizedSigned(rad.fromRad(Math.PI)), Math.PI);
  // q exactly -0.5 → tie, floor -1 (odd) → rounds to 0 → stays -π.
  assert.equal(rad.normalizedSigned(rad.fromRad(-Math.PI)), -Math.PI);
  // q exactly 1.5 → tie, floor 1 (odd) → rounds to 2 → 3π - 4π = -π.
  assert.equal(rad.normalizedSigned(rad.fromRad(1.5 * TWO_PI)), -Math.PI);
  // Non-tie fractions on both sides of 0.5.
  assert.equal(rad.normalizedSigned(rad.fromRad(0.75 * TWO_PI)), -0.25 * TWO_PI);
  assert.equal(rad.normalizedSigned(rad.fromRad(0.25 * TWO_PI)), 0.25 * TWO_PI);
  // Exact multiples of 2π collapse to the zero constant (C# returns Rad.Zero).
  assert.equal(rad.normalizedSigned(rad.fromRad(TWO_PI)), 0);
  assert.equal(rad.normalizedSigned(rad.zero), 0);
});

test('rad.normalizedPositive maps into [0, 2π)', () => {
  assert.equal(rad.normalizedPositive(rad.fromRad(-0.25 * TWO_PI)), 0.75 * TWO_PI);
  assert.equal(rad.normalizedPositive(rad.fromRad(TWO_PI)), 0);
  assert.equal(rad.normalizedPositive(rad.fromRad(-TWO_PI)), 0);
  assert.equal(rad.normalizedPositive(rad.fromRad(0.25 * TWO_PI)), 0.25 * TWO_PI);
});

test('rad fuzzy equality: plain and periodic', () => {
  assert.ok(rad.almostEqual(rad.fromRad(1), rad.fromRad(1 + 1e-7)));
  assert.ok(!rad.almostEqual(rad.zero, rad.full));
  assert.ok(rad.almostEqualPeriodic(rad.zero, rad.full)); // 0º == 360º
  assert.ok(rad.almostEqualPeriodic(rad.fromDeg(-180), rad.fromDeg(180)));
  assert.ok(!rad.almostEqualPeriodic(rad.zero, rad.half));
});

test('rad inverse trig: quadrant-correct atan2, clamped acos/asin', () => {
  close(rad.atan2(1, 1), Math.PI / 4, 1e-15);
  close(rad.atan2(1, -1), (3 * Math.PI) / 4, 1e-15);
  close(rad.atan(1), Math.PI / 4, 1e-15);
  close(rad.acos(0.5), Math.acos(0.5), 1e-15);
  assert.equal(rad.acosClamped(1.5), 0);
  assert.equal(rad.acosClamped(-2), Math.PI);
  close(rad.acosClamped(0.5), Math.acos(0.5), 1e-15);
  close(rad.asin(0.5), Math.asin(0.5), 1e-15);
  assert.equal(rad.asinClamped(2), Math.PI / 2);
  assert.equal(rad.asinClamped(-2), -Math.PI / 2);
  close(rad.asinClamped(0.5), Math.asin(0.5), 1e-15);
});

test('rad branded arithmetic mirrors the C# operators', () => {
  const a = rad.fromRad(1);
  const b = rad.fromRad(0.5);
  assert.equal(rad.add(a, b), 1.5);
  assert.equal(rad.sub(a, b), 0.5);
  assert.equal(rad.scale(a, 3), 3);
  assert.equal(rad.div(a, 4), 0.25);
  assert.equal(rad.ratio(a, b), 2);
  assert.equal(rad.neg(a), -1);
});

// ---------------------------------------------------------------- overhang

test('overhang factories: all five conventions agree on 45º', () => {
  const expected = 0.5;
  assert.equal(overhang.fromNormalized(0.5), expected);
  assert.equal(overhang.fromPercent(50), expected);
  assert.equal(overhang.fromRad(Math.PI / 4), expected);
  assert.equal(overhang.fromDeg(45), expected);
  assert.equal(overhang.fromDegFromHorizontal(45), expected);
  assert.equal(overhang.none, 0);
  assert.equal(overhang.full, 1);
  assert.equal(overhang.fromDegFromHorizontal(90), overhang.none);
  assert.equal(overhang.fromDegFromHorizontal(0), overhang.full);
});

test('overhang factories reject NaN, negative, and above-range inputs', () => {
  const cases: Array<[name: string, factory: (f: number) => unknown, above: number]> = [
    ['fromNormalized', (f) => overhang.fromNormalized(f), 1.01],
    ['fromPercent', (f) => overhang.fromPercent(f), 100.5],
    ['fromRad', (f) => overhang.fromRad(f), Math.PI / 2 + 0.01],
    ['fromDeg', (f) => overhang.fromDeg(f), 90.5],
    ['fromDegFromHorizontal', (f) => overhang.fromDegFromHorizontal(f), 91],
  ];
  for (const [name, factory, above] of cases) {
    assert.throws(() => factory(Number.NaN), invalidArg, `${name}(NaN)`);
    assert.throws(() => factory(-0.5), invalidArg, `${name}(-0.5)`);
    assert.throws(() => factory(above), invalidArg, `${name}(${above})`);
  }
});

test('overhang accessors: percent/rad/deg/degFromHorizontal', () => {
  const u = overhang.fromPercent(50);
  assert.equal(overhang.percent(u), 50);
  close(overhang.rad(u), Math.PI / 4, 1e-15);
  assert.equal(overhang.deg(u), 45);
  assert.equal(overhang.degFromHorizontal(u), 45);
  assert.ok(overhang.fromPercent(60) > u); // branded numbers compare natively (C# bExceeds)
});

// ------------------------------------------------------------- coordinates

test('polar: cartesian round-trip, origin collapse, validation', () => {
  const p = polar.fromCartesian([3, 4]);
  assert.equal(p.r, 5);
  close(p.phi, Math.atan2(4, 3), 1e-15);
  closeVec(polar.toCartesian(p), [3, 4], 1e-12);
  // Below fZero the azimuth is undefined → exact zeros (C# behaviour).
  assert.deepEqual(polar.fromCartesian([1e-9, 1e-9]), { r: 0, phi: rad.zero });
  assert.throws(() => polar.fromCartesian([Number.NaN, 0]), invalidArg);
  assert.throws(() => polar.create(-1, rad.zero), invalidArg);
  assert.throws(() => polar.create(Number.NaN, rad.zero), invalidArg);
  assert.throws(() => polar.create(1, rad.fromRad(Number.POSITIVE_INFINITY)), invalidArg);
});

test('polar.lerp interpolates the angle the short way around', () => {
  const a = polar.create(1, rad.fromRad(3)); // just below +π
  const b = polar.create(3, rad.fromRad(-3)); // just above -π
  const mid = polar.lerp(a, b, 0.5);
  assert.equal(mid.r, 2);
  close(mid.phi, 3 + 0.5 * (TWO_PI - 6), 1e-12); // crosses ±π, not through 0
});

test('cylindrical: constructors, conversions, round-trips, validation', () => {
  const c = cylindrical.create(2, rad.fromDeg(90), 5);
  closeVec(cylindrical.toCartesian(c), [0, 2, 5], 1e-12);
  const back = cylindrical.fromCartesian([0, 2, 5]);
  close(back.r, 2, 1e-12);
  close(back.phi, Math.PI / 2, 1e-12);
  assert.equal(back.z, 5);
  const fromP = cylindrical.fromPolar(polar.create(2, rad.fromDeg(90)), 5);
  assert.deepEqual(fromP, c);
  assert.throws(() => cylindrical.create(1, rad.zero, Number.NaN), invalidArg);
  assert.throws(() => cylindrical.create(-1, rad.zero, 0), invalidArg);
});

test('cylindrical.lerp lerps r, phi (short way) and z', () => {
  const a = cylindrical.create(1, rad.zero, 0);
  const b = cylindrical.create(3, rad.fromDeg(90), 10);
  const mid = cylindrical.lerp(a, b, 0.5);
  assert.equal(mid.r, 2);
  close(mid.phi, Math.PI / 4, 1e-12);
  assert.equal(mid.z, 5);
});

test('spherical: cartesian round-trip, origin collapse, theta validation', () => {
  const s = spherical.fromCartesian([0, 3, 0]);
  assert.equal(s.r, 3);
  close(s.phi, Math.PI / 2, 1e-15);
  close(s.theta, Math.PI / 2, 1e-15);
  closeVec(spherical.toCartesian(s), [0, 3, 0], 1e-12);
  const up = spherical.fromCartesian([0, 0, 5]);
  assert.equal(up.theta, 0);
  assert.deepEqual(spherical.fromCartesian([1e-9, 0, 0]), { r: 0, phi: rad.zero, theta: rad.zero });
  assert.throws(() => spherical.fromCartesian([Number.NaN, 0, 0]), invalidArg);
  assert.throws(() => spherical.create(1, rad.zero, rad.fromRad(-0.1)), invalidArg);
  assert.throws(() => spherical.create(1, rad.zero, rad.fromRad(3.2)), invalidArg);
  assert.throws(() => spherical.create(1, rad.zero, rad.fromRad(Number.NaN)), invalidArg);
});

test('spherical/cylindrical cross-conversions agree with cartesian', () => {
  const s = spherical.create(2, rad.fromDeg(30), rad.fromDeg(60));
  const viaCyl = cylindrical.fromSpherical(s);
  closeVec(cylindrical.toCartesian(viaCyl), spherical.toCartesian(s), 1e-12);
  const backToSpherical = spherical.fromCylindrical(viaCyl);
  close(backToSpherical.r, 2, 1e-12);
  close(backToSpherical.phi, s.phi, 1e-12);
  close(backToSpherical.theta, s.theta, 1e-12);
});

test('spherical.lerp lerps r, phi (short way) and theta', () => {
  const a = spherical.create(1, rad.zero, rad.zero);
  const b = spherical.create(3, rad.fromDeg(90), rad.fromDeg(90));
  const mid = spherical.lerp(a, b, 0.5);
  assert.equal(mid.r, 2);
  close(mid.phi, Math.PI / 4, 1e-12);
  close(mid.theta, Math.PI / 4, 1e-12);
});

// -------------------------------------------------------------------- quat

test('quat.fromAxisAngle + transform rotate vectors as .NET does', () => {
  const q = quat.fromAxisAngle(vec3.unitZ, rad.quarter);
  closeVec(q, [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)], 1e-15);
  closeVec(quat.transform(vec3.unitX, q), [0, 1, 0], 1e-15);
  closeVec(quat.transform(vec3.unitY, q), [-1, 0, 0], 1e-15);
  closeVec(quat.transform([1, 2, 3], quat.identity), [1, 2, 3], 1e-15);
});

test('quat.fromMat4: all four Shepperd branches (identity + the three 180º rotations)', () => {
  // trace > 0
  closeVec(quat.fromMat4(mat4.identity), [0, 0, 0, 1], 1e-15);
  // 180º about X → m11-dominant branch
  const aboutX: Frame = { pos: vec3.zero, lx: [1, 0, 0], ly: [0, -1, 0], lz: [0, 0, -1] };
  closeVec(frame.asRigid(aboutX).rotation, [1, 0, 0, 0], 1e-15);
  // 180º about Y → m22 > m33 branch
  const aboutY: Frame = { pos: vec3.zero, lx: [-1, 0, 0], ly: [0, 1, 0], lz: [0, 0, -1] };
  closeVec(frame.asRigid(aboutY).rotation, [0, 1, 0, 0], 1e-15);
  // 180º about Z → m33-dominant branch
  const aboutZ: Frame = { pos: vec3.zero, lx: [-1, 0, 0], ly: [0, -1, 0], lz: [0, 0, 1] };
  closeVec(frame.asRigid(aboutZ).rotation, [0, 0, 1, 0], 1e-15);
  assert.throws(() => quat.fromMat4([1, 0, 0]), invalidArg);
});

test('quat.slerp: near-parallel (with and without flip) and general arcs (with and without flip)', () => {
  const quarterTurn = quat.fromAxisAngle(vec3.unitZ, rad.quarter);
  const eighthTurn = quat.fromAxisAngle(vec3.unitZ, rad.fromRad(Math.PI / 4));
  // Near-parallel, no flip: q → q stays q.
  closeVec(quat.slerp(quat.identity, quat.identity, 0.5), quat.identity, 1e-15);
  // Near-parallel with flip: q and -q are the same rotation.
  closeVec(quat.slerp(quat.identity, quat.neg(quat.identity), 0.5), quat.identity, 1e-15);
  // General arc: halfway to a quarter turn is an eighth turn.
  closeVec(quat.slerp(quat.identity, quarterTurn, 0.5), eighthTurn, 1e-12);
  // General arc with flip: the negated target must give the same rotation.
  closeVec(quat.slerp(quat.identity, quat.neg(quarterTurn), 0.5), eighthTurn, 1e-12);
  assert.equal(quat.dot(quat.identity, quat.identity), 1);
  assert.deepEqual(quat.neg([1, -2, 3, -4]), [-1, 2, -3, 4]);
});

// -------------------------------------------------------------------- mat4

test('mat4: identity, scale, multiply (row-vector: a then b)', () => {
  assert.deepEqual(mat4.multiply(mat4.identity, mat4.identity), [...mat4.identity]);
  const scale = mat4.createScale([2, 3, 4]);
  const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] as const;
  // v·(scale·translate) = scale first, then translate.
  const combined = mat4.multiply(scale, translate);
  assert.deepEqual(vec3.transformed([1, 1, 1], combined), [12, 23, 34]);
  assert.throws(() => mat4.multiply([1, 2], translate), invalidArg);
  assert.throws(() => mat4.multiply(translate, [1, 2]), invalidArg);
});

// ------------------------------------------------------------------- frame

const skewFrame = frame.fromZX([1, 2, 3], [0.3, -0.4, 0.85], [1, 0.2, -0.1]);

test('frame.fromZX orthonormalizes skew input into a right-handed unit basis', () => {
  close(vec3.length(skewFrame.lx), 1, 1e-12);
  close(vec3.length(skewFrame.ly), 1, 1e-12);
  close(vec3.length(skewFrame.lz), 1, 1e-12);
  close(vec3.dot(skewFrame.lx, skewFrame.lz), 0, 1e-12);
  close(vec3.dot(skewFrame.lx, skewFrame.ly), 0, 1e-12);
  closeVec(vec3.cross(skewFrame.lz, skewFrame.lx), skewFrame.ly, 1e-12); // right-handed
  assert.deepEqual(frame.world, { pos: [0, 0, 0], lx: [1, 0, 0], ly: [0, 1, 0], lz: [0, 0, 1] });
  assert.deepEqual(frame.fromPos([1, 2, 3]).pos, [1, 2, 3]);
  assert.deepEqual(frame.fromPos([1, 2, 3]).lx, [1, 0, 0]);
});

test('frame point/direction transforms round-trip world↔local (2D and 3D overloads)', () => {
  const world = frame.ptToWorld(skewFrame, [0.5, -1, 2]);
  closeVec(frame.ptFromWorld(skewFrame, world), [0.5, -1, 2], 1e-12);
  // 2D overload lies in the frame's XY plane.
  closeVec(frame.ptToWorld(skewFrame, [0.5, -1]), frame.ptToWorld(skewFrame, [0.5, -1, 0]), 1e-15);
  const dir = frame.dirToWorld(skewFrame, [0, 0, 1]);
  closeVec(dir, skewFrame.lz, 1e-12);
  closeVec(frame.dirToWorld(skewFrame, [1, 0]), skewFrame.lx, 1e-12);
  closeVec(frame.dirFromWorld(skewFrame, skewFrame.ly), [0, 1, 0], 1e-12);
  // Directions are safe-normalized; the zero direction stays zero.
  assert.deepEqual(frame.dirToWorld(frame.world, [0, 0, 0]), [0, 0, 0]);
});

test('frame.compose ∘ frame.inverse is the identity', () => {
  const roundTrip = frame.compose(skewFrame, frame.inverse(skewFrame));
  closeVec(roundTrip.pos, [0, 0, 0], 1e-12);
  closeVec(roundTrip.lx, [1, 0, 0], 1e-12);
  closeVec(roundTrip.ly, [0, 1, 0], 1e-12);
  closeVec(roundTrip.lz, [0, 0, 1], 1e-12);
  // And inverse actually maps world → local.
  const pt: Vec3 = [4, -2, 7];
  closeVec(frame.ptToWorld(frame.inverse(skewFrame), pt), frame.ptFromWorld(skewFrame, pt), 1e-12);
});

test('frame moves: local axes vs world axes', () => {
  const f = frame.fromZX([0, 0, 0], [1, 0, 0], [0, 0, 1]); // local Z = world X
  closeVec(
    frame.movedLocal(f, [1, 2, 3]).pos,
    vec3.add(vec3.add(vec3.scale(f.lx, 1), vec3.scale(f.ly, 2)), vec3.scale(f.lz, 3)),
    1e-12,
  );
  closeVec(frame.movedLocalX(f, 2).pos, vec3.scale(f.lx, 2), 1e-12);
  closeVec(frame.movedLocalY(f, 2).pos, vec3.scale(f.ly, 2), 1e-12);
  closeVec(frame.movedLocalZ(f, 2).pos, [2, 0, 0], 1e-12); // along world X
  closeVec(frame.movedWorld(f, [1, 2, 3]).pos, [1, 2, 3], 1e-12);
  closeVec(frame.movedWorldX(f, 2).pos, [2, 0, 0], 1e-12);
  closeVec(frame.movedWorldY(f, 2).pos, [0, 2, 0], 1e-12);
  closeVec(frame.movedWorldZ(f, 2).pos, [0, 0, 2], 1e-12);
  closeVec(frame.repositioned(skewFrame, [9, 9, 9]).pos, [9, 9, 9], 1e-15);
  closeVec(frame.repositioned(skewFrame, [9, 9, 9]).lz, skewFrame.lz, 1e-12);
});

test('frame.rotatedWorld: quarter turn, ±π agreement, near-zero axis is a no-op', () => {
  const quarter = frame.rotatedWorld(frame.world, vec3.unitZ, rad.quarter);
  closeVec(quarter.lx, [0, 1, 0], 1e-15);
  closeVec(quarter.ly, [-1, 0, 0], 1e-15);
  const plus = frame.rotatedWorld(frame.world, vec3.unitZ, rad.half);
  const minus = frame.rotatedWorld(frame.world, vec3.unitZ, rad.neg(rad.half));
  closeVec(plus.lx, [-1, 0, 0], 1e-15);
  closeVec(minus.lx, [-1, 0, 0], 1e-15); // ±π land on the same frame
  // Degenerate axis: safeNormalize keeps it zero → rotation is a no-op (C# parity).
  assert.deepEqual(frame.rotatedWorld(frame.world, [0, 0, 0], rad.quarter), frame.world);
});

test('frame.toMat4 / fromMat4 / composeWithScale / asRigid', () => {
  const m = frame.toMat4(skewFrame);
  assert.equal(m.length, 16);
  const rebuilt = frame.fromMat4(m);
  closeVec(rebuilt.pos, skewFrame.pos, 1e-12);
  closeVec(rebuilt.lx, skewFrame.lx, 1e-12);
  closeVec(rebuilt.lz, skewFrame.lz, 1e-12);
  assert.throws(() => frame.fromMat4([1, 2, 3]), invalidArg);
  // matAsMatrix4x4 transforms points identically to ptToWorld.
  closeVec(vec3.transformed([0.5, -1, 2], m), frame.ptToWorld(skewFrame, [0.5, -1, 2]), 1e-12);
  // composeWithScale scales in local space first.
  const scaled = frame.composeWithScale(skewFrame, [2, 3, 4]);
  closeVec(vec3.transformed([1, 1, 1], scaled), frame.ptToWorld(skewFrame, [2, 3, 4]), 1e-12);
  // asRigid: quaternion + origin reproduce the frame's axes.
  const { rotation, origin } = frame.asRigid(skewFrame);
  assert.deepEqual(origin, skewFrame.pos);
  closeVec(quat.transform(vec3.unitX, rotation), skewFrame.lx, 1e-12);
  closeVec(quat.transform(vec3.unitZ, rotation), skewFrame.lz, 1e-12);
});

test('frame.interpolate: clamping, halfway rotation, and the hemisphere flip', () => {
  const b = frame.rotatedWorld(frame.repositioned(frame.world, [2, 0, 0]), vec3.unitZ, rad.quarter);
  assert.ok(frame.equals(frame.interpolate(frame.world, b, -1), frame.world)); // t clamped to 0
  const atOne = frame.interpolate(frame.world, b, 2); // t clamped to 1
  closeVec(atOne.pos, [2, 0, 0], 1e-12);
  closeVec(atOne.lx, [0, 1, 0], 1e-12);
  const mid = frame.interpolate(frame.world, b, 0.5);
  closeVec(mid.pos, [1, 0, 0], 1e-12);
  closeVec(mid.lx, [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0], 1e-12);
  // 240º about Z extracts with negative w → dot < 0 → hemisphere flip → the
  // interpolation takes the short way (backwards) to -60º at t = 0.5.
  const twoForty = frame.rotatedWorld(frame.world, vec3.unitZ, rad.fromDeg(240));
  const flipMid = frame.interpolate(frame.world, twoForty, 0.5);
  closeVec(flipMid.lx, [Math.cos(-Math.PI / 3), Math.sin(-Math.PI / 3), 0], 1e-12);
});

test('frame.equals: exact equality, sensitive to every component', () => {
  assert.ok(frame.equals(frame.world, { pos: [0, 0, 0], lx: [1, 0, 0], ly: [0, 1, 0], lz: [0, 0, 1] }));
  assert.ok(!frame.equals(frame.world, frame.fromPos([0, 0, 1])));
  assert.ok(!frame.equals(frame.world, { ...frame.world, lx: [0, 1, 0] }));
  assert.ok(!frame.equals(frame.world, { ...frame.world, ly: [1, 0, 0] }));
  assert.ok(!frame.equals(frame.world, { ...frame.world, lz: [0, 1, 0] }));
});

// A Rad annotation exercise: the branded type must reject a plain number at
// compile time — this line type-checks only because of the explicit factory.
const _typed: Rad = rad.fromDeg(30);
void _typed;
