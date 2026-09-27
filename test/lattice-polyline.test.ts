// R17 — lattice (B3 single addBeam signature, SG12 roundCap default) + polyline.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico } from '../src/index.ts';
import { bindPicoRaw } from '../src/raw.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

test('beam ≙ capsule cross-check: a single round-capped beam matches the primitive', () => {
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-10, 0, 0], end: [10, 0, 0], radius: 3 });
  const viaLattice = lattice.toVoxels();

  const viaCapsule = pk.createVoxels({ shape: 'beam', start: [-10, 0, 0], end: [10, 0, 0], radius: 3 });
  const ratio = viaLattice.volume / viaCapsule.volume;
  assert.ok(Math.abs(ratio - 1) < 0.02, `lattice beam vs capsule primitive ratio ${ratio}`);
});

test('SG12 — roundCap defaults true; flat caps measurably differ', () => {
  const make = (roundCap: boolean | undefined) => {
    const lattice = pk.createLattice();
    lattice.addBeam({ start: [0, 0, -8], end: [0, 0, 8], radius: 3, ...(roundCap === undefined ? {} : { roundCap }) });
    return lattice.toVoxels();
  };
  const defaulted = make(undefined);
  const rounded = make(true);
  const flat = make(false);

  assert.ok(defaulted.equals(rounded), 'default must be roundCap: true');
  assert.ok(!flat.equals(rounded), 'flat caps are a different body');
  // Flat caps cut the two hemispheres (4/3 π r³ total) but extend the cylinder.
  const cylinder = Math.PI * 9 * 16;
  const hemispheres = (4 / 3) * Math.PI * 27;
  assert.ok(Math.abs(flat.volume - cylinder) / cylinder < 0.06, `flat ${flat.volume} vs cylinder ${cylinder}`);
  assert.ok(Math.abs(rounded.volume - (cylinder + hemispheres)) / (cylinder + hemispheres) < 0.06, `round ${rounded.volume}`);
});

test('tapered beam radii and spheres combine additively', () => {
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-10, 0, 0], end: [10, 0, 0], startRadius: 2, endRadius: 4 });
  lattice.addSphere({ center: [0, 15, 0], radius: 3 });
  const voxels = lattice.toVoxels();
  assert.ok(voxels.isInside([0, 15, 0]), 'sphere present');
  assert.ok(voxels.isInside([9, 0, 0]), 'thick end present');
  assert.ok(!voxels.isInside([-9, 3.5, 0]), 'thin end really is thin');
  assert.ok(lattice.memUsage > 0);
});

test('lattice validation: radius required through one options signature (B3)', () => {
  const lattice = pk.createLattice();
  for (const bad of [
    () => lattice.addBeam({ start: [0, 0, 0], end: [1, 0, 0] }),
    () => lattice.addBeam({ start: [0, 0, 0], end: [1, 0, 0], radius: -2 }),
    () => lattice.addSphere({ center: [0, 0, 0], radius: 0 }),
  ]) {
    try {
      bad();
      assert.fail('invalid lattice input accepted');
    } catch (error) {
      assert.ok(error instanceof PicoError);
      assert.equal(error.code, 'PICO_INVALID_ARGUMENT');
    }
  }
});

