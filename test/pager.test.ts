// The grid pager's own logic (src/pager.ts) against a scripted module: budget and
// LRU, pins and safe points, the D16 rule, the failure mapping (I2), the far
// store's bytes. The wasm-backed suites (pager-k7.test.ts, pager-identity.test.ts)
// run the same pager on the real park TU.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PicoError } from '../src/errors.ts';
import { createExtentStore, createRamBackend, FarStoreError, type FarStore } from '../src/far/index.ts';
import {
  createPager,
  DEFAULT_BUDGET_BYTES,
  resolvePagerOptions,
  type PagerOptions,
  type PagerRaw,
} from '../src/pager.ts';
import type { PicoWasmModule } from '../src/types.ts';

const MiB = 2 ** 20;

interface Script {
  arena?: bigint;
  park?: (handle: bigint) => bigint | undefined;
  restore?: () => bigint | undefined;
  lastError?: number;
  destroyThrows?: boolean;
  closeThrows?: boolean;
}

/** A fake module: grids are byte strings; park writes them through the sink in two chunks. */
function fakeRuntime(script: Script = {}) {
  const heap = new Uint8Array(1 << 16);
  const functions: Array<((...args: number[]) => number) | undefined> = [];
  const grids = new Map<bigint, { mem: number; content: Uint8Array }>();
  let nextHandle = 100n;
  const calls = { parks: 0, restores: 0, destroys: [] as bigint[], rearms: 0, arena: [] as number[][] };
  const module = {
    HEAPU8: heap,
    addFunction(fn: (...args: number[]) => number) {
      functions.push(fn);
      return functions.length - 1;
    },
    removeFunction(index: number) {
      if (script.closeThrows) throw new Error('module gone');
      functions[index] = undefined;
    },
  } as unknown as PicoWasmModule;
  const raw: PagerRaw = {
    K7_nPark(_lib, handle, transform, codec, level, block, flags, sink) {
      calls.parks++;
      assert.deepEqual([transform, level, block, flags], [4, 1, 512, 1]);
      assert.ok(codec === 0 || codec === 1);
      const scripted = script.park?.(handle);
      if (scripted !== undefined) return scripted;
      const grid = grids.get(handle)!;
      const half = Math.ceil(grid.content.length / 2);
      for (const part of [grid.content.subarray(0, half), grid.content.subarray(half)]) {
        heap.set(part, 64);
        const status = functions[sink]!(64, part.length);
        if (status !== 0) {
          script.lastError = status === 1 ? 1 : 2;
          return -2n;
        }
      }
      return BigInt(grid.content.length);
    },
    K7_hRestore(_lib, source) {
      calls.restores++;
      const scripted = script.restore?.();
      if (scripted !== undefined) return scripted;
      const parts: number[] = [];
      for (;;) {
        const got = functions[source]!(1024, 7);
        if (got < 0) {
          script.lastError = 2;
          return 0n;
        }
        if (got === 0) break;
        parts.push(...heap.subarray(1024, 1024 + got));
      }
      const handle = nextHandle++;
      grids.set(handle, { mem: parts.length * MiB, content: Uint8Array.from(parts) });
      return handle;
    },
    K7_nArena(...args) {
      if (script.closeThrows && args[0] === 0) throw new Error('module gone');
      calls.arena.push(args);
      return script.arena ?? 1000n;
    },
    K7_nRearm() {
      calls.rearms++;
      return 1;
    },
    K7_nLastError: () => script.lastError ?? 0,
    Voxels_nMemUsage: (_lib, handle) => BigInt(grids.get(handle)!.mem),
    Voxels_Destroy(_lib, handle) {
      if (script.destroyThrows) throw new Error('instance gone');
      calls.destroys.push(handle);
      grids.delete(handle);
    },
  };
  /** A grid whose memUsage is `mib` MiB and whose content is `mib` bytes of `fill`. */
  const grid = (mib: number, fill = mib): bigint => {
    const handle = nextHandle++;
    grids.set(handle, { mem: mib * MiB, content: new Uint8Array(mib).fill(fill) });
    return handle;
  };
  return { module, raw, grids, grid, calls, script };
}

