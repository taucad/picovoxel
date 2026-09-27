// R6 — the hidden disposal facade: invariants D1–D6 with a fake registry
// (deterministic), then real-GC integration with PicoGK's own allocation counters
// as the oracle (disposal-facade doc, test strategy).

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMemoryWarning, expectHandle } from '../src/context.ts';
import { PicoError } from '../src/errors.ts';
import { createPico } from '../src/index.ts';
import { createFakeRegistry, gcUntil } from './helpers.ts';

const DISPOSE_SYMBOL = Symbol.for('Symbol.dispose');

test('D5/D6 — every wrapper registers exactly once and aliases [Symbol.dispose] to dispose', async () => {
  const fake = createFakeRegistry();
  const pk = await createPico({ registry: fake });
  assert.equal(fake.registered, 1, 'session itself must be registered');

  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const mesh = sphere.toMesh();
  assert.equal(fake.registered, 3, 'sphere and mesh must each register once');

  for (const wrapper of [pk, sphere, mesh] as unknown as Record<symbol, unknown>[]) {
    const viaSymbol = wrapper[Symbol.dispose] ?? wrapper[DISPOSE_SYMBOL];
    assert.equal(
      viaSymbol,
      (wrapper as { dispose?: unknown }).dispose,
      '[Symbol.dispose] must BE dispose (D6)',
    );
  }
  pk.dispose();
});

test('D1 — held values carry only primitives + the free cwrap, never the wrapper', async () => {
  const fake = createFakeRegistry();
  const pk = await createPico({ registry: fake });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });

  const entry = fake.entries.get(sphere);
  assert.ok(entry, 'the wrapper itself must be the unregister token (D2 prerequisite)');
  assert.deepEqual(Object.keys(entry.held).sort(), ['free', 'handle', 'lib']);
  assert.equal(entry.held.lib, pk.handle);
  assert.equal(entry.held.handle, sphere.handle);
  assert.equal(typeof entry.held.free, 'function');
  for (const value of Object.values(entry.held)) {
    assert.notEqual(
      value as unknown,
      sphere,
      'held must not reference the wrapper (would never be collected)',
    );
  }
  pk.dispose();
});

test('D2 — explicit dispose unregisters first; the GC path can never double-free', async () => {
  const fake = createFakeRegistry();
  const pk = await createPico({ registry: fake });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });

  assert.ok(fake.entries.has(sphere));
  sphere.dispose();
  assert.ok(!fake.entries.has(sphere), 'dispose() must unregister its token');
  assert.equal(pk.allocated.voxels, 0, 'the handle must actually be freed');
  assert.throws(() => fake.collect(sphere), /not registered/, 'a late GC callback has nothing to fire');
  pk.dispose();
});

test('GC-callback path (driven by hand) frees the native handle', async () => {
  const fake = createFakeRegistry();
  const pk = await createPico({ registry: fake });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  assert.equal(pk.allocated.voxels, 1);

  fake.collect(sphere); // what a real collection would do
  assert.equal(pk.allocated.voxels, 0, 'collect must free through the held cwrap');
  pk.dispose();
});

test('D3 — dispose is idempotent on every wrapper type', async () => {
  const pk = await createPico();
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const mesh = sphere.toMesh();
  for (const wrapper of [mesh, sphere]) {
    wrapper.dispose();
    wrapper.dispose(); // no-op, not a double free
  }
  assert.equal(pk.allocated.voxels, 0);
  assert.equal(pk.allocated.meshes, 0);
  const use = () => sphere.volume;
  const error = (() => {
    try {
      use();
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof PicoError && error.code === 'PICO_DISPOSED');
  pk.dispose();
  pk.dispose(); // session dispose idempotent too
});

test('D4 — session teardown wins: wrapper dispose after session death is a safe no-op', async () => {
  const pk = await createPico();
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  pk.dispose(); // destroys the instance and everything it owns
  assert.doesNotThrow(() => sphere.dispose(), 'late wrapper dispose must consult the dead flag, not the ABI');
});

test('real GC integration — dropped wrappers are reclaimed (counter oracle)', async () => {
  const pk = await createPico({ voxelSize: 1.5 });
  const N = 20;
  const allocate = () => {
    for (let i = 0; i < N; i++) pk.createVoxels({ shape: 'sphere', radius: 3 });
  };
  allocate();
  assert.equal(pk.allocated.voxels, N, 'all spheres alive before GC');

  const reclaimed = await gcUntil(() => pk.allocated.voxels < N);
  assert.ok(reclaimed, `GC never reclaimed any of ${N} dropped Voxels wrappers`);
  pk.dispose();
});

test('memory warning: threshold, 1/s throttle, fires once, disableable', () => {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warns.push(message);
  try {
    let t = 5000;
    let mem = 0n;
    const warn = createMemoryWarning({ memoryWarningBytes: 100, now: () => t, totalMemUsage: () => mem });
    warn(); // checks: under threshold
    mem = 200n;
    warn(); // throttled — same second
    assert.equal(warns.length, 0);
    t = 6100;
    warn(); // rechecks: over threshold -> warns
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /memoryWarningBytes/);
    t = 9000;
    warn(); // already warned -> silent forever
    assert.equal(warns.length, 1);

    const disabled = createMemoryWarning({
      memoryWarningBytes: 0,
      now: () => 1e9,
      totalMemUsage: () => 10n ** 12n,
    });
    disabled();
    assert.equal(warns.length, 1, 'memoryWarningBytes: 0 must disable the warning');
  } finally {
    console.warn = original;
  }
});

test('memory warning is wired into the factories', async () => {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warns.push(message);
  try {
    let t = 10_000;
    const pk = await createPico({ memoryWarningBytes: 1, now: () => (t += 2000) });
    pk.createVoxels({ shape: 'sphere', radius: 8 }); // pushes native mem over 1 byte
    pk.createVoxels({ shape: 'sphere', radius: 8 });
    assert.equal(warns.length, 1, 'factory calls must sample the warning exactly once past threshold');
    pk.dispose();
  } finally {
    console.warn = original;
  }
});

test('expectHandle — SG14: null handles become PICO_ALLOC_FAILED', () => {
  assert.equal(expectHandle('X', 42n), 42n);
  const error = (() => {
    try {
      expectHandle('Voxels_hCreate', 0n);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof PicoError);
  assert.equal(error.code, 'PICO_ALLOC_FAILED');
  assert.match(error.message, /Voxels_hCreate/);
});
