// R5 (real-world-subjects blueprint) — base-shape oracles: every shape's
// voxelized volume/bounds against its closed form (2% tolerance: tessellation
// chord error at the step counts used is <0.1%, voxelization surface error at
// 0.5 mm dominates), exact triangle-count pins for the tessellation loops,
// STL byte determinism, and the setTransformation seam. Step counts are
// reduced from the C# defaults for suite speed — the ratios formulas are
// step-count-independent.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPicoGK, type PicoGK } from '../src/index.ts';
import { vec3 } from '../src/numerics/vector.ts';
import {
  BaseBox,
  BaseCone,
  BaseCylinder,
  BaseLens,
  BasePipe,
  BasePipeSegment,
  BaseRevolve,
  BaseRing,
  BaseSphere,
  Distribution,
  Frames,
  GenericContour,
  LineModulation,
  localFrame,
  meshUtility,
  SurfaceModulation,
} from '../src/shapekernel.ts';
import type { Vec3 } from '../src/types.ts';

let pk: PicoGK;
beforeAll(async () => {
  pk = await createPicoGK({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

function closeRel(actual: number, expected: number, rel = 0.02): void {
  assert.ok(
    Math.abs(actual - expected) / Math.abs(expected) <= rel,
    `expected ${actual} within ${rel * 100}% of ${expected}`,
  );
}

function closeAbs(actual: number, expected: number, abs: number): void {
  assert.ok(Math.abs(actual - expected) <= abs, `expected ${actual} ≈ ${expected} (±${abs})`);
}

const zUp = localFrame.createZX([0, 0, 0], [0, 0, 1], [1, 0, 0]);

// ------------------------------------------------------------- modulations

test('LineModulation: const, function, points, algebra', () => {
  const constant = new LineModulation(7);
  assert.equal(constant.constValue, 7);
  assert.equal(constant.modulation(0.3), 7);
  const fn = new LineModulation((r) => 2 * r);
  assert.equal(fn.modulation(0.5), 1);
  assert.equal(fn.add(constant).modulation(0.5), 8);
  assert.equal(fn.sub(constant).modulation(0.5), -6);
  assert.equal(fn.scale(3).modulation(0.5), 3);

  // Points: non-ascending x dropped; ends pinned flat; clamped queries.
  const points = LineModulation.fromPoints(
    [
      [0.2, 0, 5],
      [0.1, 0, 99], // x not ascending — dropped
      [0.6, 0, 9],
    ],
    'z',
    'x',
  );
  assert.equal(points.modulation(0), 5); // start pinned to first y
  assert.equal(points.modulation(0.2), 5);
  closeAbs(points.modulation(0.4), 7, 1e-9); // midpoint of 5→9
  assert.equal(points.modulation(0.6), 9);
  assert.equal(points.modulation(1), 9); // end pinned flat
  assert.equal(points.modulation(2), 9); // clamped above
  assert.equal(points.modulation(-1), 5); // clamped below

  // y-axis/x-values variant covers the other coordinate branches.
  const yz = LineModulation.fromPoints(
    [
      [0, 3, 0],
      [0, 4, 1],
    ],
    'y',
    'z',
  );
  closeAbs(yz.modulation(0.5), 3.5, 1e-9);

  const dist = new Distribution(10, constant);
  assert.equal(dist.totalLength, 10);
  assert.equal(dist.modulation.modulation(0), 7);
  assert.ok(new GenericContour(5, constant) instanceof Distribution);
});

test('SurfaceModulation: const, function, from-line (both lines), algebra', () => {
  const constant = new SurfaceModulation(4);
  assert.equal(constant.modulation(1, 0.5), 4);
  const fn = new SurfaceModulation((phi, lr) => phi + lr);
  assert.equal(fn.modulation(2, 0.25), 2.25);
  const line = new LineModulation((r) => 10 * r);
  assert.equal(SurfaceModulation.fromLineModulation(line).modulation(99, 0.5), 5); // second (default)
  assert.equal(SurfaceModulation.fromLineModulation(line, 'first').modulation(0.5, 99), 5);
  assert.equal(fn.add(constant).modulation(1, 1), 6);
  assert.equal(fn.sub(constant).modulation(1, 1), -2);
  assert.equal(fn.scale(2).modulation(1, 1), 4);
});

// ------------------------------------------------------------ BaseCylinder

test('BaseCylinder: closed-form volume/bounds, exact tessellation counts, both ctors', () => {
  const cylinder = new BaseCylinder(zUp, 20, 10);
  cylinder.setPolarSteps(90);
  cylinder.setRadialSteps(5);
  const mesh = cylinder.mshConstruct(pk);
  // (polar-1)(radial-1)*2 per disc + (polar-1)(length-1)*2 mantle.
  assert.equal(mesh.triangleCount, 89 * 4 * 2 * 3);
  const { volume, bounds } = cylinder.voxConstruct(pk).properties();
  closeRel(volume, Math.PI * 100 * 20);
  closeAbs(bounds.min[2], 0, 0.75);
  closeAbs(bounds.max[2], 20, 0.75);
  closeAbs(bounds.max[0], 10, 0.75);

  // Surface point: mid-length, phi=0, full radius → +X at z=10.
  const surface = cylinder.surfacePoint(0.5, 0, 1);
  closeAbs(surface[0], 10, 1e-6);
  closeAbs(surface[2], 10, 1e-6);

  // Spine ctor (default radius 10) — straight spine along Z, same volume.
  const frames = Frames.alongLine(20, zUp);
  const spineCylinder = new BaseCylinder(frames);
  spineCylinder.setPolarSteps(90);
  spineCylinder.setLengthSteps(5);
  closeRel(spineCylinder.voxConstruct(pk).properties().volume, Math.PI * 100 * 20);

  // Defaults branch: BaseCylinder(frame) → L=20, r=10.
  const defaulted = new BaseCylinder(zUp);
  defaulted.setPolarSteps(45);
  closeRel(defaulted.voxConstruct(pk).properties().volume, Math.PI * 100 * 20);

  // Modulated radius (SetRadius bumps length steps): linear taper = cone band.
  const tapered = new BaseCylinder(zUp, 20, 10);
  tapered.setRadius(new SurfaceModulation((_phi, lr) => 10 - 5 * Math.min(1, Math.max(0, lr))));
  tapered.setLengthSteps(20);
  tapered.setPolarSteps(90);
  // Conical frustum: π·h/3 · (R² + R·r + r²) with R=10, r=5.
  closeRel(tapered.voxConstruct(pk).properties().volume, ((Math.PI * 20) / 3) * (100 + 50 + 25));
});

test('BaseCone: frustum-free cone volume; transformation passes through', () => {
  const cone = new BaseCone(zUp, 20, 10, 0);
  cone.baseCylinder().setPolarSteps(90);
  cone.baseCylinder().setLengthSteps(20);
  closeRel(cone.voxConstruct(pk).properties().volume, (Math.PI * 100 * 20) / 3);

  const shifted = new BaseCone(zUp, 20, 10, 0);
  shifted.baseCylinder().setPolarSteps(45);
  shifted.baseCylinder().setLengthSteps(10);
  shifted.setTransformation((pt) => vec3.add(pt, [100, 0, 0]));
  const { bounds } = shifted.voxConstruct(pk).properties();
  closeAbs(bounds.min[0], 90, 0.75);
});

// -------------------------------------------------------------- BaseSphere

test('BaseSphere: closed-form volume/bounds; modulated radius branch', () => {
  const sphere = new BaseSphere(zUp, 10);
  sphere.setAzimuthalSteps(90);
  sphere.setPolarSteps(45);
  const { volume, bounds } = sphere.voxConstruct(pk).properties();
  closeRel(volume, (4 / 3) * Math.PI * 1000);
  closeAbs(bounds.min[0], -10, 0.75);
  closeAbs(bounds.max[2], 10, 0.75);

  // Default radius branch + modulated radius (scaled by theta → smaller).
  const modulated = new BaseSphere(zUp);
  modulated.setAzimuthalSteps(90);
  modulated.setPolarSteps(45);
  modulated.setRadius(new SurfaceModulation(() => 5));
  closeRel(modulated.voxConstruct(pk).properties().volume, (4 / 3) * Math.PI * 125);
});

// ----------------------------------------------------------------- BaseBox

test('BaseBox: cube volume, fromBounds round-trip, modulated width/depth', () => {
  const box = new BaseBox(zUp, 20, 20, 20);
  const { volume, bounds } = box.voxConstruct(pk).properties();
  closeRel(volume, 8000);
  closeAbs(bounds.min[0], -10, 0.75);
  closeAbs(bounds.min[2], 0, 0.75);
  closeAbs(bounds.max[2], 20, 0.75);

  const rebuilt = BaseBox.fromBounds(bounds);
  closeRel(rebuilt.voxConstruct(pk).properties().volume, 8000, 0.05);

  // Defaults branches: (frame) and (Frames) ctors.
  closeRel(new BaseBox(zUp).voxConstruct(pk).properties().volume, 8000);
  const frames = Frames.alongLine(20, zUp);
  const spineBox = new BaseBox(frames, 10, 10);
  spineBox.setLengthSteps(5);
  closeRel(spineBox.voxConstruct(pk).properties().volume, 10 * 10 * 20);
  closeRel(new BaseBox(frames).voxConstruct(pk).properties().volume, 8000, 0.05);

  // Modulated width: linear 10→20 → average cross-section 15×20.
  const tapered = new BaseBox(zUp, 20, 20, 20);
  tapered.setWidth(new LineModulation((lr) => 10 + 10 * lr));
  tapered.setDepth(new LineModulation(20));
  tapered.setWidthSteps(10);
  tapered.setDepthSteps(5);
  tapered.setLengthSteps(20);
  closeRel(tapered.voxConstruct(pk).properties().volume, 15 * 20 * 20);
});

// ---------------------------------------------------------------- BasePipe

test('BasePipe + BasePipeSegment: annulus volumes; both segment methods agree', () => {
  const pipe = new BasePipe(zUp, 20, 5, 10);
  pipe.setPolarSteps(90);
  pipe.setRadialSteps(5);
  closeRel(pipe.voxConstruct(pk).properties().volume, Math.PI * (100 - 25) * 20);

  // Modulated radii (SetRadius bumps length sampling; overridden for speed).
  const modulated = new BasePipe(zUp, 20, 5, 10);
  modulated.setRadius(new SurfaceModulation(5), new SurfaceModulation(10));
  modulated.setLengthSteps(5);
  modulated.setPolarSteps(45);
  closeRel(modulated.voxConstruct(pk).properties().volume, Math.PI * 75 * 20);

  // Spine + defaults branches.
  const frames = Frames.alongLine(20, zUp);
  const spinePipe = new BasePipe(frames, 5, 10);
  spinePipe.setPolarSteps(90);
  spinePipe.setLengthSteps(5);
  closeRel(spinePipe.voxConstruct(pk).properties().volume, Math.PI * 75 * 20);
  closeRel(new BasePipe(zUp).voxConstruct(pk).properties().volume, Math.PI * (400 - 100) * 20, 0.03);
  closeRel(new BasePipe(frames).voxConstruct(pk).properties().volume, Math.PI * 300 * 20, 0.03);

  // Half-pipe both ways: MID_RANGE(mid 0, range π) ≡ START_END(-π/2, +π/2).
  const halfVolume = (Math.PI * 75 * 20) / 2;
  // Frame form without length exercises the C# default (20).
  const midRange = new BasePipeSegment(zUp, {
    innerRadius: 5,
    outerRadius: 10,
    startOrMid: new LineModulation(0),
    endOrRange: new LineModulation(Math.PI),
    method: 'midRange',
  });
  midRange.setPolarSteps(45);
  closeRel(midRange.voxConstruct(pk).properties().volume, halfVolume, 0.03);

  const startEnd = new BasePipeSegment(Frames.alongLine(20, zUp), {
    innerRadius: 5,
    outerRadius: 10,
    startOrMid: new LineModulation(-Math.PI / 2),
    endOrRange: new LineModulation(Math.PI / 2),
    method: 'startEnd',
  });
  startEnd.setPolarSteps(45);
  startEnd.setLengthSteps(5);
  closeRel(startEnd.voxConstruct(pk).properties().volume, halfVolume, 0.03);

  // Explicit length on the Frame form (construction only — geometry as above).
  const explicitLength = new BasePipeSegment(zUp, {
    length: 20,
    innerRadius: 5,
    outerRadius: 10,
    startOrMid: new LineModulation(0),
    endOrRange: new LineModulation(Math.PI),
    method: 'midRange',
  });
  closeAbs(explicitLength.surfacePoint(1, 0.5, 1)[2], 20, 1e-6);
});

// ---------------------------------------------------------------- BaseRing

test('BaseRing: torus volume 2π²·R·r²', () => {
  const ring = new BaseRing(zUp, 20, 5);
  ring.setRadialSteps(90);
  ring.setPolarSteps(45);
  closeRel(ring.voxConstruct(pk).properties().volume, 2 * Math.PI * Math.PI * 20 * 25);
  // Defaults branch (R=50, r=5) with SetRadius — bounds carry the tube radius.
  const defaulted = new BaseRing(zUp);
  defaulted.setRadius(new SurfaceModulation(5));
  defaulted.setRadialSteps(90);
  defaulted.setPolarSteps(45);
  const { bounds } = defaulted.voxConstruct(pk).properties();
  closeAbs(bounds.max[0], 55, 0.75);
});

// ---------------------------------------------------------------- BaseLens

test('BaseLens: washer volume; modulated faces branch', () => {
  const lens = new BaseLens(zUp, 5, 5, 15);
  lens.setPolarSteps(90);
  closeRel(lens.voxConstruct(pk).properties().volume, Math.PI * (225 - 25) * 5);

  const domed = new BaseLens(zUp, 5, 5, 15);
  domed.setHeight(new SurfaceModulation(0), new SurfaceModulation(5));
  domed.setRadialSteps(10);
  domed.setPolarSteps(90);
  domed.setHeightSteps(5);
  closeRel(domed.voxConstruct(pk).properties().volume, Math.PI * 200 * 5);
});

// ------------------------------------------------------------- BaseRevolve

test('BaseRevolve: revolved rectangle = annulus; accessors; framesFromContour', () => {
  // Vertical spine at radius 20: cylindrical frames give a radial local X.
  const spine = Frames.ofType(
    [
      [20, 0, 0],
      [20, 0, 10],
    ],
    'cylindrical',
    1,
  );
  const revolve = new BaseRevolve(zUp, spine, 3, 3);
  revolve.setLengthSteps(20);
  revolve.setPolarSteps(90);
  revolve.setRadialSteps(10);
  const { volume } = revolve.voxConstruct(pk).properties();
  closeRel(volume, Math.PI * (23 * 23 - 17 * 17) * 10, 0.03);

  closeAbs(vec3.length([revolve.spinePoint(0.5)[0], revolve.spinePoint(0.5)[1], 0]), 20, 0.1);
  closeAbs(vecRadius(revolve.outerSurfacePoint(0, 0.5)), 23, 0.15);
  closeAbs(vecRadius(revolve.innerSurfacePoint(0, 0.5)), 17, 0.15);

  // Defaults branch (inward/outward = 3), then SetRadius with the same values.
  const defaulted = new BaseRevolve(zUp, spine);
  defaulted.setRadius(new LineModulation(3), new LineModulation(3));
  defaulted.setLengthSteps(10);
  defaulted.setPolarSteps(45);
  defaulted.setRadialSteps(5);
  closeRel(defaulted.voxConstruct(pk).properties().volume, Math.PI * 240 * 10, 0.04);

  const contour = new GenericContour(10, new LineModulation(20));
  const contourFrames = BaseRevolve.framesFromContour(contour);
  const mid = contourFrames.spineAt(0.5);
  closeAbs(vecRadius(mid), 20, 0.5);
  const explicitFrame = BaseRevolve.framesFromContour(contour, zUp);
  closeAbs(vecRadius(explicitFrame.spineAt(0.5)), 20, 0.5);
});

function vecRadius(pt: Vec3): number {
  return Math.sqrt(pt[0] * pt[0] + pt[1] * pt[1]);
}

// -------------------------------------------------------------- meshUtility

test('meshUtility: grid/quad construction, per-vertex transforms, frame moves', () => {
  const quad = meshUtility.meshFromQuad(pk, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
  assert.equal(quad.triangleCount, 2);

  const grid: Vec3[][] = [];
  for (let i = 0; i < 3; i += 1) {
    const row: Vec3[] = [];
    for (let j = 0; j < 3; j += 1) row.push([i, j, 0]);
    grid.push(row);
  }
  const gridMesh = meshUtility.meshFromGrid(pk, grid);
  assert.equal(gridMesh.triangleCount, 8);

  const moved = meshUtility.applyTransformation(pk, quad, (pt) => vec3.add(pt, [10, 0, 0]));
  assert.equal(moved.triangleCount, 2);
  closeAbs(moved.bounds().min[0], 10, 1e-6);

  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const shifted = meshUtility.voxApplyTransformation(pk, sphere, (pt) => vec3.add(pt, [20, 0, 0]));
  closeRel(shifted.properties().volume, sphere.properties().volume, 0.05);
  closeAbs(shifted.properties().bounds.min[0], 15, 0.75);

  const onto = meshUtility.translateMeshOntoFrame(pk, quad, localFrame.identity, localFrame.create([5, 0, 0]));
  closeAbs(onto.bounds().min[0], 5, 1e-6);
});

// ------------------------------------------------------ determinism + trafo

test('STL bytes are deterministic across reconstructions', () => {
  const build = () => {
    const cylinder = new BaseCylinder(zUp, 10, 5);
    cylinder.setPolarSteps(45);
    return cylinder.mshConstruct(pk).toStl();
  };
  assert.ok(Buffer.from(build()).equals(Buffer.from(build())));
});

test('setTransformation applies point-wise during construction', () => {
  const cylinder = new BaseCylinder(zUp, 10, 5);
  cylinder.setPolarSteps(45);
  cylinder.setTransformation((pt) => [pt[0] + 50, pt[1], pt[2]]);
  const { bounds } = cylinder.voxConstruct(pk).properties();
  closeAbs(bounds.min[0], 45, 0.75);
  closeAbs(bounds.max[0], 55, 0.75);
});
