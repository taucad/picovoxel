// R13 (real-world-subjects blueprint) — LatticeLibrary-TS unit oracles to
// 100×4 over src/latticelibrary/**. Cell arrays and beam-thickness strategies
// against closed forms and structural invariants; the coordinate-seeded noise
// and RandomSource streams are pinned as self-referential determinism; the
// five closed-form TPMS presets are pinned tape ≡ callback with the exactness
// discipline (fresh-grid fill: volume Object.is + STL byte equality); the
// three callback-only presets against independently computed formula values.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';
import {
  BodyCentreLattice,
  BoundaryBeamThickness,
  CellBasedBeamThickness,
  type CellArray,
  CombinedTrafo,
  ConformalCellArray,
  conformalShowcaseShapes,
  ConstantBeamThickness,
  CuboidCell,
  FullVoidLogic,
  FullWallLogic,
  FunctionalScaleTrafo,
  GlobalFuncBeamThickness,
  ImplicitLidinoid,
  ImplicitModular,
  ImplicitRadialGyroid,
  ImplicitRandomizedSchwarzPrimitive,
  ImplicitSchwarzDiamond,
  ImplicitSchwarzPrimitive,
  ImplicitSplitVoidGyroid,
  ImplicitSplitWallGyroid,
  type LatticeType,
  NegativeHalfWallLogic,
  NegativeVoidLogic,
  OctahedronLattice,
  PositiveHalfWallLogic,
  PositiveVoidLogic,
  RadialTrafo,
  RandomDeformationField,
  RandomSplineLattice,
  RawGyroidTpmsPattern,
  RawLidinoidTpmsPattern,
  RawSchwarzDiamondTpmsPattern,
  RawSchwarzPrimitiveTpmsPattern,
  RawTransitionTpmsPattern,
  RegularCellArray,
  RegularUnitCell,
  ScaleTrafo,
  type UnitCell,
} from '../src/latticelibrary.ts';
import { BaseBox, createRandom, type Implicit, localFrame, uf } from '../src/shapekernel.ts';
import type { Vec3 } from '../src/types.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

const unitCube = (size = 10): CuboidCell =>
  new CuboidCell([
    [0, 0, 0],
    [0, size, 0],
    [size, size, 0],
    [size, 0, 0],
    [0, 0, size],
    [0, size, size],
    [size, size, size],
    [size, 0, size],
  ]);

/** A non-cuboid stub to hit the 8-corner guards. */
const quadCell: UnitCell = {
  cornerPoints: () => [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  cellCentre: () => [0.5, 0.5, 0],
  cellBounding: () => ({ min: [0, 0, 0], max: [1, 1, 0] }),
};

// ------------------------------------------------------------- unit cells

test('CuboidCell: corners, averaged centre and bounding from a skewed cell', () => {
  const cell = new CuboidCell([
    [1, -2, 0],
    [0, 6, -1],
    [8, 7, 1],
    [9, -1, 0],
    [1, -2, 8],
    [0, 6, 9],
    [8, 7, 10],
    [9, -1, 9],
  ]);
  assert.equal(cell.cornerPoints().length, 8);
  assert.deepEqual(cell.cellCentre(), [36 / 8, 20 / 8, 36 / 8]);
  assert.deepEqual(cell.cellBounding(), { min: [0, -2, -1], max: [9, 7, 10] });
});

// ------------------------------------------------------------ cell arrays

test('RegularCellArray: grid houses the field bounds; noise is coordinate-seeded and clamped', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const { bounds } = sphere.properties();
  const regular = new RegularCellArray(sphere, 4, 5, 6);
  const cells = regular.unitCells();
  assert.ok(cells.length >= 8, `covers the sphere with ${cells.length} cells`);
  for (const cell of cells) {
    const size = cell.cellBounding();
    assert.ok(Math.abs(size.max[0] - size.min[0] - 4) < 1e-9);
    assert.ok(Math.abs(size.max[1] - size.min[1] - 5) < 1e-9);
    assert.ok(Math.abs(size.max[2] - size.min[2] - 6) < 1e-9);
  }
  const min = cells[0]!.cellBounding().min;
  assert.ok(min[0] <= bounds.min[0] && min[1] <= bounds.min[1] && min[2] <= bounds.min[2]);

  // Same input, noise on: every corner deviates at most the clamped 0.3 level
  // (0.9 requested), and adjacent cells still share deformed corners exactly
  // because the noise stream is reseeded from the corner coordinates.
  const noisy = new RegularCellArray(sphere, 4, 5, 6, 0.9).unitCells();
  assert.equal(noisy.length, cells.length);
  for (let i = 0; i < cells.length; i += 1) {
    const plain = cells[i]!.cornerPoints();
    const deformed = noisy[i]!.cornerPoints();
    for (let c = 0; c < 8; c += 1) {
      assert.ok(Math.abs(deformed[c]![0] - plain[c]![0]) <= 0.3 * 4 + 1e-9);
      assert.ok(Math.abs(deformed[c]![1] - plain[c]![1]) <= 0.3 * 5 + 1e-9);
      assert.ok(Math.abs(deformed[c]![2] - plain[c]![2]) <= 0.3 * 6 + 1e-9);
    }
  }
  const first = noisy[0]!.cornerPoints();
  const zNeighbour = noisy[1]!.cornerPoints(); // z is the innermost loop
  // Cell 0's upper corners 5-8 are cell 1's lower corners 1-4.
  assert.deepEqual(first.slice(4), zNeighbour.slice(0, 4));
});