function ramStore(maxBytes?: number): FarStore {
  return createExtentStore(createRamBackend({ segmentBytes: 64 * 1024, extentBytes: 1024 }), {
    extentBytes: 1024,
    maxBytes,
  });
}

function pagerOn(
  fake: ReturnType<typeof fakeRuntime>,
  options: PagerOptions = {},
  store = ramStore(),
  threads = 1,
) {
  return createPager({
    module: fake.module,
    raw: fake.raw,
    store,
    threads,
    options: { minParkBytes: 0, ...options },
  });
}

const isCode = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof PicoError && error.code === code && (pattern === undefined || pattern.test(error.message));

test('options: defaults follow the build; bad values are PICO_INVALID_ARGUMENT', () => {
  const serial = resolvePagerOptions({}, 1);
  assert.deepEqual(
    [
      serial.budgetBytes,
      serial.codec,
      serial.mode,
      serial.slots,
      serial.reserveMiB,
      serial.store,
      serial.minParkBytes,
    ],
    [DEFAULT_BUDGET_BYTES, 'lz4', 'serial', 1, 8, 'ram', MiB],
  );
  assert.equal(DEFAULT_BUDGET_BYTES, 2 ** 31);
  const multi = resolvePagerOptions({}, 12);
  assert.deepEqual([multi.mode, multi.slots], ['pipelined', 4]);
  assert.equal(resolvePagerOptions({}, 2).slots, 2);
  const bad: PagerOptions[] = [
    { budgetBytes: -1 },
    { budgetBytes: Number.NaN },
    { codec: 'zstd' as never },
    { mode: 'parallel' as never },
    { arena: { slots: 0 } },
    { arena: { slots: 1.5 } },
    { arena: { slots: 65 } },
    { arena: { reserveMiB: -1 } },
    { arena: { reserveMiB: 2048 } },
    { store: 'opfs' as never },
    { storeMaxBytes: 0 },
  ];
  for (const options of bad)
    assert.throws(() => resolvePagerOptions(options, 1), isCode('PICO_INVALID_ARGUMENT', /^pager: /));
  assert.equal(resolvePagerOptions({ storeMaxBytes: 5, directory: 'd' }, 1).storeMaxBytes, 5);
});

test('the arena is taken at creation with the resolved shape; no room for it is PICO_OUT_OF_MEMORY', () => {
  const fake = fakeRuntime();
  pagerOn(fake, { mode: 'pooled', codec: 'none', arena: { slots: 3, reserveMiB: 0 } });
  assert.deepEqual(fake.calls.arena, [[3, 512, 0, 1]]);
  const starved = fakeRuntime({ arena: -2n });
  assert.throws(() => pagerOn(starved), isCode('PICO_OUT_OF_MEMORY', /park arena/));
});

test('I4: below the budget nothing parks, at any safe point', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 10 * MiB });
  const entries = [1, 2, 3].map((mib) => pager.adopt(1n, fake.grid(mib)));
  pager.enter();
  for (const entry of entries) pager.acquire(entry);
  pager.exit(false);
  assert.equal(fake.calls.parks, 0);
  assert.equal(pager.stats.residentBytes, 6 * MiB);
  assert.equal(pager.stats.parkedGrids, 0);
});

test('over budget the least recently used unpinned grids park; use restores them with their bytes', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 5 * MiB, codec: 'none' });
  const a = pager.adopt(1n, fake.grid(3, 0xa));
  const aHandle = a.handle;
  let parkedViews = 0;
  a.onPark = () => parkedViews++;
  const b = pager.adopt(1n, fake.grid(3, 0xb)); // 6 MiB > 5: a (older) parks
  assert.equal(a.handle, 0n);
  assert.equal(parkedViews, 1, 'the park hook runs before the handle dies');
  assert.deepEqual(fake.calls.destroys, [aHandle]);
  assert.equal(fake.calls.rearms, 1);
  assert.deepEqual(
    [pager.stats.parkedGrids, pager.stats.parkedBytes, pager.stats.residentBytes, pager.stats.imageBytes],
    [1, 3 * MiB, 3 * MiB, 3],
  );
  assert.ok(pager.stats.farBytes >= 3);

  pager.enter();
  const restored = pager.acquire(a); // restoring a makes room: b parks
  assert.notEqual(restored, 0n);
  assert.deepEqual([...fake.grids.get(restored)!.content], [0xa, 0xa, 0xa], 'bytes survive the round trip');
  assert.equal(b.handle, 0n);
  pager.acquire(b); // pinned a cannot park: both resident until the scope ends
  assert.notEqual(a.handle, 0n);
  assert.equal(pager.stats.residentBytes, 6 * MiB);
  pager.exit(false);
  assert.equal(pager.stats.residentBytes, 3 * MiB, 'the safe point enforces the budget');
  assert.deepEqual([pager.stats.parks, pager.stats.restores], [3, 2]);
  assert.equal(pager.stats.imageBytes, 3);
});

