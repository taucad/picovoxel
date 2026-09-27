// R6 (real-world-subjects blueprint) — lattice shapes, the Sh facade subset,
// and ImplicitUtility. The implicit classes are pinned tape ≡ callback with
// the existing exactness discipline (fresh-grid fill: volume Object.is + STL
// byte equality). Lattice volumes against capsule closed forms; the
// latFromGrid last-row-wins upstream quirk is pinned against a hand-built
// equivalent lattice.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPico, type Pico } from '../src/index.ts';
import {
  ImplicitGenus,
  ImplicitGyroid,
  ImplicitSphere,
  ImplicitSuperEllipsoid,
  inverseGrid,
  LatticeManifold,
  LatticePipe,
  Frames,
  LineModulation,
  localFrame,
  sh,
} from '../src/shapekernel.ts';
import { slicesFromCli } from '../src/slicing.ts';
import type { Vec3 } from '../src/types.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

function closeRel(actual: number, expected: number, rel = 0.02): void {
  assert.ok(
    Math.abs(actual - expected) / Math.abs(expected) <= rel,
    `expected ${actual} within ${rel * 100}% of ${expected}`,
  );
}

const zUp = localFrame.createZX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
const xAlong = localFrame.createZX([0, 0, 0], [1, 0, 0], [0, 0, 1]);

const capsuleVolume = (r: number, l: number): number => Math.PI * r * r * l + (4 / 3) * Math.PI * r ** 3;

// ------------------------------------------------------------- LatticePipe

test('LatticePipe: chained capsule beams equal one capsule; both ctors; modulation', () => {
  const pipe = new LatticePipe(zUp, 20, 3);
  closeRel(pipe.voxConstruct(pk).properties().volume, capsuleVolume(3, 20));

  const frames = Frames.alongLine(20, zUp);
  const spinePipe = new LatticePipe(frames, 3);
  spinePipe.setLengthSteps(100);
  closeRel(spinePipe.voxConstruct(pk).properties().volume, capsuleVolume(3, 20));

  // Default-radius branches (r = 10).
  closeRel(new LatticePipe(zUp, 20).voxConstruct(pk).properties().volume, capsuleVolume(10, 20));
  const spineDefault = new LatticePipe(frames);
  spineDefault.setLengthSteps(50);
  closeRel(spineDefault.voxConstruct(pk).properties().volume, capsuleVolume(10, 20));

  // Modulated taper sits strictly between the two constant-radius capsules.
  const taperedPipe = new LatticePipe(zUp, 20, 3);
  taperedPipe.setRadius(new LineModulation((lr: number) => 3 - 2 * lr));
  const taperedVolume = taperedPipe.voxConstruct(pk).properties().volume;
  assert.ok(taperedVolume < capsuleVolume(3, 20));
  assert.ok(taperedVolume > capsuleVolume(1, 20));

  // spinePoint honours the vertex transformation.
  const shifted = new LatticePipe(zUp, 20, 3);
  shifted.setTransformation((pt) => [pt[0] + 7, pt[1], pt[2]]);
  assert.equal(shifted.spinePoint(0)[0], 7);
});

test('LatticeManifold: teardrop tips extend beyond the round pipe', () => {
  const plain = new LatticePipe(xAlong, 10, 3);
  const plainProps = plain.voxConstruct(pk).properties();

  const manifold = new LatticeManifold(xAlong, { length: 10, radius: 3 });
  const manifoldProps = manifold.voxConstruct(pk).properties();
  assert.ok(manifoldProps.volume > plainProps.volume, 'tips add material');
  assert.ok(manifoldProps.bounds.max[2] > 3.5, `tip reaches ${manifoldProps.bounds.max[2]} in +Z`);
  // One-sided by default: -Z stays at the pipe radius.
  assert.ok(manifoldProps.bounds.min[2] > -3.6);

  const bothSides = new LatticeManifold(xAlong, { length: 10, radius: 3, extendBothSides: true });
  const bothProps = bothSides.voxConstruct(pk).properties();
  assert.ok(bothProps.bounds.min[2] < -3.5, 'both-sides tip reaches -Z');

  // Frames form + option defaults.
  const spineManifold = new LatticeManifold(Frames.alongLine(10, xAlong));
  spineManifold.setLengthSteps(50);
  assert.ok(spineManifold.voxConstruct(pk).properties().volume > 0);
  const defaulted = new LatticeManifold(xAlong, {});
  defaulted.setLengthSteps(50);
  assert.ok(defaulted.voxConstruct(pk).properties().volume > 0);
});

// ---------------------------------------------------------------------- sh