test('RegularUnitCell: one cell centred in XY, based at z = 0', () => {
  const single = new RegularUnitCell(4, 6, 8);
  const cells = single.unitCells();
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0]!.cellBounding(), { min: [-2, -3, 0], max: [2, 3, 8] });
  assert.deepEqual(cells[0]!.cellCentre(), [0, 0, 4]);
  // Noise above the clamp still keeps corners within 0.3 of the cell size.
  const noisy = new RegularUnitCell(4, 6, 8, -2).unitCells()[0]!.cornerPoints();
  const plain = cells[0]!.cornerPoints();
  for (let c = 0; c < 8; c += 1) {
    assert.ok(Math.abs(noisy[c]![0] - plain[c]![0]) <= 0.3 * 4 + 1e-9);
  }
});

test('ConformalCellArray: box, lens and segment mappings hit the surface points', () => {
  const box = new BaseBox(localFrame.identity, 10, 10, 10);
  const boxCells = new ConformalCellArray(box, 2, 2, 2);
  assert.equal(boxCells.unitCells().length, 8);
  // First cell, corner 01 = indices (0, 0, 0) → ratios (-1, -1, 0).
  assert.deepEqual(boxCells.unitCells()[0]!.cornerPoints()[0], box.surfacePoint(-1, -1, 0));
  // Corner 02 steps +x in the conformal winding.
  assert.deepEqual(boxCells.unitCells()[0]!.cornerPoints()[1], box.surfacePoint(0, -1, 0));

  const lens = conformalShowcaseShapes.lens01();
  const lensCells = new ConformalCellArray(lens, 2, 3, 4);
  assert.equal(lensCells.unitCells().length, 24);
  assert.deepEqual(lensCells.unitCells()[0]!.cornerPoints()[0], lens.surfacePoint(0, 0, 0));
  assert.deepEqual(lensCells.unitCells()[0]!.cornerPoints()[6], lens.surfacePoint(1 / 2, 1 / 4, 1 / 3));

  const segment = conformalShowcaseShapes.segment01();
  const segmentCells = new ConformalCellArray(segment, 2, 2, 2);
  assert.equal(segmentCells.unitCells().length, 8);
  assert.deepEqual(segmentCells.unitCells()[0]!.cornerPoints()[0], segment.surfacePoint(0, 0, 0));
});

test('conformalShowcaseShapes: the modulated demo shapes carry their C# modulations', () => {
  const box = conformalShowcaseShapes.box01();
  // Width 60 + 20cos(5·lr), depth 80 − 40cos(3·lr): at lr = 0 the surface point
  // (1, 1, 0) sits at (+40, +20, 0).
  const corner = box.surfacePoint(1, 1, 0);
  assert.ok(Math.abs(corner[0] - 40) < 1e-9 && Math.abs(corner[1] - 20) < 1e-9 && corner[2] === 0);

  const lens = conformalShowcaseShapes.lens01();
  // Lower face −20 + 20·rr, upper 20 + 5cos(2·rr): at rr = 0 heights are −20 / 25.
  assert.ok(Math.abs(lens.surfacePoint(0, 0, 0)[2] - -20) < 1e-9);
  assert.ok(Math.abs(lens.surfacePoint(1, 0, 0)[2] - 25) < 1e-9);

  const segment = conformalShowcaseShapes.segment01();
  // Inner radius 20 + 10·lr at phi mid 0: the (0, 0.5, 0) surface point sits on +x.
  const inner = segment.surfacePoint(0, 0.5, 0);
  assert.ok(Math.abs(inner[0] - 20) < 1e-9 && Math.abs(inner[1]) < 1e-9);
});