test('nested scopes pin until the outermost ends; grids created inside stay pinned', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 1 * MiB });
  pager.enter();
  pager.enter();
  const a = pager.adopt(1n, fake.grid(2));
  const b = pager.adopt(1n, fake.grid(2));
  pager.exit(false);
  assert.equal(fake.calls.parks, 0, 'inner exit is not a safe point');
  pager.exit(false);
  assert.equal(fake.calls.parks, 2);
  assert.deepEqual([a.handle, b.handle], [0n, 0n]);
});

test('D16: a failed operation skips the safe point, so its own error stands', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 0 });
  pager.enter();
  const a = pager.adopt(1n, fake.grid(2));
  pager.exit(true);
  assert.equal(fake.calls.parks, 0);
  assert.notEqual(a.handle, 0n);
});

test('minParkBytes keeps small grids resident', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 0, minParkBytes: 2 * MiB });
  const small = pager.adopt(1n, fake.grid(1));
  const big = pager.adopt(1n, fake.grid(2));
  pager.enter();
  pager.exit(false);
  assert.notEqual(small.handle, 0n);
  assert.equal(big.handle, 0n);
});

test('I2: a park out of heap (-2) is PICO_OUT_OF_MEMORY and leaves the grid resident', () => {
  const fake = fakeRuntime({ park: () => -2n, lastError: 1 });
  const pager = pagerOn(fake, { budgetBytes: MiB });
  const a = pager.adopt(1n, fake.grid(2));
  const created = fake.grid(2);
  assert.throws(
    () => pager.adopt(1n, created),
    isCode('PICO_OUT_OF_MEMORY', /parking a grid ran out of WebAssembly memory/),
  );
  assert.notEqual(a.handle, 0n);
  assert.equal(pager.stats.imageBytes, 0, 'the partial image is discarded');
  assert.equal(fake.calls.rearms, 0, 'a full heap is not asked for the reserve again');
  // The failed adopt hands no wrapper back, so it frees the grid it was given, once.
  assert.deepEqual(fake.calls.destroys, [created]);
  assert.equal(pager.stats.residentBytes, 2 * MiB);
  assert.equal(pager.acquire(a), a.handle);
  // a was unpinned by the failed safe point: the next one can park it.
  fake.script.park = undefined;
  pager.adopt(1n, fake.grid(2));
  assert.equal(a.handle, 0n);
});

test('I2: a far store that is full is PICO_OUT_OF_MEMORY naming the far store, cause kept', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: MiB }, ramStore(1024));
  const big = fake.grid(1);
  fake.grids.get(big)!.content = new Uint8Array(4096);
  pager.adopt(1n, big);
  assert.throws(
    () => pager.adopt(1n, fake.grid(2)),
    (error: unknown) =>
      isCode('PICO_OUT_OF_MEMORY', /far store outside the wasm heap is full/)(error) &&
      (error as Error).cause instanceof FarStoreError,
  );
});

test('a park that fails for another reason (-1, error 2) is PICO_CALL_FAILED', () => {
  const fake = fakeRuntime({ park: () => -1n, lastError: 2 });
  const pager = pagerOn(fake, { budgetBytes: MiB });
  pager.adopt(1n, fake.grid(2));
  assert.throws(() => pager.adopt(1n, fake.grid(2)), isCode('PICO_CALL_FAILED', /parking a grid failed/));
  assert.equal(fake.calls.rearms, 1, 'the heap was not the problem: the reserve is taken back');
});

