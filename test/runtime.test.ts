// TAU-L1 / D31 (picovoxel production close-out) — createPicoRuntime: one module
// (and, on /multi, one warm pthread pool) shared by many sessions, each its own
// PicoGK Library instance. Covers the borrowed runtime, per-session isolation,
// dispose ordering, the two GC invariants (late frees against a destroyed instance
// are swallowed; handles are never reused), the compile-once instantiation paths,
// the PV-W1 voxel-unit warm-up, and pool reuse across sessions.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';
import { WASM_EXPORTS as MULTI_EXPORTS } from '../src/pico-multi.exports.ts';
import createMultiGlue from '../src/pico-multi.mjs';
import { WASM_EXPORTS as PICO_EXPORTS } from '../src/pico.exports.ts';
import createSerialGlue from '../src/pico.mjs';
import { bindPicoRaw } from '../src/raw.generated.ts';
import { freeHeld } from '../src/registry.ts';
import {
  createPicoSession,
  openPicoRuntime,
  warmPool,
  warmUpOp,
  WARM_OFFSET_VOXELS,
  WARM_RADIUS_VOXELS,
  type Pico,
  type PicoGlueFactory,
  type PicoRuntime,
} from '../src/session.ts';
import type { PicoWasmModule } from '../src/types.ts';
import { createFakeRegistry, gcUntil, hexFloat } from './helpers.ts';

const serialGlue = createSerialGlue as PicoGlueFactory;
const raiseInvalidHandle = (): never => {
  throw new serialEntry.PicoError('PICO_INVALID_HANDLE', 'late free');
};
const isPicoError = (code: string) => (error: unknown) =>
  error instanceof serialEntry.PicoError && error.code === code;

/** A small model that exercises the per-session voxel size, offset lane and lattice arm. */
function model(pk: Pico): { volume: string; offset: string; lattice: string } {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 6 });
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [0, 0, 0], end: [10, 0, 0], radius: 2 });
  lattice.addBeam({ start: [10, 0, 0], end: [10, 10, 0], radius: 1.5 });
  return {
    volume: hexFloat(sphere.volume),
    offset: sphere.offset({ distance: 1 }).gridHash().hash,
    lattice: lattice.toVoxels().gridHash().hash,
  };
}

test('surface: createPicoRuntime on both entries; a runtime is { createPico, dispose } with [Symbol.dispose]', async () => {
  assert.equal(typeof serialEntry.createPicoRuntime, 'function');
  assert.equal(typeof multiEntry.createPicoRuntime, 'function');
  const runtime = await serialEntry.createPicoRuntime();
  assert.deepEqual(Object.keys(runtime).sort(), ['createPico', 'dispose']);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- identity comparison only; the method is never called detached
  assert.equal((runtime as unknown as Record<symbol, unknown>)[Symbol.dispose], runtime.dispose);
  runtime.dispose();
});

test('isolation: sessions on one runtime keep their own voxel size, lane and lattice arm', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  const shapes = [
    { voxelSize: 0.5 },
    { voxelSize: 0.4, lane: 'fast' as const },
    { voxelSize: 0.4, lane: 'exact' as const, serialLattice: true },
    { voxelSize: 0.7, fastRenorm: true },
  ];
  const borrowed = await Promise.all(shapes.map((options) => runtime.createPico(options)));
  try {
    assert.ok(
      borrowed.every((pk) => pk.module === borrowed[0]!.module),
      'one module under every session',
    );
    assert.equal(
      new Set(borrowed.map((pk) => pk.handle)).size,
      shapes.length,
      'one Library instance per session',
    );
    assert.deepEqual(
      borrowed.map((pk) => [pk.voxelSize, pk.lane]),
      [
        [0.5, 'open'],
        [0.4, 'fast'],
        [0.4, 'exact'],
        [0.7, 'open'],
      ],
    );
    // Each borrowed session builds exactly what a standalone session with the same
    // options builds — interleaved, so any state leaking between instances shows.
    const results = borrowed.map(model);
    for (const [i, options] of shapes.entries()) {
      const own = await serialEntry.createPico(options);
      try {
        assert.deepEqual(results[i], model(own), `session ${i} matches its standalone twin`);
      } finally {
        own.dispose();
      }
    }
    assert.notEqual(results[0]!.offset, results[3]!.offset, 'fastRenorm stays per session');
    assert.notEqual(results[1]!.lattice, results[2]!.lattice, 'serialLattice stays per session');

    // SG10 still holds between sessions that share a module.
    const a = borrowed[0]!.createVoxels({ shape: 'sphere', radius: 2 });
    const b = borrowed[3]!.createVoxels({ shape: 'sphere', radius: 2 });
    assert.throws(() => a.union(b), isPicoError('PICO_SESSION_MISMATCH'));
  } finally {
    runtime.dispose();
  }
});