// --------------------------------------------------------- beam thickness

test('ConstantBeamThickness: value everywhere; cell and boundary hooks are no-ops', () => {
  const constant = new ConstantBeamThickness(2.5);
  assert.equal(constant.beamThickness([0, 0, 0]), 2.5);
  constant.updateCell(unitCube());
  constant.setBoundingVoxels(pk.createVoxels({ shape: 'empty' }));
  assert.equal(constant.beamThickness([9, 9, 9]), 2.5);
});

test('CellBasedBeamThickness: min at centre, max at the diagonal radius, clamped outside', () => {
  const cellBased = new CellBasedBeamThickness(1, 4);
  assert.throws(() => cellBased.beamThickness([0, 0, 0]), /No Unit Cell specified/);
  const cell = unitCube(10);
  cellBased.updateCell(cell);
  assert.ok(Math.abs(cellBased.beamThickness(cell.cellCentre()) - 1) < 1e-9);
  assert.ok(Math.abs(cellBased.beamThickness([0, 0, 0]) - 4) < 1e-9); // corner = half diagonal
  assert.ok(Math.abs(cellBased.beamThickness([-100, 0, 0]) - 4) < 1e-9); // ratio clamps to 1
  const mid = cellBased.beamThickness([2.5, 5, 5]);
  assert.ok(mid > 1 && mid < 4);
  cellBased.setBoundingVoxels(pk.createVoxels({ shape: 'empty' })); // no-op
});

test('BoundaryBeamThickness: max on the boundary falling toward min inside', () => {
  const boundary = new BoundaryBeamThickness(1, 4);
  assert.throws(() => boundary.beamThickness([0, 0, 0]), /No Boundary Voxels specified/);
  boundary.setBoundingVoxels(pk.createVoxels({ shape: 'empty' }));
  assert.throws(() => boundary.beamThickness([0, 0, 0]), /No Closest Point found/);
  boundary.setBoundingVoxels(pk.createVoxels({ shape: 'sphere', radius: 10 }));
  const onSurface = boundary.beamThickness([10, 0, 0]);
  const inside = boundary.beamThickness([5, 0, 0]);
  const centre = boundary.beamThickness([0, 0, 0]);
  assert.ok(onSurface > 3.9, `surface thickness ${onSurface} ≈ max`);
  assert.ok(inside > centre && onSurface > inside, 'monotone toward the boundary');
  assert.ok(centre > uf.transSmooth(4, 1, 15, 15, 5), 'still above the mid-transition value');
  boundary.updateCell(unitCube()); // no-op
});

test('GlobalFuncBeamThickness: hard-coded x-ramp with clamps; hooks are no-ops', () => {
  const global = new GlobalFuncBeamThickness(1, 4);
  assert.ok(Math.abs(global.beamThickness([-5, 0, 0]) - 1) < 1e-9); // clamp 0
  assert.ok(Math.abs(global.beamThickness([50, 0, 0]) - 4) < 1e-9); // clamp 1
  const mid = global.beamThickness([25, 0, 0]);
  assert.ok(mid > 1 && mid < 4);
  global.updateCell(unitCube());
  global.setBoundingVoxels(pk.createVoxels({ shape: 'empty' }));
});

// ---------------------------------------------------------- lattice types

test('BodyCentre and Octahedron: 8-corner guard; sub-sampling a constant beam is geometry-neutral', () => {
  const constant = new ConstantBeamThickness(2);
  for (const [latticeType, name] of [
    [new BodyCentreLattice(), 'Body Centre Lattice'],
    [new OctahedronLattice(), 'Octahedron Lattice'],
  ] as Array<[LatticeType, string]>) {
    assert.throws(() => latticeType.addCell(pk.createLattice(), quadCell, constant), new RegExp(name));

    const plain = pk.createLattice();
    latticeType.addCell(plain, unitCube(), constant); // default subSamples = 2
    const sampled = pk.createLattice();
    latticeType.addCell(sampled, unitCube(), constant, 5);
    expect(plain.toVoxels().equals(sampled.toVoxels())).toBe(true);
    assert.ok(!plain.toVoxels().isEmpty);
  }
});