test('a park that failed after freeing leaves (-3) loses that grid loudly, never silently', () => {
  const fake = fakeRuntime({ park: () => -3n, lastError: 1 });
  const pager = pagerOn(fake, { budgetBytes: MiB });
  const a = pager.adopt(1n, fake.grid(2));
  const handle = a.handle;
  let views = 0;
  a.onPark = () => views++;
  assert.throws(() => pager.adopt(1n, fake.grid(2)), isCode('PICO_OUT_OF_MEMORY'));
  assert.equal(views, 1);
  assert.ok(fake.calls.destroys.includes(handle), 'the damaged grid is freed');
  assert.equal(fake.calls.rearms, 1, 'the freed grid pays the reserve back');
  assert.throws(() => pager.acquire(a), isCode('PICO_OUT_OF_MEMORY', /lost when parking it failed/));
  pager.release(a); // no-op
  fake.script.park = () => -3n;
  fake.script.lastError = 2;
  const b = pager.adopt(1n, fake.grid(2));
  void b;
  assert.throws(() => pager.adopt(1n, fake.grid(3)), isCode('PICO_CALL_FAILED'));
});

test('a park that aborts the instance surfaces as PICO_OUT_OF_MEMORY through guard', () => {
  const fake = fakeRuntime({
    park: () => {
      throw new WebAssembly.RuntimeError('unreachable');
    },
  });
  const pager = pagerOn(fake, { budgetBytes: MiB });
  pager.adopt(1n, fake.grid(2));
  assert.throws(() => pager.adopt(1n, fake.grid(2)), isCode('PICO_OUT_OF_MEMORY', /K7_nPark aborted/));
});

test('I2: a restore out of memory is PICO_OUT_OF_MEMORY and keeps the image for a retry', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 2 * MiB });
  const a = pager.adopt(1n, fake.grid(2, 7));
  pager.adopt(1n, fake.grid(2)); // a parks
  fake.script.restore = () => 0n;
  fake.script.lastError = 1;
  pager.enter();
  assert.throws(() => pager.acquire(a), isCode('PICO_OUT_OF_MEMORY', /restoring a parked grid/));
  pager.exit(true);
  // Making room for the restore parked the other grid first; a's image is still in the store.
  assert.equal(pager.stats.parkedGrids, 2);
  assert.equal(pager.stats.imageBytes, 4, 'the image is still in the store');
  fake.script.restore = undefined;
  fake.script.lastError = 0;
  pager.enter();
  assert.deepEqual([...fake.grids.get(pager.acquire(a))!.content], [7, 7]);
  pager.exit(false);
});

test('a corrupt image or a failed store read is PICO_CALL_FAILED with the store error as cause', () => {
  const fake = fakeRuntime();
  const store = ramStore();
  const pager = pagerOn(fake, { budgetBytes: 2 * MiB }, store);
  const a = pager.adopt(1n, fake.grid(2));
  pager.adopt(1n, fake.grid(2));
  fake.script.restore = () => 0n;
  fake.script.lastError = 2;
  assert.throws(() => pager.acquire(a), isCode('PICO_CALL_FAILED', /could not be restored/));
  fake.script.restore = undefined;
  const read = store.read.bind(store);
  store.read = () => {
    throw new FarStoreError('io', 'disk gone');
  };
  assert.throws(
    () => pager.acquire(a),
    (error: unknown) => isCode('PICO_CALL_FAILED')(error) && (error as Error).cause instanceof FarStoreError,
  );
  store.read = read;
});

test('a store write that fails with an io error is PICO_CALL_FAILED', () => {
  const fake = fakeRuntime();
  const store = ramStore();
  store.write = () => {
    throw new FarStoreError('io', 'disk gone');
  };
  const pager = pagerOn(fake, { budgetBytes: MiB }, store);
  pager.adopt(1n, fake.grid(2));
  assert.throws(() => pager.adopt(1n, fake.grid(2)), isCode('PICO_CALL_FAILED'));
});

