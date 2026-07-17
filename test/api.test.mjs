// Phase 2 — R10 (typed errors), R12 (policy-conformant API), R13 (SDF trampoline).
// Facade style (R7): no per-object cleanup — GC reclaims wrappers; only the session
// is disposed at test end. One feature-detected test keeps `using` honest.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPicoGK, PicoGkError } from '../src/index.ts';

/** assert.throws() returns undefined, so capture the error to inspect .code/.message. */
function grab(fn, what = 'call') {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${what} to throw, it did not` });
}

test('R12 — factory, flat options, defaults', async () => {
  const picogk = await createPicoGK();
  assert.equal(picogk.voxelSize, 0.5, 'default voxelSize');
  assert.match(picogk.name, /^PicoGK Core Library/);
  assert.match(picogk.version, /^\d+\.\d+\.\d+$/);
  picogk.dispose();

  const custom = await createPicoGK({ voxelSize: 1.0 });
  assert.equal(custom.voxelSize, 1.0);
  custom.dispose();
});

test('R12 — fluent booleans are pure; operands survive; zero cleanup calls', async () => {
  const picogk = await createPicoGK({ voxelSize: 0.5 });
  const sphere = picogk.createVoxels({ shape: 'sphere', center: [0, 0, 0], radius: 10 });
  const rod = picogk.createVoxels({ shape: 'capsule', start: [0, 0, -20], end: [0, 0, 20], radius: 3 });

  const sphereVolume = sphere.volume;
  const drilled = sphere.subtract(rod);

  // The whole point of copying before the in-place upstream boolean: `sphere` must
  // be untouched, and the result must actually differ from it.
  assert.equal(sphere.volume, sphereVolume, 'subtract() mutated its receiver');
  assert.ok(drilled.volume < sphereVolume, `drilled ${drilled.volume} should be < ${sphereVolume}`);

  const shell = drilled.offset({ distance: -1.5 });
  assert.ok(shell.volume < drilled.volume, 'negative offset should shrink');

  // Facade contract: nothing above was disposed; the session teardown is the story.
  picogk.dispose();
});

test('R12 — mesh exposes typed arrays as caller-owned copies', async () => {
  const picogk = await createPicoGK({ voxelSize: 0.5 });
  const sphere = picogk.createVoxels({ shape: 'sphere', radius: 10 });
  const mesh = sphere.toMesh();
  assert.ok(mesh.vertices instanceof Float32Array);
  assert.ok(mesh.triangles instanceof Uint32Array);
  assert.equal(mesh.vertices.length, mesh.vertexCount * 3);
  assert.equal(mesh.triangles.length, mesh.triangleCount * 3);
  assert.ok(mesh.triangleCount > 0);
  picogk.dispose();
});

test('R7 — native `using` still works for power users (feature-detected)', async () => {
  // The shim guarantees Symbol.dispose exists everywhere; node 24 has it natively.
  assert.equal(typeof Symbol.dispose, 'symbol', 'Symbol.dispose must exist after importing picogk-js');
  const picogk = await createPicoGK({ voxelSize: 0.5 });
  {
    using sphere = picogk.createVoxels({ shape: 'sphere', radius: 10 });
    using mesh = sphere.toMesh();
    assert.ok(mesh.triangleCount > 0);
  }
  // `using` ran both disposers at scope exit — counters prove it.
  assert.equal(picogk.allocated.Voxels, 0, 'leaked Voxels after using-scope');
  assert.equal(picogk.allocated.Meshes, 0, 'leaked Meshes after using-scope');
  picogk.dispose();
});

test('R12 — double dispose is idempotent, not a double free', async () => {
  const picogk = await createPicoGK();
  const sphere = picogk.createVoxels({ shape: 'sphere', radius: 5 });
  sphere.dispose();
  sphere.dispose(); // must be a no-op, not a crash
  assert.equal(picogk.allocated.Voxels, 0);
  picogk.dispose();
});

test('R10 — use after dispose throws PICOGK_DISPOSED, module survives', async () => {
  const picogk = await createPicoGK();
  const sphere = picogk.createVoxels({ shape: 'sphere', radius: 5 });
  sphere.dispose();

  const err = grab(() => sphere.volume, 'volume on a disposed Voxels');
  assert.ok(err instanceof PicoGkError, `expected PicoGkError, got ${err?.constructor?.name}`);
  assert.equal(err.code, 'PICOGK_DISPOSED');
  assert.match(err.message, /already been disposed/);

  // The module must still work afterwards — that is the actual requirement.
  const fresh = picogk.createVoxels({ shape: 'sphere', radius: 5 });
  assert.ok(fresh.volume > 0, 'module unusable after a disposed-handle error');
  picogk.dispose();
});

test('R10 — invalid input throws typed, actionable errors', async () => {
  await assert.rejects(() => createPicoGK({ voxelSize: 0 }), (e) =>
    e instanceof PicoGkError && e.code === 'PICOGK_INVALID_ARGUMENT' && /positive/.test(e.message));

  const picogk = await createPicoGK();
  for (const [options, pattern] of [
    [{ shape: 'sphere', radius: -1 }, /positive radius/],
    [{ shape: 'nope' }, /Unknown shape/],
    [{ shape: 'implicit', sdf: () => 0 }, /boundsMin and boundsMax/],
    [{ shape: 'implicit', boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], sdf: 'not a function' }, /must be a function/],
  ]) {
    const err = grab(() => picogk.createVoxels(options), `createVoxels(${JSON.stringify(options)})`);
    assert.ok(err instanceof PicoGkError, `expected PicoGkError, got ${err?.constructor?.name}`);
    assert.match(err.message, pattern);
    assert.ok(err.code.startsWith('PICOGK_'), `untyped code: ${err.code}`);
  }
  picogk.dispose();
});

test('R10 — a bogus raw handle becomes PICOGK_INVALID_HANDLE, not an opaque throw', async () => {
  const picogk = await createPicoGK();
  const { cwrap } = picogk.module;
  const triangleCount = cwrap('Mesh_nTriangleCount', 'bigint', ['bigint', 'bigint']);

  // Raw (unguarded) path: the C++ throw crosses as an opaque WebAssembly.Exception
  // with no usable message (bare Number under the old JS-EH build). This is the
  // premise R10 exists for — assert it, so the day upstream changes we find out here
  // rather than by shipping a useless wrapper.
  const bare = grab(() => triangleCount(picogk.handle, 999999n), 'raw call with a bogus handle');
  assert.ok(bare instanceof WebAssembly.Exception,
    `premise changed: upstream threw ${bare?.constructor?.name ?? typeof bare}, not a WebAssembly.Exception`);
  assert.equal(bare.message, undefined, 'premise changed: the bare throw now carries a message');

  // Guarded path: same failure through the API is typed and explains itself.
  const sphere = picogk.createVoxels({ shape: 'sphere', radius: 5 });
  const mesh = sphere.toMesh();
  mesh.dispose();
  const typed = grab(() => mesh.vertices, 'vertices on a disposed Mesh');
  assert.ok(typed instanceof PicoGkError);
  assert.equal(typed.code, 'PICOGK_DISPOSED');

  // And the module is still usable after both — the requirement that actually matters.
  const fresh = picogk.createVoxels({ shape: 'sphere', radius: 5 });
  const freshMesh = fresh.toMesh();
  assert.ok(freshMesh.triangleCount > 0, 'module unusable after handle errors');
  picogk.dispose();
});

test('R13 — implicit SDF: a sphere from a JS callback matches the native primitive', async () => {
  const picogk = await createPicoGK({ voxelSize: 0.5 });

  let calls = 0;
  const implicitSphere = picogk.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: (x, y, z) => { calls++; return Math.sqrt(x * x + y * y + z * z) - 10; },
  });

  assert.ok(calls > 1000, `SDF should be sampled per voxel, got ${calls} calls`);

  // The oracle: PicoGK's own native sphere. If the trampoline mangles coordinates or
  // return values, the volumes diverge — "> 0" would not catch that.
  const nativeSphere = picogk.createVoxels({ shape: 'sphere', center: [0, 0, 0], radius: 10 });
  const ratio = implicitSphere.volume / nativeSphere.volume;
  assert.ok(Math.abs(ratio - 1) < 0.02,
    `implicit volume ${implicitSphere.volume} vs native ${nativeSphere.volume} (ratio ${ratio.toFixed(4)})`);

  const mesh = implicitSphere.toMesh();
  assert.ok(mesh.triangleCount > 0, 'implicit sphere produced no triangles');
  picogk.dispose();
});

test('R13 — gyroid: the capability implicit CAD exists for', async () => {
  const picogk = await createPicoGK({ voxelSize: 0.6 });
  const period = 10;
  const s = (2 * Math.PI) / period;

  const gyroid = picogk.createVoxels({
    shape: 'implicit',
    boundsMin: [-15, -15, -15],
    boundsMax: [15, 15, 15],
    // TPMS gyroid, thickened into a shell by the abs()-minus-thickness trick.
    sdf: (x, y, z) => {
      const g = Math.sin(x * s) * Math.cos(y * s)
              + Math.sin(y * s) * Math.cos(z * s)
              + Math.sin(z * s) * Math.cos(x * s);
      return Math.abs(g) - 0.4;
    },
  });

  const mesh = gyroid.toMesh();
  // A gyroid is a single connected, highly convoluted surface: it must produce far
  // more triangles than a sphere in the same box, which is what distinguishes a real
  // TPMS from a trampoline that returned a constant.
  assert.ok(mesh.triangleCount > 10000, `gyroid produced only ${mesh.triangleCount} triangles`);
  assert.ok(gyroid.volume > 0, 'gyroid has no volume');
  picogk.dispose();
});

test('R13 — function table does not leak across repeated implicit renders', async () => {
  const picogk = await createPicoGK({ voxelSize: 1.5 });
  const before = picogk.module.wasmTable?.length;
  for (let i = 0; i < 20; i++) {
    picogk.createVoxels({
      shape: 'implicit',
      boundsMin: [-4, -4, -4], boundsMax: [4, 4, 4],
      sdf: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - 3,
    }).dispose();
  }
  const after = picogk.module.wasmTable?.length;
  if (before !== undefined && after !== undefined) {
    assert.ok(after - before < 20, `function table grew by ${after - before} over 20 renders (removeFunction not reclaiming)`);
  }
  picogk.dispose();
});