test('BodyCentre with cell-based thickness: sub-sampling changes the taper', () => {
  const tapered = new CellBasedBeamThickness(1, 4);
  tapered.updateCell(unitCube());
  const two = pk.createLattice();
  new BodyCentreLattice().addCell(two, unitCube(), tapered, 2);
  const five = pk.createLattice();
  new BodyCentreLattice().addCell(five, unitCube(), tapered, 5);
  expect(two.toVoxels().equals(five.toVoxels())).toBe(false);
});

test('RandomSplineLattice: seeded determinism, growing passes, and the self-connection retry', () => {
  const constant = new ConstantBeamThickness(2);
  const build = (passes?: number, seed = 7): ReturnType<Pico['createLattice']> => {
    const lattice = pk.createLattice();
    const splines =
      passes === undefined
        ? new RandomSplineLattice(createRandom(seed))
        : new RandomSplineLattice(createRandom(seed), passes);
    splines.addCell(lattice, unitCube(), constant);
    return lattice;
  };
  const first = build().toVoxels();
  expect(first.equals(build().toVoxels())).toBe(true); // same seed, same geometry
  const twoPasses = build(2).toVoxels();
  // Pass 1 of the two-pass build draws the identical stream → superset.
  assert.ok(twoPasses.properties().volume > first.properties().volume);

  // A stubbed stream forces the do-while to reject j === i once for corner 0.
  const queue = [0.01, 0.2, 0.5, 0.5, 0.5];
  for (let i = 1; i < 8; i += 1) queue.push(0.01, 0.5, 0.5, 0.5);
  const stubbed = pk.createLattice();
  new RandomSplineLattice(() => queue.shift() ?? 0.5, 1).addCell(stubbed, unitCube(), constant, 3);
  assert.ok(!stubbed.toVoxels().isEmpty);
});

// ------------------------------------------------------ coordinate trafos

test('coordinate trafos: scale, functional ramp, radial unwrap and composition', () => {
  assert.deepEqual(new ScaleTrafo(2, 4, 5).apply([10, 10, 10]), [5, 2.5, 2]);

  const functional = new FunctionalScaleTrafo();
  assert.deepEqual(functional.apply([20, 20, -5]), [1, 1, 10]); // clamp 0 → unit 20
  assert.deepEqual(functional.apply([20, 20, 100]), [4, 4, 10]); // clamp 1 → unit 5
  const mid = functional.apply([20, 20, 25]);
  assert.ok(mid[0] > 1 && mid[0] < 4 && mid[2] === 10, 'z pins to 10 (upstream quirk)');

  const radial = new RadialTrafo(16, 0.5);
  const unwrapped = radial.apply([0, 3, 2]);
  assert.ok(Math.abs(unwrapped[0] - 3) < 1e-9, 'x = radius');
  assert.ok(Math.abs(unwrapped[1] - 16 * (Math.PI / 2 + 0.5 * 2)) < 1e-9, 'y = n·(phi + phiPerZ·z)');
  assert.equal(unwrapped[2], 2);

  const combined = new CombinedTrafo([new ScaleTrafo(2, 2, 2), new ScaleTrafo(5, 5, 5)]);
  assert.deepEqual(combined.apply([100, 100, 100]), [10, 10, 10]);
  assert.deepEqual(new CombinedTrafo([]).apply([1, 2, 3]), [1, 2, 3]);
});

// ------------------------------------------------------- splitting logics

test('splitting logics: the six C# closed forms', () => {
  assert.equal(new FullWallLogic().advancedSignedDistance(-0.2, 1), -0.3);
  assert.equal(new FullVoidLogic().advancedSignedDistance(-0.2, 1), 0.3);
  assert.equal(new PositiveHalfWallLogic().advancedSignedDistance(0.2, 1), 0.2);
  assert.equal(new PositiveHalfWallLogic().advancedSignedDistance(-0.2, 1), -0.2); // max picks the raw distance
  assert.equal(new NegativeHalfWallLogic().advancedSignedDistance(-0.2, 1), 0.2);
  assert.equal(new NegativeHalfWallLogic().advancedSignedDistance(0.2, 1), -0.2);
  assert.equal(new PositiveHalfWallLogic().advancedSignedDistance(-0.2, 0.5), 0.2 - 0.25); // thin wall: the wall term wins
  assert.equal(new PositiveVoidLogic().advancedSignedDistance(0.2, 1), 0.3);
  assert.equal(new PositiveVoidLogic().advancedSignedDistance(-0.2, 1), 0.5);
  assert.equal(new NegativeVoidLogic().advancedSignedDistance(-0.2, 1), 0.3);
  assert.equal(new NegativeVoidLogic().advancedSignedDistance(0.2, 1), 0.5);
});