// SK-0.3 — the facade batches authoring and crosses the ABI once per lattice. The
// oracle is the path it replaced: the same elements pushed one per crossing through
// the raw per-element exports, in the same session. Volumes must match EXACTLY (not
// approximately) — a reordered, dropped or mis-strided beam moves them.
test('SK-0.3 — batched authoring is bit-identical to per-element crossings', () => {
  const raw = bindPicoRaw(pk.module);
  const lib = pk.handle;
  const scratch = pk.module._malloc(24);

  // 300 of each: past the 256-element first allocation, so the doubling path runs.
  // Deterministic, spread out enough that neighbouring elements do not all merge.
  const beam = (i: number) => ({
    start: [Math.cos(i) * 12, Math.sin(i) * 12, i * 0.05 - 7.5] as [number, number, number],
    end: [Math.cos(i + 1) * 12, Math.sin(i + 1) * 12, i * 0.05 - 7.4] as [number, number, number],
    startRadius: 0.6 + (i % 5) * 0.1,
    endRadius: 0.6 + (i % 3) * 0.1,
    roundCap: i % 4 !== 0, // exercises both cap kinds through the flag array
  });
  const sphere = (i: number) => ({
    center: [Math.cos(i) * 18, Math.sin(i) * 18, i * 0.04 - 6] as [number, number, number],
    radius: 0.8 + (i % 7) * 0.05,
  });

  const batched = pk.createLattice();
  for (let i = 0; i < 300; i++) batched.addBeam(beam(i));
  // A round-capped zero-length beam becomes a SPHERE inside PicoGK, so the bulk
  // path must route it through AddBeam, not straight into the beam vector.
  batched.addBeam({ start: [0, 0, 20], end: [0, 0, 20], radius: 2 });
  for (let i = 0; i < 300; i++) batched.addSphere(sphere(i));
  // Switching kinds mid-stream must flush the pending batch, preserving call order.
  batched.addBeam({ start: [-20, -20, 0], end: [-20, 20, 0], radius: 1.5 });
  batched.addSphere({ center: [20, 20, 0], radius: 2 });

  const writeVec = (pointer: number, [x, y, z]: readonly number[]) => {
    pk.module.HEAPF32[(pointer >> 2) + 0] = x!;
    pk.module.HEAPF32[(pointer >> 2) + 1] = y!;
    pk.module.HEAPF32[(pointer >> 2) + 2] = z!;
  };
  const perElement = raw.Lattice_hCreate(lib);
  const addBeamRaw = (b: ReturnType<typeof beam>) => {
    writeVec(scratch, b.start);
    writeVec(scratch + 12, b.end);
    raw.Lattice_AddBeam(lib, perElement, scratch, scratch + 12, b.startRadius, b.endRadius, b.roundCap);
  };
  const addSphereRaw = (s: ReturnType<typeof sphere>) => {
    writeVec(scratch, s.center);
    raw.Lattice_AddSphere(lib, perElement, scratch, s.radius);
  };
  for (let i = 0; i < 300; i++) addBeamRaw(beam(i));
  addBeamRaw({ start: [0, 0, 20], end: [0, 0, 20], startRadius: 2, endRadius: 2, roundCap: true });
  for (let i = 0; i < 300; i++) addSphereRaw(sphere(i));
  addBeamRaw({ start: [-20, -20, 0], end: [-20, 20, 0], startRadius: 1.5, endRadius: 1.5, roundCap: true });
  addSphereRaw({ center: [20, 20, 0], radius: 2 });

  const reference = raw.Voxels_hCreate(lib);
  raw.Voxels_RenderLattice(lib, reference, perElement);

  assert.equal(batched.toVoxels().volume, raw.Voxels_fCalculateVolume(lib, reference));
  assert.equal(batched.memUsage, Number(raw.Lattice_nMemUsage(lib, perElement)));

  raw.Voxels_Destroy(lib, reference);
  raw.Lattice_Destroy(lib, perElement);
  pk.module._free(scratch);
});

test('SK-0.3 — pending authoring flushes through the handle escape hatch', () => {
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-6, 0, 0], end: [6, 0, 0], radius: 2 });
  // withLattice reads `handle`, which is the only place the batch can be seen from.
  const rendered = pk.createVoxels({ shape: 'empty' }).withLattice(lattice);
  assert.ok(rendered.isInside([0, 0, 0]), 'beams staged before the render must be in it');

  lattice.dispose();
  assert.equal(lattice.handle, lattice.handle, 'handle after dispose flushes nothing');
});

test('polyline: vertices, count, color round-trip, bounds', () => {
  const line = pk.createPolyLine({ color: [1, 0.25, 0, 0.5] });
  assert.equal(line.addVertex([0, 0, 0]), 0);
  assert.equal(line.addVertex([1, 2, 0]), 1);
  line.addVertices([[2, 4, 0], [3, 6, 1]]);
  assert.equal(line.vertexCount, 4);
  assert.deepEqual(line.vertices[2], [2, 4, 0]);

  const [r, g, b, a] = line.color;
  assert.equal(r, 1);
  assert.equal(g, 0.25);
  assert.equal(b, 0);
  assert.equal(a, 0.5);

  const bounds = line.bounds();
  assert.deepEqual(bounds.min, [0, 0, 0]);
  assert.deepEqual(bounds.max, [3, 6, 1]);
  assert.ok(line.memUsage > 0);
});

test('polyline color defaults to opaque white', () => {
  const line = pk.createPolyLine();
  assert.deepEqual(line.color, [1, 1, 1, 1]);
});
