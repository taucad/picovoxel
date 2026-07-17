// Tier-1 smoke suite (S1–S5) — the Phase-1 conformance gate.
// node:test + node:assert only; no framework, no fixtures.
//
// S4 is the one that matters: it cannot be faked by a stub, because a triangle
// count > 0 means OpenVDB actually ran. S1/S2/S3 prove the ABI is wired; S5 is
// the original PoC target (gear -> GLB) and touches ZERO voxels by design.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { loadPicoGK } from '../src/raw.mjs';
import { buildGearMesh, GEAR_DEFAULTS } from '../src/gear.ts';
import { createGlb } from '../src/glb.ts';

const pk = await loadPicoGK();
const OUT = process.env.TIER1_OUT ?? null;

test('S1 — instance lifecycle; openvdb::initialize() survived', () => {
  const lib = pk.createInstance(0.5);
  assert.notEqual(lib, 0n, 'Library_hCreateInstance returned a null handle');
  assert.equal(typeof lib, 'bigint', 'PKHANDLE should cross as BigInt (WASM_BIGINT)');

  // Every counter must start clean, or the instance is born leaking.
  for (const [name, n] of Object.entries(pk.allocated(lib))) {
    assert.equal(n, 0, `${name} should be 0 on a fresh instance`);
  }
  pk.destroyInstance(lib);
});

test('S2 — string marshalling out of wasm', () => {
  const name = pk.name();
  const version = pk.version();
  const build = pk.buildInfo();

  // Library_GetName returns strName() ("PicoGK Core Library"), NOT PICOGK_LIB_NAME.
  // Debug builds append " (Debug Version)" (PicoGKLibraryMgr.h:130), so match, don't equal.
  assert.match(name, /^PicoGK Core Library/, `unexpected library name: ${name}`);
  assert.match(version, /^\d+\.\d+\.\d+$/, `unexpected version: ${version}`);
  assert.ok(build.length > 0, 'build info should be non-empty');
  // Strings must terminate inside PKINFOSTRINGLEN, not run into adjacent heap.
  assert.ok(name.length < 255 && version.length < 255 && build.length < 255);
});

test('S3 — mm <-> voxel round trip', () => {
  const voxelSize = 0.5;
  const lib = pk.createInstance(voxelSize);

  const v = pk.mmToVoxels(lib, 10, 20, 30);
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));

  const mm = pk.voxelsToMm(lib, v.x, v.y, v.z);
  for (const [axis, expected] of [['x', 10], ['y', 20], ['z', 30]]) {
    assert.ok(Math.abs(mm[axis] - expected) < 1e-3,
      `round trip ${axis}: ${mm[axis]} != ${expected}`);
  }

  // The conversion must actually scale by the voxel size, not pass through.
  assert.ok(Math.abs(v.x - 10 / voxelSize) < 1e-3, `mmToVoxels ignored voxel size: ${v.x}`);
  pk.destroyInstance(lib);
});

test('S4 — sphere -> Mesh_hCreateFromVoxels -> triangles > 0 (OpenVDB actually ran)', () => {
  const lib = pk.createInstance(0.5);
  const sphere = pk.sphere(lib, [0, 0, 0], 10);
  assert.notEqual(sphere, 0n, 'Voxels_hCreateSphere returned null');

  const mesh = pk.meshFromVoxels(lib, sphere);
  assert.ok(pk.meshIsValid(lib, mesh), 'mesh handle invalid');

  const tris = pk.triangleCount(lib, mesh);
  const verts = pk.vertexCount(lib, mesh);
  assert.ok(tris > 0, `THE GATE: triangle count was ${tris}`);
  assert.ok(verts > 0, `vertex count was ${verts}`);

  // A stub returning a constant would pass "> 0"; check the geometry is a sphere.
  // Marching cubes under-reports slightly vs the analytic 4/3*pi*r^3 = 4189mm^3.
  const volume = pk.volume(lib, sphere);
  const analytic = (4 / 3) * Math.PI * 10 ** 3;
  assert.ok(Math.abs(volume - analytic) / analytic < 0.02,
    `sphere volume ${volume} is not within 2% of analytic ${analytic}`);

  pk.destroyMesh(lib, mesh);
  pk.destroyVoxels(lib, sphere);
  const leaked = pk.allocated(lib);
  assert.equal(leaked.Voxels, 0, 'leaked voxels');
  assert.equal(leaked.Meshes, 0, 'leaked meshes');
  pk.destroyInstance(lib);
});

test('S5 — involute gear -> GLB bytes (the original PoC target)', async () => {
  const lib = pk.createInstance(0.5);
  const { mesh, outlineCount } = buildGearMesh(pk, lib);

  const verts = pk.vertexCount(lib, mesh);
  const tris = pk.triangleCount(lib, mesh);
  // Two rings (top+bottom) of the outline, and every profile point is distinct.
  assert.equal(verts, outlineCount * 2, `expected ${outlineCount * 2} vertices, got ${verts}`);
  assert.ok(tris > 0, 'gear produced no triangles');

  const { vertices, indices } = pk.readMesh(lib, mesh);
  assert.equal(indices.length, tris * 3);
  assert.ok(indices.every((i) => i < verts), 'index out of range');

  const glb = createGlb(vertices, indices);
  // Validate the container rather than trusting the writer.
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, 'bad GLB magic');
  assert.equal(view.getUint32(4, true), 2, 'bad GLB version');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'GLB length header != actual size');
  assert.equal(view.getUint32(16, true), 0x4e4f534a, 'first chunk should be JSON');

  const jsonLen = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  assert.equal(gltf.accessors[0].count, verts, 'POSITION accessor count mismatch');
  assert.equal(gltf.accessors[1].count, tris * 3, 'index accessor count mismatch');

  // The gear must be the size it was asked to be: outer radius = m*(teeth/2 + 1).
  const outerRadius = GEAR_DEFAULTS.module * (GEAR_DEFAULTS.teeth / 2 + 1);
  const [maxX, maxY, maxZ] = gltf.accessors[0].max;
  assert.ok(Math.abs(maxX - outerRadius) < 0.2, `gear radius ${maxX} != ${outerRadius}`);
  assert.ok(Math.abs(maxY - outerRadius) < 0.2, `gear radius ${maxY} != ${outerRadius}`);
  assert.ok(Math.abs(maxZ - GEAR_DEFAULTS.width / 2) < 1e-3, `gear half-width ${maxZ}`);

  if (OUT) await writeFile(OUT, glb);

  pk.destroyMesh(lib, mesh);
  assert.equal(pk.allocated(lib).Meshes, 0, 'leaked meshes');
  pk.destroyInstance(lib);
});