// ------------------------------------------------------- raw TPMS patterns

test('raw TPMS patterns: unit-frequency surface equations', () => {
  const gyroid = new RawGyroidTpmsPattern();
  assert.ok(Math.abs(gyroid.signedDistance(0.25, 0, 0) - 1) < 1e-9); // sin(π/2)·cos(0) + 0 + 0

  const primitive = new RawSchwarzPrimitiveTpmsPattern();
  assert.equal(primitive.signedDistance(0, 0, 0), 3);
  assert.ok(Math.abs(primitive.signedDistance(0.5, 0.5, 0.5) - -3) < 1e-9);

  const diamond = new RawSchwarzDiamondTpmsPattern();
  assert.equal(diamond.signedDistance(0, 0, 0), 1);
  assert.ok(Math.abs(diamond.signedDistance(1, 1, 1) - -1) < 1e-9); // cos³(π) − sin³(π)

  const lidinoid = new RawLidinoidTpmsPattern();
  assert.ok(Math.abs(lidinoid.signedDistance(0, 0, 0) - -1.5) < 1e-9); // −0.5·(1+1+1)

  const transition = new RawTransitionTpmsPattern();
  assert.equal(transition.signedDistance(-3, 0.1, 0.2), diamond.signedDistance(-3, 0.1, 0.2)); // ratio 0
  assert.equal(transition.signedDistance(4, 0.1, 0.2), primitive.signedDistance(4, 0.1, 0.2)); // ratio 1
  const blended = transition.signedDistance(0.5, 0.1, 0.2);
  const d = diamond.signedDistance(0.5, 0.1, 0.2);
  const p = primitive.signedDistance(0.5, 0.1, 0.2);
  assert.ok(blended >= Math.min(d, p) && blended <= Math.max(d, p), 'blend stays between the surfaces');
});

// ------------------------------------------------- random deformation field

test('RandomDeformationField: trilinear noise, clamped to bounds, deterministic per seed', () => {
  const bounds = { min: [0, 0, 0], max: [40, 40, 40] } as const;
  const field = new RandomDeformationField(bounds, 20, -8, 8, createRandom(3));
  const inside = field.dataAt([13, 27, 5]);
  for (const component of inside) assert.ok(component >= -8 && component <= 8);
  // Clamping: any point beyond a face interpolates the boundary value.
  assert.deepEqual(field.dataAt([-100, 27, 5]), field.dataAt([0, 27, 5]));
  // Determinism: an identical seed reproduces the grid exactly.
  const again = new RandomDeformationField(bounds, 20, -8, 8, createRandom(3));
  assert.deepEqual(again.dataAt([13, 27, 5]), inside);
  // A zero-amplitude field vanishes everywhere.
  const flat = new RandomDeformationField(bounds, 20, 0, 0, createRandom(3));
  assert.deepEqual(flat.dataAt([13, 27, 5]), [0, 0, 0]);
});

// ----------------------------------------------------------- TPMS presets

/** Asserts tape ≡ callback bit-exactly (volume and STL bytes) over a fresh implicit fill. */
function expectTapeMatchesCallback(implicit: Implicit): void {
  const bounds = { boundsMin: [-5, -5, -5] as const, boundsMax: [5, 5, 5] as const };
  const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: implicit.expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: implicit.sdf });
  expect(fromTape.volume).toBe(fromCallback.volume);
  expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(
    true,
  );
  expect(fromTape.isEmpty).toBe(false);
}

test('closed-form TPMS presets: tape ≡ callback exactly', () => {
  expectTapeMatchesCallback(new ImplicitLidinoid(5, 0.5));
  expectTapeMatchesCallback(new ImplicitSchwarzPrimitive(5, 0.5));
  expectTapeMatchesCallback(new ImplicitSchwarzDiamond(5, 0.5));
  expectTapeMatchesCallback(new ImplicitSplitWallGyroid(5, 1, true));
  expectTapeMatchesCallback(new ImplicitSplitWallGyroid(5, 1, false));
  expectTapeMatchesCallback(new ImplicitSplitVoidGyroid(5, 1, true));
  expectTapeMatchesCallback(new ImplicitSplitVoidGyroid(5, 1, false));
});

