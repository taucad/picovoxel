// R13 — render/mask/query surface: analytic sphere query oracles, null-returns,
// dimensions/slice geometry, SG8 slice-mode invariants, the gyroid-in-sphere mask
// idiom, and the pure with* renderers.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPicoGK, type PicoGK } from '../src/index.ts';

let pk: PicoGK;
beforeAll(async () => {
  pk = await createPicoGK({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

const sphere = (radius: number) => pk.createVoxels({ shape: 'sphere', radius });

test('isInside / surfaceNormal / closestPointOnSurface / raycastToSurface vs analytic sphere', () => {
  const body = sphere(10);

  assert.equal(body.isInside([0, 0, 0]), true, 'centre inside');
  assert.equal(body.isInside([50, 0, 0]), false, 'far point outside');

  const hit = body.raycastToSurface([-50, 0, 0], [1, 0, 0]);
  assert.ok(hit, 'ray aimed at the sphere must hit');
  assert.ok(Math.abs(hit[0] + 10) < 0.5, `hit x=${hit[0]}, expected ≈ −10`);

  const normal = body.surfaceNormal(hit);
  assert.ok(Math.abs(Math.abs(normal[0]) - 1) < 0.1, `normal at (−10,0,0) should be ±x, got ${normal}`);

  const closest = body.closestPointOnSurface([30, 0, 0]);
  assert.ok(closest, 'closest point must exist on a non-empty field');
  assert.ok(Math.abs(closest[0] - 10) < 0.5, `closest x=${closest[0]}, expected ≈ 10`);
});

test('null returns: empty field has no closest point; a miss has no hit', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  assert.equal(empty.closestPointOnSurface([1, 2, 3]), null, 'empty field -> null');

  const body = sphere(5);
  assert.equal(body.raycastToSurface([-50, 30, 0], [1, 0, 0]), null, 'parallel miss -> null');
});

test('dimensions / sliceCount / sliceOrigin describe the voxel grid', () => {
  const body = sphere(10);
  const { origin, size } = body.dimensions();
  // r=10mm at 0.5mm ≈ 40 cells + narrow band per axis.
  for (const n of size) assert.ok(n > 38 && n < 56, `extent ${n} implausible for r=10 @ 0.5`);
  for (const o of origin) assert.ok(Number.isInteger(o));

  assert.equal(body.sliceCount, size[2]);

  const bottom = body.sliceOrigin(0);
  const top = body.sliceOrigin(body.sliceCount - 1);
  assert.ok(Math.abs(bottom[2]! - -top[2]!) < 1.5, `slice origins should straddle the sphere symmetrically: ${bottom[2]} vs ${top[2]}`);
  assert.ok(bottom[2]! < -9 && bottom[2]! > -12, `bottom slice z=${bottom[2]}`);
});

test('SG8 — slice modes: sdf raw floats, bw ∈ {0,1}, antialiased ∈ [0,1]', () => {
  const body = sphere(10);
  const mid = Math.floor(body.sliceCount / 2);

  const sdf = body.getSlice({ index: mid });
  assert.ok(sdf.data.some((v) => v < 0), 'mid slice must contain interior (negative) samples');
  assert.ok(sdf.data.some((v) => v > 0), 'and exterior samples');
  assert.ok(sdf.background > 0, 'background is the outside band value');

  const bw = body.getSlice({ index: mid, mode: 'bw' });
  assert.ok(bw.data.every((v) => v === 0 || v === 1), 'bw is strictly binary');
  const insideCount = bw.data.filter((v) => v === 0).length;
  // Interior disc ≈ π r² in cells (r = 20 cells): ~1250.
  assert.ok(insideCount > 800, `mid slice inside-count ${insideCount}`);

  const aa = body.getSlice({ index: mid, mode: 'antialiased' });
  assert.ok(aa.data.every((v) => v >= 0 && v <= 1), 'antialiased is normalized');
  assert.ok(aa.data.some((v) => v > 0 && v < 1), 'antialiased has fractional band samples');

  // Extremal slice has (almost) no interior.
  const edge = body.getSlice({ index: 0, mode: 'bw' });
  const edgeInside = edge.data.filter((v) => v === 0).length;
  assert.ok(edgeInside < insideCount / 10, `extremal slice inside-count ${edgeInside}`);
});

test('slice axes: width/height follow the axis mapping', () => {
  const beam = pk.createVoxels({ shape: 'beam', start: [-15, 0, 0], end: [15, 0, 0], radius: 4 });
  const { size } = beam.dimensions();
  const [nx, ny, nz] = size;

  const z = beam.getSlice({ index: 0, axis: 'z' });
  assert.deepEqual([z.width, z.height], [nx, ny]);
  const y = beam.getSlice({ index: 0, axis: 'y' });
  assert.deepEqual([y.width, y.height], [nx, nz]);
  const x = beam.getSlice({ index: 0, axis: 'x' });
  assert.deepEqual([x.width, x.height], [ny, nz]);

  // The beam runs along X: a mid-X slice is a small disc, a mid-Z slice a long strip.
  const midX = beam.getSlice({ index: Math.floor(nx / 2), axis: 'x', mode: 'bw' });
  const midZ = beam.getSlice({ index: Math.floor(nz / 2), axis: 'z', mode: 'bw' });
  const solid = (data: Float32Array) => data.filter((v) => v === 0).length;
  assert.ok(
    solid(midZ.data) > solid(midX.data) * 3,
    `mid-Z strip (${solid(midZ.data)}) must dwarf mid-X disc (${solid(midX.data)})`,
  );
});

test('interpolated Z slice: fractional positions between voxel layers', () => {
  const body = sphere(8);
  const mid = body.sliceCount / 2;
  const a = body.getSlice({ z: mid - 0.5, interpolated: true });
  const b = body.getSlice({ z: mid - 0.25, interpolated: true });
  assert.equal(a.data.length, a.width * a.height);
  assert.ok(a.data.some((v) => v < 0), 'interpolated mid slice has interior');
  assert.notDeepEqual(Array.from(a.data), Array.from(b.data), 'different fractional z -> different samples');
});

test('getSlice range/type validation', () => {
  const body = sphere(5);
  for (const bad of [{ index: -1 }, { index: 10_000 }, { index: 1.5 }]) {
    try {
      body.getSlice(bad as never);
      assert.fail(`getSlice(${JSON.stringify(bad)}) did not throw`);
    } catch (error) {
      assert.equal((error as { code: string }).code, 'PICOGK_INVALID_ARGUMENT');
    }
  }
});

test('withMesh / withLattice render into a clone, purely', () => {
  const base = sphere(6);
  const baseVolume = base.volume;

  const gearish = pk.createMesh({
    vertices: [0, 0, 20, 4, 0, 28, 0, 4, 28, -4, -4, 28],
    triangles: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
  });
  const withMesh = base.withMesh(gearish);
  assert.ok(withMesh.volume > baseVolume, 'mesh content must add volume');
  assert.equal(base.volume, baseVolume, 'receiver untouched');

  const lattice = pk.createLattice();
  lattice.addBeam({ start: [0, 0, -20], end: [0, 0, 20], radius: 2 });
  const withLattice = base.withLattice(lattice);
  assert.ok(withLattice.volume > baseVolume, 'lattice content must add volume');
  assert.equal(withLattice.isInside([0, 0, -15]), true, 'beam present');
  assert.equal(base.isInside([0, 0, -15]), false, 'receiver untouched');
});

test('withImplicit renders the SDF into a clone within bounds', () => {
  const base = sphere(4);
  const augmented = base.withImplicit({
    sdf: (x, y, z) => Math.hypot(x - 10, y, z) - 3,
    boundsMin: [6, -4, -4],
    boundsMax: [14, 4, 4],
  });
  assert.equal(augmented.isInside([10, 0, 0]), true, 'implicit sphere rendered');
  assert.equal(augmented.isInside([0, 0, 0]), true, 'original body kept');
  assert.equal(base.isInside([10, 0, 0]), false, 'receiver untouched');
});

test('maskedByImplicit — the gyroid-in-sphere idiom (SG-grade mask semantics)', () => {
  const ball = sphere(10);
  const s = (2 * Math.PI) / 8;
  const gyroid = (x: number, y: number, z: number) =>
    Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)) - 0.4;

  const masked = ball.maskedByImplicit({ sdf: gyroid });
  assert.ok(masked.volume > 0, 'mask left material');
  assert.ok(masked.volume < ball.volume * 0.8, `mask must carve substantially: ${masked.volume} vs ${ball.volume}`);

  // Masking only re-evaluates EXISTING voxels: nothing may appear outside the ball.
  const outside = masked.subtract(ball);
  assert.equal(outside.isEmpty, true, 'mask must never create material outside the receiver');
  assert.equal(Math.round(ball.volume), Math.round(pk.createVoxels({ shape: 'sphere', radius: 10 }).volume), 'receiver untouched');
});