test('session dispose frees only its own instance; siblings and the runtime carry on', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  const a = await runtime.createPico({ voxelSize: 0.5 });
  const b = await runtime.createPico({ voxelSize: 0.5 });
  const kept = b.createVoxels({ shape: 'sphere', radius: 4 });
  const volume = kept.volume;
  a.createVoxels({ shape: 'sphere', radius: 4 });
  a.dispose();
  assert.throws(() => a.createVoxels({ shape: 'empty' }), isPicoError('PICO_DISPOSED'));
  assert.equal(b.allocated.voxels, 1, 'the sibling keeps its objects');
  assert.equal(kept.volume, volume);
  const c = await runtime.createPico();
  assert.equal(c.module, b.module, 'the runtime still opens sessions');
  runtime.dispose();
});

test('handles are never reused: within a session, and across sessions on one runtime', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  const a = await runtime.createPico();
  const first = a.createVoxels({ shape: 'sphere', radius: 2 });
  const firstHandle = first.handle;
  first.dispose();
  const second = a.createVoxels({ shape: 'sphere', radius: 2 });
  assert.ok(second.handle > firstHandle, 'a freed handle is never reissued');

  // Object handles restart per instance, but instance handles never repeat, so a
  // stale wrapper from a disposed session can only fail — never reach a sibling's
  // object that happens to carry the same number.
  const stale = a.createVoxels({ shape: 'sphere', radius: 3 });
  a.dispose();
  const b = await runtime.createPico();
  assert.ok(b.handle > a.handle, 'Library instance handles only grow');
  let victim = b.createVoxels({ shape: 'sphere', radius: 5 });
  while (victim.handle < stale.handle) victim = b.createVoxels({ shape: 'sphere', radius: 5 });
  assert.equal(victim.handle, stale.handle, 'the same object number, in a different instance');
  const victimVolume = victim.volume;
  assert.throws(() => stale.volume, isPicoError('PICO_INVALID_HANDLE'));
  assert.equal(victim.volume, victimVolume, "the sibling's object is untouched");
  runtime.dispose();
});

test('runtime dispose: open sessions first (they refuse use), then idempotent; late disposes are no-ops', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  const pk = await runtime.createPico();
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 3 });
  runtime.dispose();
  assert.throws(() => pk.createVoxels({ shape: 'empty' }), isPicoError('PICO_DISPOSED'));
  assert.throws(() => pk.allocated, isPicoError('PICO_DISPOSED'));
  assert.doesNotThrow(() => sphere.dispose(), 'D4: teardown won, the wrapper does not free');
  assert.doesNotThrow(() => pk.dispose(), 'the session was already released by the runtime');
  assert.doesNotThrow(() => runtime.dispose(), 'idempotent');
  await assert.rejects(() => runtime.createPico(), isPicoError('PICO_DISPOSED'));
});

test('late GC frees against a destroyed instance are swallowed', async () => {
  const fake = createFakeRegistry(freeHeld); // collect() goes through the real callback
  const runtime = await serialEntry.createPicoRuntime();
  const pk = await runtime.createPico({ registry: fake });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const held = fake.entries.get(sphere)!.held;
  runtime.dispose();
  assert.doesNotThrow(() => fake.collect(sphere), 'a wrapper free after runtime teardown is harmless');
  assert.doesNotThrow(
    () => freeHeld({ ...held, free: () => raiseInvalidHandle() }),
    'and freeHeld swallows a throwing free',
  );
  assert.doesNotThrow(() => fake.collect(pk), "the session's own GC free is a no-op once released");
});