test('split gyroids: the two sides complement around the surface', () => {
  const wall = new ImplicitSplitWallGyroid(10, 1, true).sdf;
  const voidSide = new ImplicitSplitVoidGyroid(10, 1, true).sdf;
  // Deep on the positive side of the surface the wall side is solid distance,
  // the void side is (negated) shrunk distance.
  const gyroid = (s: number, x: number, y: number, z: number): number =>
    Math.sin(s * x) * Math.cos(s * y) + Math.sin(s * y) * Math.cos(s * z) + Math.sin(s * z) * Math.cos(s * x);
  const s = (2 * Math.PI) / 10;
  const raw = gyroid(s, 2, 1, 3);
  assert.ok(raw > 0.5, `sample sits on the positive side (${raw})`);
  assert.equal(wall(2, 1, 3), Math.max(raw, Math.abs(raw) - 0.5));
  assert.equal(voidSide(2, 1, 3), -(raw - 0.5));
});

test('ImplicitRadialGyroid: callback matches the cylindrical unwrap formula', () => {
  const preset = new ImplicitRadialGyroid(16, 10, 0.5);
  const [x, y, z] = [7, 4, 3];
  const s = (2 * Math.PI) / 10;
  const radius = Math.sqrt(x * x + y * y);
  const dY = ((Math.atan2(y, x) + Math.PI) / ((2 * Math.PI) / 16)) * ((2 * Math.PI) / s);
  const expected =
    Math.abs(
      Math.sin(s * radius) * Math.cos(s * dY) +
        Math.sin(s * dY) * Math.cos(s * z) +
        Math.sin(s * z) * Math.cos(s * radius),
    ) - 0.25;
  assert.equal(preset.sdf(x, y, z), expected);
});

test('ImplicitRandomizedSchwarzPrimitive: a zero field degenerates to the plain primitive', () => {
  const bounds = { min: [-10, -10, -10], max: [10, 10, 10] } as const;
  const flat = new RandomDeformationField(bounds, 10, 0, 0, createRandom(1));
  const randomized = new ImplicitRandomizedSchwarzPrimitive(5, 0.5, flat);
  const plain = new ImplicitSchwarzPrimitive(5, 0.5);
  for (const pt of [
    [0, 0, 0],
    [1.3, -2.7, 4.9],
    [-8, 3, 6],
  ] as Vec3[]) {
    assert.equal(randomized.sdf(...pt), plain.sdf(...pt));
  }
  // A real field displaces the surface.
  const bumpy = new ImplicitRandomizedSchwarzPrimitive(
    5,
    0.5,
    new RandomDeformationField(bounds, 10, -2, 2, createRandom(1)),
  );
  assert.notEqual(bumpy.sdf(1.3, -2.7, 4.9), plain.sdf(1.3, -2.7, 4.9));
});

test('ImplicitModular: trafo → raw pattern → splitting logic with cartesian wall thickness', () => {
  const modular = new ImplicitModular(
    new RawGyroidTpmsPattern(),
    new ConstantBeamThickness(0.5),
    new ScaleTrafo(10, 10, 10),
    new FullWallLogic(),
  );
  const [x, y, z] = [2, 7, -3];
  const expected = Math.abs(new RawGyroidTpmsPattern().signedDistance(x / 10, y / 10, z / 10)) - 0.25;
  assert.equal(modular.sdf(x, y, z), expected);
});

// The cell-array → lattice-type → thickness workflow end to end, as the C#
// examples wire it (a compact RegularUnitCell so it stays a unit test).
test('workflow: one noisy unit cell through an Octahedron lattice voxelizes non-empty', () => {
  const array: CellArray = new RegularUnitCell(10, 10, 10, 0.1);
  const thickness = new CellBasedBeamThickness(1, 2);
  const lattice = pk.createLattice();
  for (const cell of array.unitCells()) {
    thickness.updateCell(cell);
    new OctahedronLattice().addCell(lattice, cell, thickness, 3);
  }
  assert.ok(lattice.toVoxels().properties().volume > 0);
});
