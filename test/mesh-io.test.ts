// R16 — SG7 STL IO: binary format bytes, UNITS= header written/honoured per unit,
// round-trip payload parity, ASCII detect-and-reject, empty reject; plus
// mesh.toGlb() container checks.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, meshToStlBytes, PicoError, type Pico } from '../src/index.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

const TETRA = {
  vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};

const headerText = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 80));

test('binary layout: header, count, 50-byte records, attribute zero', () => {
  const mesh = pk.createMesh(TETRA);
  const stl = mesh.toStl();
  assert.equal(stl.length, 84 + 4 * 50);

  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getUint32(80, true), 4, 'triangle count');
  assert.match(headerText(stl), /^PicoGK UNITS=mm/);
  for (let t = 0; t < 4; t++) {
    assert.equal(view.getUint16(84 + t * 50 + 48, true), 0, 'attribute byte count');
    // Normal is unit length.
    const nx = view.getFloat32(84 + t * 50, true);
    const ny = view.getFloat32(84 + t * 50 + 4, true);
    const nz = view.getFloat32(84 + t * 50 + 8, true);
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, `normal length ${Math.hypot(nx, ny, nz)}`);
  }
});

test('UNITS= header written per unit, exactly as upstream (note " m" for metres)', () => {
  const mesh = pk.createMesh(TETRA);
  for (const [unit, token] of [
    ['mm', 'UNITS=mm'],
    ['cm', 'UNITS=cm'],
    ['m', 'UNITS= m'],
    ['ft', 'UNITS=ft'],
    ['in', 'UNITS=in'],
  ] as const) {
    assert.match(headerText(mesh.toStl({ unit })), new RegExp(`^PicoGK ${token}`), unit);
  }
});

test('round-trip payload parity: mm STL re-imports bit-identically (deindexed)', () => {
  const mesh = pk.createMesh(TETRA);
  const back = pk.meshFromStl(mesh.toStl());
  assert.equal(back.triangleCount, mesh.triangleCount);
  assert.equal(back.vertexCount, mesh.triangleCount * 3, 'STL carries no indexing — 3 vertices per triangle');

  // Every re-imported corner must be bit-equal to the source corner it deindexes.
  const source = mesh.vertices;
  const triangles = mesh.triangles;
  const imported = back.vertices;
  for (let t = 0; t < triangles.length; t++) {
    const s = triangles[t]! * 3;
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(imported[t * 3 + axis], source[s + axis], `corner ${t} axis ${axis}`);
    }
  }
});

test('per-unit scaling round-trips through the header (cm shrinks 10x, honoured back)', () => {
  const mesh = pk.createMesh(TETRA);
  const cm = mesh.toStl({ unit: 'cm' });
  const view = new DataView(cm.buffer, cm.byteOffset, cm.byteLength);
  // First triangle (0,2,1): corner B is vertex 2 = (0,10,0)mm -> (0,1,0)cm.
  assert.equal(view.getFloat32(84 + 12 + 3 * 4 + 4, true), 1, '10mm stored as 1cm');

  // AUTO import honours the header and restores mm.
  const back = pk.meshFromStl(cm);
  const bounds = back.bounds();
  assert.deepEqual(bounds.max, [10, 10, 10], 'cm units scaled back to mm on import');

  // Explicit unit override beats the header.
  const asMm = pk.meshFromStl(cm, { unit: 'mm' });
  assert.deepEqual(asMm.bounds().max, [1, 1, 1], 'explicit mm reads the raw numbers');
});

test('scale/offset options apply in upstream order', () => {
  const mesh = pk.createMesh(TETRA);
  const stl = mesh.toStl({ offset: [1, 0, 0], scale: 2 }); // (v + offset) * scale
  const back = pk.meshFromStl(stl);
  assert.deepEqual(back.bounds().max, [22, 20, 20]);

  const imported = pk.meshFromStl(mesh.toStl(), { scale: 2, offset: [1, 0, 0] }); // v * scale + offset
  assert.deepEqual(imported.bounds().max, [21, 20, 20]);
});

test('meshToStlBytes (public entry) serialises raw arrays byte-identically to mesh.toStl()', () => {
  const vertices = new Float32Array(TETRA.vertices);
  const triangles = new Uint32Array(TETRA.triangles);
  const mesh = pk.createMesh(TETRA);
  assert.deepEqual(meshToStlBytes(vertices, triangles), mesh.toStl(), 'default mm');
  assert.deepEqual(
    meshToStlBytes(vertices, triangles, { unit: 'cm', scale: 2, offset: [1, 0, 0] }),
    mesh.toStl({ unit: 'cm', scale: 2, offset: [1, 0, 0] }),
    'options follow the wrapper',
  );

  const fast = meshToStlBytes(vertices, triangles, { acceptLane: 'fast' }, 'fast');
  assert.match(headerText(fast), /^PicoGK UNITS=mm LANE=fast {2}/, 'lane stamp only when asked');
  assert.deepEqual(fast.subarray(80), mesh.toStl().subarray(80), 'the stamp changes the header only');
  assert.equal(pk.meshFromStl(fast).lane, 'fast');

  assert.throws(
    () => meshToStlBytes(vertices, triangles, { unit: 'auto' }),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT',
  );
});

test('ASCII STL is detected and rejected with remediation', () => {
  const ascii = new TextEncoder().encode(
    'solid cube\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid cube\n' +
      ' '.repeat(200),
  );
  try {
    pk.meshFromStl(ascii);
    assert.fail('ASCII STL accepted');
  } catch (error) {
    assert.ok(error instanceof PicoError);
    assert.equal(error.code, 'PICO_INVALID_ARGUMENT');
    assert.match(error.message, /ASCII/);
  }
});

test('empty and truncated STLs are rejected', () => {
  const mesh = pk.createMesh(TETRA);
  const good = mesh.toStl();

  const zeroCount = good.slice(0, 84);
  new DataView(zeroCount.buffer).setUint32(80, 0, true);
  assert.throws(() => pk.meshFromStl(zeroCount), /empty/);

  assert.throws(() => pk.meshFromStl(good.slice(0, 40)), /too short/);
  assert.throws(() => pk.meshFromStl(good.slice(0, 100)), /truncated/);
});

test('toGlb: valid container with accessor counts (carried over)', () => {
  const mesh = pk.createMesh(TETRA);
  const glb = mesh.toGlb();
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, 'GLB magic');
  assert.equal(view.getUint32(4, true), 2, 'GLB version');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'length header');
  const jsonLen = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  assert.equal(gltf.accessors[0].count, 4, 'POSITION accessor count');
  assert.equal(gltf.accessors[1].count, 12, 'index accessor count');
  assert.deepEqual(gltf.accessors[0].max, [10, 10, 10]);
});

// TAU-E1 — the bytes own a plain ArrayBuffer at the type level, so a host hands
// them to a Blob, a transfer list or a file write without a defensive copy
// (Tau's kernel used Uint8Array.from for exactly that). The assignment below is
// the type-level check; the runtime checks pin the buffer kind and extent.
test('meshToStlBytes returns Uint8Array<ArrayBuffer> that owns its whole buffer', () => {
  const bytes: Uint8Array<ArrayBuffer> = meshToStlBytes(
    new Float32Array(TETRA.vertices),
    new Uint32Array(TETRA.triangles),
  );
  assert.ok(bytes.buffer instanceof ArrayBuffer);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.byteLength, bytes.buffer.byteLength);
  assert.deepEqual(bytes, pk.createMesh(TETRA).toStl(), 'bytes unchanged');
});