test('real GC: a dropped session on a live runtime is reclaimed through the runtime registry', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  const probe = await runtime.createPico();
  const raw = bindPicoRaw(probe.module);
  const open = async (): Promise<bigint> => (await runtime.createPico()).handle; // the wrapper dies here
  const lib = await open();
  assert.equal(raw.Library_nVoxelsAllocated(lib), 0n, 'the dropped instance exists before GC');
  const reclaimed = await gcUntil(() => {
    try {
      raw.Library_nVoxelsAllocated(lib);
      return false;
    } catch {
      return true; // the instance is gone
    }
  });
  assert.ok(reclaimed, 'a dropped session must not leak its Library instance on a shared runtime');
  runtime.dispose();
});

test('runtime.createPico takes session options only', async () => {
  const runtime = await serialEntry.createPicoRuntime({ wasm: {} });
  await assert.rejects(() => runtime.createPico({ wasm: {} } as never), isPicoError('PICO_INVALID_ARGUMENT'));
  await assert.rejects(
    () => runtime.createPico({ wasmModule: undefined } as never),
    isPicoError('PICO_INVALID_ARGUMENT'),
  );
  await assert.rejects(() => runtime.createPico({ voxelSize: -1 }), isPicoError('PICO_INVALID_ARGUMENT'));
  await assert.rejects(
    () => runtime.createPico({ lane: 'exact', fastRenorm: true }),
    isPicoError('PICO_LANE_LOOSENED'),
  );
  runtime.dispose();
});

test('compile once: wasmModule and wasm.instantiateWasm both skip the glue fetch+compile', async () => {
  const compiled = await WebAssembly.compile(
    readFileSync(join(import.meta.dirname, '..', 'src', 'pico.wasm')),
  );
  const reference = await serialEntry.createPico();
  const expected = model(reference);
  reference.dispose();

  const fromModule = await serialEntry.createPicoRuntime({ wasmModule: compiled });
  const viaModule = await fromModule.createPico();
  assert.deepEqual(model(viaModule), expected);
  fromModule.dispose();

  // The standalone factory takes the same option.
  const standalone = await serialEntry.createPico({ wasmModule: compiled });
  assert.deepEqual(model(standalone), expected);
  standalone.dispose();

  let calls = 0;
  const hostRuntime = await serialEntry.createPicoRuntime({
    wasm: {
      instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
        calls += 1;
        void WebAssembly.instantiate(compiled, imports).then(receive);
        return {};
      },
    },
  });
  assert.deepEqual(model(await hostRuntime.createPico()), expected);
  assert.equal(calls, 1, "the host's instantiateWasm ran once");
  hostRuntime.dispose();
});

/** Unsigned LEB128, as the wasm binary format encodes counts and sizes. */
function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

/**
 * A wasm module exporting `names` (all aliases of one function). With `unlinkable`
 * the function is an import ("x"."y") no glue provides, so the module passes the
 * export pre-flight and then fails to instantiate.
 */
function moduleExporting(names: readonly string[], unlinkable: boolean): Promise<WebAssembly.Module> {
  const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  const text = (value: string) => [...leb(value.length), ...Array.from(value, (c) => c.charCodeAt(0))];
  const bytes = [
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 0, 0]),
    ...(unlinkable
      ? section(2, [1, ...text('x'), ...text('y'), 0, 0])
      : [...section(3, [1, 0]), ...section(10, [1, 2, 0, 0x0b])]),
    ...section(7, [...leb(names.length), ...names.flatMap((name) => [...text(name), 0, 0])]),
  ];
  return WebAssembly.compile(Uint8Array.from(bytes));
}

const wasmFile = (name: string) => readFileSync(join(import.meta.dirname, '..', 'src', name));