test('sh lattice builders: line/points/edges/point/beam forms', () => {
  const line: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
  ];
  closeRel(sh.latFromLine(pk, line, 2).toVoxels().properties().volume, capsuleVolume(2, 10), 0.03);
  closeRel(
    sh.latFromBeam(pk, [0, 0, 0], [10, 0, 0], 2, true).toVoxels().properties().volume,
    capsuleVolume(2, 10),
    0.03,
  );
  // Un-rounded beam = plain cylinder (4%: sharp flat caps at r=2 = 4 voxels).
  closeRel(
    sh.latFromBeam(pk, [0, 0, 0], [10, 0, 0], 2, false).toVoxels().properties().volume,
    Math.PI * 4 * 10,
    0.04,
  );
  closeRel(sh.latFromPoint(pk, [0, 0, 0], 3).toVoxels().properties().volume, (4 / 3) * Math.PI * 27);
  closeRel(
    sh
      .latFromPoints(
        pk,
        [
          [0, 0, 0],
          [20, 0, 0],
        ],
        3,
      )
      .toVoxels()
      .properties().volume,
    2 * (4 / 3) * Math.PI * 27,
  );
  closeRel(
    sh
      .latFromEdges(
        pk,
        [
          line,
          [
            [0, 20, 0],
            [10, 20, 0],
          ],
        ],
        2,
      )
      .toVoxels()
      .properties().volume,
    2 * capsuleVolume(2, 10),
    0.03,
  );
  const tapered = sh.latFromTaperedBeam(pk, [0, 0, 0], [10, 0, 0], 1, 3, true);
  const taperedVolume = tapered.toVoxels().properties().volume;
  assert.ok(taperedVolume > capsuleVolume(1, 10) && taperedVolume < capsuleVolume(3, 10));
});

test('sh.latFromGrid pins the upstream last-row-wins quirk', () => {
  const spacing = 10;
  const grid: Vec3[][] = [
    [
      [0, 0, 0],
      [spacing, 0, 0],
    ],
    [
      [0, spacing, 0],
      [spacing, spacing, 0],
    ],
  ];
  const fromGrid = sh.latFromGrid(pk, grid, 1.5).toVoxels();

  // Hand-built equivalent: ONLY the last row survives, plus both columns.
  const expected = pk.createLattice();
  sh.addLine(expected, grid[1]!, 1.5);
  for (const column of inverseGrid(grid)) sh.addLine(expected, column, 1.5);
  expect(fromGrid.equals(expected.toVoxels())).toBe(true);

  assert.deepEqual(inverseGrid(grid), [
    [
      [0, 0, 0],
      [0, spacing, 0],
    ],
    [
      [spacing, 0, 0],
      [spacing, spacing, 0],
    ],
  ]);
});

test('sh exports: STL, VDB and CLI byte producers', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const mesh = sphere.toMesh();
  assert.ok(Buffer.from(sh.exportMeshToStl(mesh)).equals(Buffer.from(mesh.toStl())));
  assert.equal(sh.exportVoxelsToStl(sphere).length, 84 + 50 * mesh.triangleCount);

  const vdbBytes = sh.exportVoxelsToVdb(pk, sphere);
  const restored = pk.voxelsFromVdb(vdbBytes);
  expect(restored.equals(sphere)).toBe(true);

  const cliBytes = sh.exportVoxelsToCli(sphere);
  const stack = slicesFromCli(cliBytes);
  assert.ok(stack.slices.length > 10, `CLI round-trip carries ${stack.slices.length} slices`);
});

// -------------------------------------------------------- ImplicitUtility

test('ImplicitGyroid: tape ≡ callback exactly; thickness ratio helper', () => {
  const gyroid = new ImplicitGyroid(5, ImplicitGyroid.thicknessRatio(0.25, 5));
  const bounds = { boundsMin: [-10, -10, -10] as const, boundsMax: [10, 10, 10] as const };
  const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: gyroid.expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: gyroid.sdf });
  expect(fromTape.volume).toBe(fromCallback.volume);
  expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(
    true,
  );
  assert.equal(ImplicitGyroid.thicknessRatio(0.25, 5), 0.5);
});

test('ImplicitSphere: closed-form volume; tape ≡ callback', () => {
  const sphere = new ImplicitSphere([1, 2, 3], 6);
  const bounds = { boundsMin: [-7, -6, -5] as const, boundsMax: [9, 10, 11] as const };
  const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: sphere.expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: sphere.sdf });
  expect(fromTape.volume).toBe(fromCallback.volume);
  closeRel(fromTape.properties().volume, (4 / 3) * Math.PI * 216);
});

test('ImplicitGenus: tape ≡ callback on the quartic surface', () => {
  const genus = new ImplicitGenus(0.05);
  const bounds = { boundsMin: [-2, -2, -2] as const, boundsMax: [2, 2, 2] as const };
  const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: genus.expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: genus.sdf });
  expect(fromTape.volume).toBe(fromCallback.volume);
  expect(fromTape.isEmpty).toBe(false);
});

test('ImplicitSuperEllipsoid: ε=1 degenerates to a quadric sphere; tape ≡ callback', () => {
  const ellipsoid = new ImplicitSuperEllipsoid([0, 0, 0], 5, 5, 5, 1, 1);
  const bounds = { boundsMin: [-6, -6, -6] as const, boundsMax: [6, 6, 6] as const };
  const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: ellipsoid.expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: ellipsoid.sdf });
  expect(fromTape.volume).toBe(fromCallback.volume);
  // Non-metric SDF → boundary is exact, band is thin: 5% tolerance.
  closeRel(fromTape.properties().volume, (4 / 3) * Math.PI * 125, 0.05);
});
