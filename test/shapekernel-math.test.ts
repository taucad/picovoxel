// R4 (real-world-subjects blueprint) — ShapeKernel math-core goldens. Closed
// forms are exact-in-tolerance: trig identities for vecOps, BSpline endpoint
// clamping, arc-length invariants for splineOps, and frame-transport
// properties for Frames (MIN_ROTATION must not corkscrew). Tolerances: 1e-12
// for plain float64 algebra; 1e-3 where upstream's brute-force 0.01°-step
// alignment search bounds the achievable accuracy.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PicoError } from '../src/errors.ts';
import { frame } from '../src/numerics/frame.ts';
import { vec3 } from '../src/numerics/vector.ts';
import {
  ControlPointSpline,
  createRandom,
  CylindricalControlSpline,
  Frames,
  localFrame,
  splineOps,
  TangentialControlSpline,
  uf,
  vecOps,
} from '../src/shapekernel.ts';
import { createPico } from '../src/index.ts';
import type { Vec3 } from '../src/types.ts';

const invalidArg = (error: unknown): boolean =>
  error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT';

function close(actual: number, expected: number, eps = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected} (±${eps})`);
}

function closeVec(actual: readonly number[], expected: readonly number[], eps = 1e-12): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) close(actual[i]!, expected[i]!, eps);
}

// ------------------------------------------------------------------ vecOps

test('vecOps: cylindrical/spherical points and coordinate accessors', () => {
  closeVec(vecOps.cylPoint(2, Math.PI / 2, 5), [0, 2, 5], 1e-12);
  // sphPoint measures theta from the XY plane (upstream convention).
  closeVec(vecOps.sphPoint(2, 0, Math.PI / 2), [0, 0, 2], 1e-12);
  closeVec(vecOps.sphPoint(2, Math.PI / 2, 0), [0, 2, 0], 1e-12);
  assert.equal(vecOps.radius([3, 4, 7]), 5);
  close(vecOps.phi([0, 2, 0]), Math.PI / 2, 1e-15);
  close(vecOps.theta([0, 3, 3]), Math.PI / 4, 1e-15);
});

test('vecOps: set/update keep the other cylindrical coordinates fixed', () => {
  const pt: Vec3 = [3, 4, 7];
  closeVec(vecOps.setRadius(pt, 10), [6, 8, 7], 1e-12);
  close(vecOps.radius(vecOps.setPhi(pt, 0)), 5, 1e-12);
  closeVec(vecOps.setPhi(pt, 0), [5, 0, 7], 1e-12);
  closeVec(vecOps.setZ(pt, 1), [3, 4, 1], 1e-12);
  close(vecOps.radius(vecOps.updateRadius(pt, 5)), 10, 1e-12);
  close(vecOps.phi(vecOps.updatePhi(pt, 0.5)), vecOps.phi(pt) + 0.5, 1e-12);
  closeVec(vecOps.updateZ(pt, -2), [3, 4, 5], 1e-12);
  closeVec(vecOps.planarDir([3, 4, 9]), [0.6, 0.8, 0], 1e-12);
});

test('vecOps: alignment flips and checks', () => {
  assert.deepEqual(vecOps.flipForAlignment([1, 0, 0], [1, 1, 0]), [1, 0, 0]);
  assert.deepEqual(vecOps.flipForAlignment([-1, 0, 0], [1, 1, 0]), [1, -0, -0]);
  assert.ok(vecOps.checkAlignment([1, 0, 0], [1, 1, 0]));
  assert.ok(!vecOps.checkAlignment([-1, 0, 0], [1, 1, 0]));
});

test('vecOps: rotations about Z and arbitrary axes, with and without origins', () => {
  closeVec(vecOps.rotateAroundZ([1, 0, 5], Math.PI / 2), [0, 1, 5], 1e-12);
  closeVec(vecOps.rotateAroundZ([2, 0, 0], Math.PI, [1, 0, 0]), [0, 0, 0], 1e-12);
  closeVec(vecOps.rotateAroundAxis([1, 0, 0], Math.PI / 2, [0, 0, 1]), [0, 1, 0], 1e-15);
  closeVec(vecOps.rotateAroundAxis([2, 0, 0], Math.PI, [0, 0, 1], [1, 0, 0]), [0, 0, 0], 1e-12);
});

test('vecOps.orthogonalDir: both fallback branches, always orthogonal unit', () => {
  const forZ = vecOps.orthogonalDir([0, 0, 1]); // not parallel to unitX → cross with unitX
  close(vec3.dot(forZ, [0, 0, 1]), 0, 1e-12);
  close(vec3.length(forZ), 1, 1e-12);
  const forX = vecOps.orthogonalDir([1, 0, 0]); // |dot unitX| > 0.95 → falls to unitY
  close(vec3.dot(forX, [1, 0, 0]), 0, 1e-12);
  close(vec3.length(forX), 1, 1e-12);
});

test('vecOps.angleBetween and signedAngleBetween', () => {
  close(vecOps.angleBetween([1, 0, 0], [0, 1, 0]), Math.PI / 2, 1e-12);
  close(vecOps.angleBetween([1, 0, 0], [-1, 0, 0]), Math.PI, 1e-6);
  close(vecOps.angleBetween([1, 0, 0], [2, 0, 0]), 0, 1e-6);
  // Upstream's sign convention: the returned angle rotates B onto A about the
  // reference normal — so (X, Y, Z) is -π/2 (Y rotates backwards onto X).
  close(vecOps.signedAngleBetween([1, 0, 0], [0, 1, 0], [0, 0, 1]), -Math.PI / 2, 1e-6);
  close(vecOps.signedAngleBetween([0, 1, 0], [1, 0, 0], [0, 0, 1]), Math.PI / 2, 1e-6);
  assert.throws(() => vecOps.signedAngleBetween([0, 0, 0], [1, 0, 0], [0, 0, 1]), invalidArg);
  assert.throws(() => vecOps.signedAngleBetween([1, 0, 0], [0, 0, 0], [0, 0, 1]), invalidArg);
  assert.throws(() => vecOps.signedAngleBetween([1, 0, 0], [0, 1, 0], [0, 0, 0]), invalidArg);
});

test('vecOps: frame-axis queries on a shifted frame', () => {
  const f = localFrame.create([1, 2, 3]);
  closeVec(vecOps.directionToAxis(f, [4, 2, 9]), [1, 0, 0], 1e-12);
  close(vecOps.radiusToAxis(f, [4, 6, 9]), 5, 1e-12);
  close(vecOps.phiToAxis(f, [1, 4, 9]), Math.PI / 2, 1e-12);
});

test('vecOps: cylindrical and spherical interpolation take the short way', () => {
  const a: Vec3 = [2, 0, 0];
  const b: Vec3 = [0, 2, 4];
  const mid = vecOps.cylindricalInterpolation(a, b, 0.5);
  close(vecOps.radius(mid), 2, 1e-6);
  close(vecOps.phi(mid), Math.PI / 4, 1e-6);
  close(mid[2], 2, 1e-6);
  // Opposite winding: from (0,2) to (2,0) must rotate negatively.
  const back = vecOps.cylindricalInterpolation([0, 2, 0], [2, 0, 0], 0.5);
  close(vecOps.phi(back), Math.PI / 4, 1e-6);

  const sphMid = vecOps.sphericalInterpolation([2, 0, 0], [0, 2, 0], 0.5);
  close(vec3.length(sphMid), 2, 1e-6);
  close(vecOps.phi(sphMid), Math.PI / 4, 1e-6);
  const sphBack = vecOps.sphericalInterpolation([0, 2, 0], [2, 0, 0], 0.5);
  close(vecOps.phi(sphBack), Math.PI / 4, 1e-6);

  // Displaced axis origin: the relative winding (which orients the normal)
  // disagrees with the global-origin winding the sense probe measures, so the
  // negative-sense branch is taken. Tolerance 1e-3: upstream passes the
  // UNNORMALIZED cross product as the rotation axis, and a non-unit axis-angle
  // quaternion scales the rotated vector slightly — ported faithfully.
  const displaced = vecOps.sphericalInterpolation([8, 1, 0], [8, -1, 0], 0.5, [10, 0, 0]);
  close(vec3.length(vec3.sub(displaced, [10, 0, 0])), Math.sqrt(5), 1e-3);
});

// -------------------------------------------------------------- localFrame

test('localFrame: constructors, validation, and the no-Gram-Schmidt semantics', () => {
  assert.ok(frame.equals(localFrame.identity, frame.world));
  assert.deepEqual(localFrame.create([1, 2, 3]).pos, [1, 2, 3]);
  const based = localFrame.at(localFrame.createZ([0, 0, 0], [1, 0, 0]), [9, 9, 9]);
  assert.deepEqual(based.pos, [9, 9, 9]);
  closeVec(based.lz, [1, 0, 0], 1e-12);

  const zOnly = localFrame.createZ([0, 0, 0], [0, 0, 2]);
  close(vec3.length(zOnly.lx), 1, 1e-12);
  close(vec3.dot(zOnly.lx, zOnly.lz), 0, 1e-12);

  const zx = localFrame.createZX([0, 0, 0], [0, 0, 1], [2, 0, 0]);
  closeVec(zx.lx, [1, 0, 0], 1e-12);
  closeVec(zx.ly, [0, 1, 0], 1e-12);

  // Upstream keeps a skew X (no re-orthogonalization) — Y = Z×X regardless.
  const skew = localFrame.createZX([0, 0, 0], [0, 0, 1], vec3.normalized([1, 0, 1]));
  close(vec3.dot(skew.lx, skew.lz), Math.SQRT1_2, 1e-12);

  assert.throws(() => localFrame.createZ([0, 0, 0], [0, 0, 0]), invalidArg);
  assert.throws(() => localFrame.createZX([0, 0, 0], [0, 0, 0], [1, 0, 0]), invalidArg);
  assert.throws(() => localFrame.createZX([0, 0, 0], [0, 0, 1], [0, 0, 0]), invalidArg);
});

test('localFrame: translated, rotated, inverted', () => {
  const f = localFrame.createZX([1, 0, 0], [0, 0, 1], [1, 0, 0]);
  assert.deepEqual(localFrame.translated(f, [0, 5, 0]).pos, [1, 5, 0]);
  const rotated = localFrame.rotated(f, Math.PI / 2, [0, 0, 1]);
  closeVec(rotated.lx, [0, 1, 0], 1e-12);
  closeVec(rotated.lz, [0, 0, 1], 1e-12);
  const mirroredZ = localFrame.inverted(f, true, false);
  closeVec(mirroredZ.lz, [0, 0, -1], 1e-12);
  closeVec(mirroredZ.lx, [1, 0, 0], 1e-12);
  const mirroredX = localFrame.inverted(f, false, true);
  closeVec(mirroredX.lx, [-1, 0, 0], 1e-12);
  const unchanged = localFrame.inverted(f, false, false);
  assert.ok(frame.equals(unchanged, f));
  assert.deepEqual(localFrame.localY([0, 0, 1], [1, 0, 0]), [0, 1, 0]);
});

// ----------------------------------------------------------------- splines

test('ControlPointSpline: open endpoints clamp to the control endpoints', () => {
  const control: Vec3[] = [
    [0, 0, 0],
    [1, 0, 2],
    [3, 0, 2],
    [4, 0, 0],
  ];
  const spline = new ControlPointSpline(control);
  const points = spline.points(21);
  assert.equal(points.length, 21);
  closeVec(points[0]!, control[0]!, 1e-6);
  closeVec(points[20]!, control[3]!, 1e-6);
  // Interior points stay inside the control polygon's bounds.
  for (const pt of points) {
    assert.ok(pt[0] >= -1e-9 && pt[0] <= 4 + 1e-9);
    assert.ok(pt[2] >= -1e-9 && pt[2] <= 2 + 1e-9);
  }
});

test('ControlPointSpline: closed splines wrap the control points continuously', () => {
  const square: Vec3[] = [
    [1, 1, 0],
    [-1, 1, 0],
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
  ]; // duplicate end
  const spline = new ControlPointSpline(square, 2, 'closed');
  const points = spline.points(41);
  assert.equal(points.length, 41);
  // The 0..1 parameter range walks the wrapped control polygon: every sample
  // stays inside the polygon's bounds and the curve is continuous. (Upstream's
  // closed parametrization does NOT return to its start point at t=1.)
  for (const pt of points) {
    assert.ok(Math.abs(pt[0]) <= 1 + 1e-9 && Math.abs(pt[1]) <= 1 + 1e-9, `inside bounds: ${pt.join(',')}`);
  }
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(vec3.length(vec3.sub(points[i]!, points[i - 1]!)) < 0.5, `continuous at ${i}`);
  }
  // The caller's array is NOT mutated (deliberate deviation from C#).
  assert.equal(square.length, 5);
  // Non-coincident endpoints skip the duplicate-removal branch.
  const openEnds = new ControlPointSpline(
    [
      [1, 1, 0],
      [-1, 1, 0],
      [-1, -1, 0],
      [1, -1, 0],
    ],
    2,
    'closed',
  );
  assert.equal(openEnds.points(11).length, 11);
});

test('TangentialControlSpline: endpoints and tangent directions', () => {
  const spline = new TangentialControlSpline([0, 0, 0], [10, 0, 0], [0, 0, 1], [0, 0, -1]);
  const points = spline.points(101);
  closeVec(points[0]!, [0, 0, 0], 1e-6);
  closeVec(points[100]!, [10, 0, 0], 1e-6);
  const startTangent = vec3.safeNormalized(vec3.sub(points[1]!, points[0]!));
  assert.ok(vec3.dot(startTangent, [0, 0, 1]) > 0.9, 'leaves along startDir');

  // Explicit + relative strengths exercise the option branches.
  const custom = new TangentialControlSpline([0, 0, 0], [10, 0, 0], [0, 0, 1], [0, 0, -1], {
    startTangentStrength: 0.5,
    endTangentStrength: 0.2,
    relativeStartStrength: true,
    relativeEndStrength: true,
  });
  closeVec(custom.points(11)[0]!, [0, 0, 0], 1e-6);

  const between = TangentialControlSpline.betweenFrames(
    localFrame.createZX([0, 0, 0], [0, 0, 1], [1, 0, 0]),
    localFrame.createZX([0, 0, 10], [0, 0, 1], [1, 0, 0]),
  );
  const betweenPoints = between.points(11);
  closeVec(betweenPoints[0]!, [0, 0, 0], 1e-6);
  closeVec(betweenPoints[10]!, [0, 0, 10], 1e-6);
});

test('CylindricalControlSpline: relative and absolute steps in all directions', () => {
  const spline = new CylindricalControlSpline([2, 0, 0]);
  spline.addRelativeStep('z', 5);
  spline.addRelativeStep('radial', 1);
  spline.addRelativeStep('tangential', 1);
  spline.addAbsoluteStep('z', 10);
  spline.addAbsoluteStep('radial', 4);
  const points = spline.points(50);
  assert.equal(points.length, 50);
  closeVec(points[0]!, [2, 0, 0], 1e-6);
  const last = points[49]!;
  close(vecOps.radius(last), 4, 1e-6);
  close(last[2], 10, 1e-6);
});

// --------------------------------------------------------------- splineOps

const unitSquarePath: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

test('splineOps: lengths, spacing, interpolation and resampling invariants', () => {
  assert.deepEqual(splineOps.lengthsAtIndices(unitSquarePath), [0, 1, 2, 3]);
  assert.equal(splineOps.totalLength(unitSquarePath), 3);
  assert.equal(splineOps.averagePointSpacing(unitSquarePath), 1);

  const line = splineOps.linearInterpolation([0, 0, 0], [10, 0, 0], 11);
  assert.equal(line.length, 11);
  assert.deepEqual(line[5], [5, 0, 0]);

  const resampled = splineOps.reparametrizedByCount(unitSquarePath, 6);
  assert.equal(resampled.length, 7); // first + 5 interior + last (upstream count)
  assert.deepEqual(resampled[0], unitSquarePath[0]);
  assert.deepEqual(resampled[6], unitSquarePath[3]);
  close(splineOps.totalLength(resampled), 3, 1e-6);

  const bySpacing = splineOps.reparametrizedBySpacing(unitSquarePath, 0.25);
  assert.equal(bySpacing.length, 13); // 3 / 0.25 = 12 samples → 13 points
  const shortList = splineOps.reparametrizedBySpacing(
    [
      [0, 0, 0],
      [0, 0, 1],
    ],
    10,
  );
  assert.equal(shortList.length, 11); // min-10-samples branch
});

test('splineOps: list surgery — split, combine, transforms, sampling', () => {
  const [head, tail] = splineOps.splitAt(unitSquarePath, 2);
  assert.equal(head.length, 2);
  assert.equal(tail.length, 2);
  assert.deepEqual(splineOps.combine([head, tail]), unitSquarePath);

  closeVec(splineOps.rotatedAroundZ([[1, 0, 0]], Math.PI / 2)[0]!, [0, 1, 0], 1e-12);
  assert.deepEqual(splineOps.translated([[1, 0, 0]], [0, 0, 5]), [[1, 0, 5]]);
  assert.deepEqual(splineOps.scaled([[1, 2, 3]], 2), [[2, 4, 6]]);
  closeVec(splineOps.rotatedAroundAxis([[1, 0, 0]], Math.PI / 2, [0, 0, 1])[0]!, [0, 1, 0], 1e-12);

  const over = splineOps.overSampled(
    [
      [0, 0, 0],
      [1, 0, 0],
    ],
    4,
  );
  assert.equal(over.length, 5);
  assert.deepEqual(over[1], [0.25, 0, 0]);
  const sub = splineOps.subSampled(splineOps.linearInterpolation([0, 0, 0], [1, 0, 0], 9), 4);
  assert.deepEqual(sub, [
    [0, 0, 0],
    [0.5, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
  ]); // upstream repeats the end

  const nurbs = splineOps.nurbsSpline(unitSquarePath, 20);
  assert.equal(nurbs.length, 20);
  closeVec(nurbs[0]!, unitSquarePath[0]!, 1e-6);
  closeVec(nurbs[19]!, unitSquarePath[3]!, 1e-6);
});

test('splineOps: frame transforms round-trip; averages, closest points, clustering', () => {
  const f = localFrame.createZX([1, 2, 3], [1, 0, 0], [0, 0, 1]);
  const onto = splineOps.ontoFrame(f, unitSquarePath);
  const back = splineOps.inFrame(f, onto);
  for (let i = 0; i < unitSquarePath.length; i += 1) closeVec(back[i]!, unitSquarePath[i]!, 1e-12);

  assert.deepEqual(
    splineOps.average([
      [0, 0, 0],
      [2, 4, 6],
    ]),
    [1, 2, 3],
  );
  assert.deepEqual(splineOps.closestPoint(unitSquarePath, [0.9, 0.1, 0]), [1, 0, 0]);
  close(splineOps.distanceToClosestPoint(unitSquarePath, [1, 0, 1]), 1, 1e-12);

  const clustered = splineOps.clusteredPoints(
    [
      [0, 0, 0],
      [0.1, 0, 0],
      [5, 0, 0],
      [5.05, 0, 0],
    ],
    1,
  );
  assert.deepEqual(clustered, [
    [0, 0, 0],
    [5, 0, 0],
  ]);
});

test('splineOps.snappedSpline: points land on the surface; empty targets give zeros', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
    const snapped = splineOps.snappedSpline(
      [
        [20, 0, 0],
        [0, 30, 0],
      ],
      sphere,
    );
    for (const pt of snapped) close(vec3.length(pt), 10, 0.75); // within ~1.5 voxels of the surface
    // C# ignores the failure flag and keeps the zero vector — mirrored via ?? zero.
    const empty = pk.createVoxels({ shape: 'empty' });
    assert.deepEqual(splineOps.snappedSpline([[1, 2, 3]], empty), [[0, 0, 0]]);
  } finally {
    pk.dispose();
  }
});

// ------------------------------------------------------------------ Frames

test('Frames.alongLine / alongSpline: const frame extruded, sampling clamps', () => {
  const base = localFrame.createZX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const frames = Frames.alongLine(5, base);
  closeVec(frames.spineAt(0), [0, 0, 0], 1e-6);
  closeVec(frames.spineAt(1), [0, 0, 5], 1e-6);
  closeVec(frames.spineAt(-1), [0, 0, 0], 1e-6); // clamped low
  closeVec(frames.spineAt(2), [0, 0, 5], 1e-6); // clamped high
  closeVec(frames.localXAt(0.5), [1, 0, 0], 1e-12);
  closeVec(frames.localYAt(0.5), [0, 1, 0], 1e-12);
  closeVec(frames.localZAt(0.5), [0, 0, 1], 1e-12);
  const mid = frames.frameAt(0.5);
  closeVec(mid.pos, [0, 0, 2.5], 1e-6);
  assert.ok(frames.points().length >= 10);
  assert.equal(frames.points(4).length, 5); // reparametrized count+1 (upstream)

  const alongSpline = Frames.alongSpline(
    [
      [0, 0, 0],
      [10, 0, 0],
    ],
    base,
    1,
  );
  closeVec(alongSpline.spineAt(1), [10, 0, 0], 1e-6);
  closeVec(alongSpline.localZAt(0.3), [0, 0, 1], 1e-12); // frame stays const, not tangent
});

test('Frames.withTargetX: tangential Z, X pulled to the target', () => {
  const frames = Frames.withTargetX(
    [
      [0, 0, 0],
      [0, 0, 8],
    ],
    [1, 0, 0],
    1,
  );
  const f = frames.frameAt(0.5);
  assert.ok(vec3.dot(f.lz, [0, 0, 1]) > 0.99, `lz ${f.lz.join(',')} tangential`);
  assert.ok(Math.abs(vec3.dot(f.lx, [1, 0, 0])) > 0.999, `lx ${f.lx.join(',')} on target`);
});

test('Frames.ofType: z / cylindrical / spherical targets', () => {
  const zFrames = Frames.ofType(
    [
      [0, 0, 0],
      [8, 0, 0],
    ],
    'z',
    1,
  ); // spine along X → Z targets unitZ
  const zf = zFrames.frameAt(0.5);
  assert.ok(vec3.dot(zf.lz, [1, 0, 0]) > 0.99);
  assert.ok(Math.abs(vec3.dot(zf.lx, [0, 0, 1])) > 0.999);

  // A vertical spine off-axis: cylindrical X points radially outward (±).
  const cylFrames = Frames.ofType(
    [
      [5, 0, 0],
      [5, 0, 8],
    ],
    'cylindrical',
    1,
  );
  const cf = cylFrames.frameAt(0.5);
  assert.ok(Math.abs(vec3.dot(cf.lx, [1, 0, 0])) > 0.999, `cyl lx ${cf.lx.join(',')}`);

  // alignWithTargetX can only choose IN-PLANE (⊥ lz) directions: for a
  // vertical spine the spherical target [0.7, 0, 0.7] projects to ±X.
  const sphFrames = Frames.ofType(
    [
      [5, 0, 5],
      [5, 0, 13],
    ],
    'spherical',
    1,
  );
  const sf = sphFrames.frameAt(0.1);
  assert.ok(Math.abs(vec3.dot(sf.lx, [1, 0, 0])) > 0.999, `sph lx ${sf.lx.join(',')}`);
});

test('Frames minRotation: parallel transport does not corkscrew along a helix', () => {
  const helix: Vec3[] = [];
  for (let i = 0; i <= 40; i += 1) {
    const t = (i / 40) * Math.PI; // half a turn
    helix.push([5 * Math.cos(t), 5 * Math.sin(t), 2 * t]);
  }
  const frames = Frames.ofType(helix, 'minRotation', 1);
  let previous = frames.localXAt(0);
  for (let s = 0.05; s <= 1; s += 0.05) {
    const current = frames.localXAt(s);
    assert.ok(
      vec3.dot(vec3.safeNormalized(previous), vec3.safeNormalized(current)) > 0.98,
      `no twist jump at s=${s}`,
    );
    previous = current;
  }
});

test('Frames.applyToFrame moves spine and axes onto the frame', () => {
  const base = localFrame.createZX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const frames = Frames.alongLine(4, base);
  frames.applyToFrame(localFrame.create([10, 0, 0]));
  closeVec(frames.spineAt(0), [10, 0, 0], 1e-6);
  closeVec(frames.spineAt(1), [10, 0, 4], 1e-6);
});

test('Frames statics: alignWithTargetX and targetXFor', () => {
  const aligned = Frames.alignWithTargetX([0, 0, 1], [1, 0, 0]);
  assert.ok(vec3.dot(aligned, [1, 0, 0]) > 0.999);
  closeVec(Frames.targetXFor([3, 4, 7], 'cylindrical'), [0.6, 0.8, 0], 1e-12);
  closeVec(Frames.targetXFor([0, 0, 5], 'spherical'), [0, 0, 1], 1e-12);
  assert.deepEqual(Frames.targetXFor([1, 2, 3], 'z'), [0, 0, 1]);
});

// ---------------------------------------------------------------------- uf

test('uf transitions: fixed BSpline ease and tanh smooth', () => {
  close(uf.transFixed(2, 10, 0), 2, 1e-6);
  close(uf.transFixed(2, 10, 1), 10, 1e-6);
  const mid = uf.transFixed(2, 10, 0.5);
  assert.ok(mid > 2 && mid < 10);
  closeVec(uf.vecTransFixed([0, 0, 0], [1, 2, 3], 1), [1, 2, 3], 1e-6);
  close(uf.transSmooth(0, 1, -100, 0, 1), 0, 1e-6);
  close(uf.transSmooth(0, 1, 100, 0, 1), 1, 1e-6);
  close(uf.transSmooth(0, 1, 0, 0, 1), 0.5, 1e-12);
  closeVec(uf.vecTransSmooth([0, 0, 0], [2, 2, 2], 0, 0, 1), [1, 1, 1], 1e-12);
});

test('uf randomness: reproducible streams, sane distributions, default source', () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.notDeepEqual(seqA, [createRandom(43)(), createRandom(43)(), createRandom(43)()]);

  const rng = createRandom(7);
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i += 1) sum += uf.randomGaussian(5, 2, rng);
  close(sum / n, 5, 0.2);

  let seenTrue = false;
  let seenFalse = false;
  for (let i = 0; i < 100; i += 1) {
    const v = uf.randomLinear(3, 4, rng);
    assert.ok(v >= 3 && v < 4);
    if (uf.randomBool(rng)) seenTrue = true;
    else seenFalse = true;
  }
  assert.ok(seenTrue && seenFalse);

  // Default (non-reproducible) source branches.
  assert.ok(uf.randomLinear(0, 1) >= 0);
  assert.ok(Number.isFinite(uf.randomGaussian(0, 1)));
  assert.equal(typeof uf.randomBool(), 'boolean');
});

test('uf fibonacci distributions', () => {
  const disc = uf.fibonacciCirclePoints(3, 50);
  assert.equal(disc.length, 50);
  for (const pt of disc) {
    assert.ok(vecOps.radius(pt) <= 3 + 1e-9);
    assert.equal(pt[2], 0);
  }
  const sphere = uf.fibonacciSpherePoints(2, 50);
  for (const pt of sphere) close(vec3.length(pt), 2, 1e-9);
});

test('uf supershape and polygon radii', () => {
  assert.equal(uf.superShapeRadiusPreset(0.7, 'round'), 1);
  close(uf.superShapeRadiusPreset(0.7, 'hex'), uf.superShapeRadius(0.7, 6, 2, 1.2, 1.2), 1e-15);
  close(uf.superShapeRadiusPreset(0.7, 'quad'), uf.superShapeRadius(0.7, 4, 20, 15, 15), 1e-15);
  close(uf.superShapeRadiusPreset(0.7, 'tri'), uf.superShapeRadius(0.7, 3, 3, 4, 4), 1e-15);
  close(uf.superShapeRadius(0, 6, 2, 1.2, 1.2), 1, 1e-12); // touches the unit circle at phi=0

  close(uf.polygonRadius(0, 6), 1, 1e-12); // vertex on the unit circle
  close(uf.polygonRadius(Math.PI / 6, 6), Math.cos(Math.PI / 6), 1e-12); // edge midpoint
  close(uf.polygonRadiusPreset(0.5, 'hex'), uf.polygonRadius(0.5, 6), 1e-15);
  close(uf.polygonRadiusPreset(0.5, 'quad'), uf.polygonRadius(0.5, 4), 1e-15);
  close(uf.polygonRadiusPreset(0.5, 'tri'), uf.polygonRadius(0.5, 3), 1e-15);
});