test('compile once: contradictory and non-module inputs are refused before instantiation', async () => {
  const compiled = await WebAssembly.compile(wasmFile('pico.wasm'));
  await assert.rejects(
    () => serialEntry.createPicoRuntime({ wasmModule: compiled, wasm: { instantiateWasm: () => ({}) } }),
    isPicoError('PICO_INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () =>
      serialEntry.createPicoRuntime({ wasmModule: wasmFile('pico.wasm') as unknown as WebAssembly.Module }),
    isPicoError('PICO_INVALID_ARGUMENT'),
  );
});

test('compile once: a module from another build or variant fails the export pre-flight on both entries', async () => {
  const empty = await WebAssembly.compile(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const serialWasm = await WebAssembly.compile(wasmFile('pico.wasm'));
  const multiWasm = await WebAssembly.compile(wasmFile('pico-multi.wasm'));
  const notThisBuild = (error: unknown) =>
    isPicoError('PICO_WASM_INIT_FAILED')(error) && /not this entry's build/.test((error as Error).message);
  for (const [entry, wasmModule] of [
    [serialEntry, empty],
    [multiEntry, empty],
    [multiEntry, serialWasm],
    [serialEntry, multiWasm],
  ] as const) {
    await assert.rejects(() => entry.createPicoRuntime({ wasmModule }), notThisBuild);
  }
  // Pre-flight means the glue never ran: no pthread pool was ever started.
  let calls = 0;
  const glue = Object.assign(
    () => {
      calls += 1;
      return Promise.reject(new Error('unreachable'));
    },
    { wasmExports: ['F'] },
  );
  await assert.rejects(() => openPicoRuntime(glue, { wasmModule: empty }), notThisBuild);
  assert.equal(calls, 0);
  // A bare glue with no recorded list (the bench harnesses' counting glues) skips the pre-flight.
  const bare = await openPicoRuntime(serialGlue, { wasmModule: serialWasm });
  assert.equal((await bare.createPico()).name, 'PicoGK Core Library');
  bare.dispose();
});

test('compile once: an unlinkable module rejects (never hangs) on the serial entry', async () => {
  const unlinkable = await moduleExporting(PICO_EXPORTS, true);
  await assert.rejects(
    () => serialEntry.createPicoRuntime({ wasmModule: unlinkable }),
    isPicoError('PICO_WASM_INIT_FAILED'),
  );
});

test('multi: a module that fails to instantiate leaves no pthread pool behind', async () => {
  let moduleArg: { PThread?: NonNullable<PicoWasmModule['PThread']> } | undefined;
  const glue = Object.assign(
    async (overrides?: object) => {
      moduleArg = overrides;
      return (createMultiGlue as PicoGlueFactory)(overrides);
    },
    { wasmExports: MULTI_EXPORTS },
  );
  const unlinkable = await moduleExporting(MULTI_EXPORTS, true);
  await assert.rejects(
    () => openPicoRuntime(glue, { wasmModule: unlinkable }),
    isPicoError('PICO_WASM_INIT_FAILED'),
  );
  const pool = moduleArg!.PThread!;
  assert.ok(pool, 'the multi glue had started its pool before instantiating');
  assert.equal(pool.runningWorkers.length + pool.unusedWorkers.length, 0, 'every worker was terminated');
});

test('multi: failed instantiations let the process exit (no worker holds it open)', () => {
  // Each scenario runs in a fresh process: one that leaked its pool would never exit
  // on its own and is killed at the timeout instead of exiting 0.
  const entry = pathToFileURL(join(import.meta.dirname, '..', 'src', 'multi.ts')).href;
  const scenarios = {
    'unlinkable wasmModule': `
      const { WASM_EXPORTS } = await import(${JSON.stringify(entry.replace(/multi\.ts$/, 'pico-multi.exports.ts'))});
      const leb = (v) => { const b = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b.push(x); } while (v); return b; };
      const text = (s) => [...leb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
      const section = (id, body) => [id, ...leb(body.length), ...body];
      const exports = [...leb(WASM_EXPORTS.length), ...WASM_EXPORTS.flatMap((n) => [...text(n), 0, 0])];
      const bytes = [0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]),
        ...section(2, [1, ...text('x'), ...text('y'), 0, 0]), ...section(7, exports)];
      return { wasmModule: await WebAssembly.compile(Uint8Array.from(bytes)) };`,
    'missing wasm file': `return { wasm: { locateFile: () => '/nonexistent/pico-multi.wasm' } };`,
  };
  for (const [label, makeOptions] of Object.entries(scenarios)) {
    const child = spawnSync(
      process.execPath,
      [
        // No --input-type: the pthread workers inherit execArgv and refuse it.
        '--no-warnings',
        // Node below 22.18 strips types only behind this flag; the child imports src/*.ts.
        ...(process.features.typescript ? [] : ['--experimental-strip-types']),
        '-e',
        `(async () => {
           const { createPicoRuntime } = await import(${JSON.stringify(entry)});
           const options = await (async () => { ${makeOptions} })();
           try { await createPicoRuntime(options); console.log('resolved'); }
           catch (error) { console.log(error.code); }
         })();`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(child.signal, null, `${label}: the process had to be killed — a leaked pool held it open`);
    assert.equal(child.status, 0, `${label}: ${child.stderr}`);
    assert.equal(child.stdout.trim(), 'PICO_WASM_INIT_FAILED', label);
  }
});

test('createPicoRuntime refuses session options and names runtime.createPico as the remedy', async () => {
  for (const entry of [serialEntry, multiEntry]) {
    await assert.rejects(
      () => entry.createPicoRuntime({ voxelSize: 0.2, lane: 'exact' } as never),
      (error: unknown) =>
        isPicoError('PICO_INVALID_ARGUMENT')(error) &&
        /voxelSize, lane/.test((error as Error).message) &&
        /runtime\.createPico\(options\)/.test((error as Error).message),
    );
  }
});

test('a failed warm-up disposes the runtime before rethrowing', async () => {
  let warmed: PicoRuntime | undefined;
  const failure = new Error('warm-up failed');
  await assert.rejects(
    () =>
      openPicoRuntime(serialGlue, {}, (runtime) => {
        warmed = runtime;
        return Promise.reject(failure);
      }),
    (error) => error === failure,
  );
  await assert.rejects(() => warmed!.createPico(), isPicoError('PICO_DISPOSED'));
});

test('a standalone session that fails to open takes its runtime down with it', async () => {
  let terminated = 0;
  let module: PicoWasmModule | undefined;
  const starved: PicoGlueFactory = async (overrides) => {
    module = await serialGlue(overrides);
    module._malloc = () => 0; // the session scratch allocation fails
    module.PThread = {
      runningWorkers: [],
      unusedWorkers: [],
      terminateAllThreads: () => void (terminated += 1),
    };
    return module;
  };
  await assert.rejects(() => createPicoSession(starved, {}), isPicoError('PICO_OUT_OF_MEMORY'));
  assert.equal(terminated, 1, 'the runtime was disposed, pool join included');
  // The Library instance created before the failed allocation was destroyed too.
  const raw = bindPicoRaw(module!);
  const next = raw.Library_hCreateInstance(0.5);
  assert.throws(() => raw.Library_nVoxelsAllocated(next - 1n), 'the failed session left no instance behind');
  raw.Library_DestroyInstance(next);
});

test('PV-W1: the warm-up op does the same voxel work at every voxel size', async () => {
  const runtime = await serialEntry.createPicoRuntime();
  try {
    const counts: number[] = [];
    for (const voxelSize of [0.02, 0.1, 0.5, 2]) {
      const pk = await runtime.createPico({ voxelSize });
      const warm = warmUpOp(pk);
      counts.push(warm.gridHash().activeVoxels);
      assert.equal(
        pk.allocated.voxels,
        1,
        'the warm-up sphere is freed; only the result the caller owns remains',
      );
      pk.dispose();
    }
    assert.ok(counts[0]! > 0);
    assert.deepEqual(
      new Set(counts).size,
      1,
      `constant active-voxel count across voxel sizes, got ${counts.join(', ')}`,
    );
    assert.deepEqual([WARM_RADIUS_VOXELS, WARM_OFFSET_VOXELS], [4, 1], 'the historical default-size warm-up');
  } finally {
    runtime.dispose();
  }
});

// ── picovoxel/multi: one pool for every session ──

test('multi runtime: N sessions, one module, one pool spawn, workers engaged, serial-identical', async () => {
  const runtime = await multiEntry.createPicoRuntime();
  const serial = await serialEntry.createPico({ voxelSize: 0.5 });
  const expected = model(serial);
  serial.dispose();

  const first = await runtime.createPico({ voxelSize: 0.5 });
  const pool = first.module.PThread!;
  const workers = new Set([...pool.runningWorkers, ...pool.unusedWorkers]);
  assert.ok(pool.runningWorkers.length > 0, 'the runtime warm-up launched the TBB workers');
  let spawned = 0;
  const spawn = (pool as unknown as { allocateUnusedWorker: () => void }).allocateUnusedWorker;
  (pool as unknown as { allocateUnusedWorker: () => void }).allocateUnusedWorker = () => {
    spawned += 1;
    spawn();
  };

  const N = 4;
  for (let i = 0; i < N; i++) {
    const pk = i === 0 ? first : await runtime.createPico({ voxelSize: 0.5 });
    assert.equal(pk.module, first.module, `session ${i} borrows the one module`);
    assert.deepEqual(model(pk), expected, `session ${i} matches the serial oracle`);
    assert.ok(pool.runningWorkers.length > 0, `session ${i} runs on the warm pool`);
    pk.dispose();
    assert.ok(pool.runningWorkers.length > 0, 'session dispose leaves the pool running');
  }
  assert.equal(spawned, 0, 'no worker was spawned after the runtime came up');
  assert.deepEqual(
    new Set([...pool.runningWorkers, ...pool.unusedWorkers]),
    workers,
    'the same workers throughout',
  );

  runtime.dispose();
  assert.equal(
    pool.runningWorkers.length + pool.unusedWorkers.length,
    0,
    'runtime dispose joins the pool (SK-0.4 §10)',
  );
});

test('multi createPico: the standalone session still owns its pool and terminates it on dispose', async () => {
  const pk = await multiEntry.createPico({ voxelSize: 0.5 });
  const pool = pk.module.PThread!;
  assert.ok(pool.runningWorkers.length > 0);
  pk.dispose();
  assert.equal(pool.runningWorkers.length + pool.unusedWorkers.length, 0);
});

test('multi runtime from a compiled module: the module reaches every pthread', async () => {
  const compiled = await WebAssembly.compile(
    readFileSync(join(import.meta.dirname, '..', 'src', 'pico-multi.wasm')),
  );
  const runtime = await multiEntry.createPicoRuntime({ wasmModule: compiled });
  const serial = await serialEntry.createPico({ voxelSize: 0.5 });
  try {
    const pk = await runtime.createPico({ voxelSize: 0.5 });
    assert.ok(
      pk.module.PThread!.runningWorkers.length > 0,
      'workers instantiated the caller-compiled module',
    );
    assert.deepEqual(model(pk), model(serial));
  } finally {
    serial.dispose();
    runtime.dispose();
  }
});

// The pool poll after the warm-up op: deterministic stand-ins for both exits,
// because on a real pool whether the loop body runs at all depends on how fast
// the host's workers launch (CI runners are often ready before the first check).
test('warmPool yields until the pool fills, and stops at the deadline when it never does', async () => {
  const fakeRuntime = (pool: { runningWorkers: unknown[] }) =>
    ({
      createPico: () =>
        Promise.resolve({
          voxelSize: 1,
          module: { PThread: pool },
          createVoxels: () => ({ offset: () => ({ dispose() {} }), dispose() {} }),
          dispose() {},
        } as unknown as Pico),
    }) as unknown as PicoRuntime;

  const wanted = navigator.hardwareConcurrency - 1;
  let checks = 0;
  const filling = {
    get runningWorkers() {
      checks += 1;
      return checks > 2 ? Array.from({ length: wanted }) : [];
    },
  };
  await warmPool(fakeRuntime(filling));
  assert.ok(checks >= 3, 'the poll yielded to the event loop until the workers were running');

  const started = Date.now();
  await warmPool(fakeRuntime({ runningWorkers: [] }));
  assert.ok(
    Date.now() - started >= 100,
    'a pool that never fills releases the caller at the 100 ms deadline',
  );
});