test('touch re-measures a resident grid; release frees resident and parked grids once', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 3 * MiB });
  const a = pager.adopt(1n, fake.grid(2));
  fake.grids.get(a.handle)!.mem = 3 * MiB;
  pager.touch(a);
  assert.equal(pager.stats.residentBytes, 3 * MiB);
  const b = pager.adopt(1n, fake.grid(2)); // a parks
  pager.touch(a); // parked: nothing to measure
  pager.release(a);
  pager.release(a);
  assert.deepEqual([pager.stats.parkedGrids, pager.stats.parkedBytes, pager.stats.imageBytes], [0, 0, 0]);
  const bHandle = b.handle;
  pager.release(b);
  assert.ok(fake.calls.destroys.includes(bHandle));
  assert.equal(pager.stats.residentBytes, 0);
  assert.equal(pager.acquire(b), 0n, 'a released entry hands back no handle');
  fake.script.destroyThrows = true;
  const c = pager.adopt(1n, fake.grid(1));
  pager.release(c); // a torn-down session cannot free: swallowed
});

test('forgetLibrary drops one instance’s grids and images; parkAll parks every unpinned grid', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake);
  const mine = [pager.adopt(1n, fake.grid(1)), pager.adopt(1n, fake.grid(2))];
  const other = pager.adopt(2n, fake.grid(4));
  pager.parkAll();
  pager.parkAll(); // already parked: nothing more to do
  assert.equal(pager.stats.parkedGrids, 3);
  assert.equal(pager.stats.parks, 3);
  pager.acquire(mine[0]!);
  pager.forgetLibrary(1n);
  assert.deepEqual(
    [pager.stats.parkedGrids, pager.stats.residentBytes, pager.stats.parkedBytes],
    [1, 0, 4 * MiB],
  );
  assert.equal(mine[1]!.handle, 0n);
  pager.release(mine[1]!); // already forgotten
  pager.acquire(other);
  assert.equal(pager.stats.residentBytes, 4 * MiB);
});

test('stats name the configuration; close releases the store and the arena, even on a dying module', () => {
  const fake = fakeRuntime();
  const store = ramStore();
  const pager = pagerOn(fake, { mode: 'pipelined', codec: 'none' }, store, 4);
  assert.deepEqual(
    [pager.stats.mode, pager.stats.codec, pager.stats.store, pager.stats.arenaBytes, pager.stats.budgetBytes],
    ['pipelined', 'none', 'ram', 1000, DEFAULT_BUDGET_BYTES],
  );
  pager.close();
  assert.deepEqual(fake.calls.arena.at(-1), [0, 512, 0, 0]);
  assert.throws(() => store.write(1, new Uint8Array(1)), FarStoreError);
  const dying = fakeRuntime({ closeThrows: true });
  pagerOn(dying).close();
  // A store that fails to close still lets the arena go, and its error reaches the caller.
  const failing = fakeRuntime();
  const broken = ramStore();
  broken.close = () => {
    throw new FarStoreError('io', 'scratch file gone');
  };
  assert.throws(() => pagerOn(failing, {}, broken).close(), /scratch file gone/);
  assert.deepEqual(failing.calls.arena.at(-1), [0, 512, 0, 0]);
});

test('a raw handle read outside any operation stays resident until the next safe point', () => {
  const fake = fakeRuntime();
  const pager = pagerOn(fake, { budgetBytes: 2 * MiB });
  const a = pager.adopt(1n, fake.grid(2));
  const b = pager.adopt(1n, fake.grid(2)); // a parks
  const c = pager.adopt(1n, fake.grid(2)); // b parks
  // Depth 0, as the handle getter reads it: each restore makes room, but never by parking a
  // grid read since the last safe point, so both raw handles stay valid together.
  const aHandle = pager.acquire(a);
  const bHandle = pager.acquire(b);
  assert.deepEqual([a.handle, b.handle, c.handle === 0n], [aHandle, bHandle, true]);
  assert.equal(pager.stats.residentBytes, 4 * MiB, 'over budget until the next safe point');
  pager.enter();
  pager.exit(false); // the next safe point unpins them and enforces the budget
  assert.equal(pager.stats.residentBytes, 2 * MiB);
  // A grid created outside an operation is a safe point too.
  pager.acquire(a);
  pager.acquire(b);
  pager.adopt(1n, fake.grid(2));
  assert.deepEqual([a.handle, b.handle], [0n, 0n]);
  assert.equal(pager.stats.residentBytes, 2 * MiB);
});
