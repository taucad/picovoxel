// The far store (src/far/): extent store, RAM and disk backends, the OPFS probe
// and guard, and openFarStore. Pure JS — no wasm module — and no picovoxel types,
// which is the boundary I6a draws: this suite imports nothing outside src/far/.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  FarStoreError,
  createExtentStore,
  createFileBackend,
  createRamBackend,
  openFarStore,
  probeOpfs,
  resizableArrayBuffersAvailable,
  type SyncFile,
} from '../src/far/index.ts';
import {
  canSweepByPid,
  defaultScratchName,
  nodeProcess,
  openNodeScratchFile,
  openOpfsScratchFile,
  pidNamespace,
} from '../src/far/disk.ts';

const nodeFs = { readlinkSync: (path: string) => readlinkSync(path) };

const KiB = 1024;

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function readAll(
  store: { read(id: number, offset: number, into: Uint8Array): number },
  id: number,
  length: number,
) {
  const into = new Uint8Array(length);
  let offset = 0;
  // Odd-sized reads cross extent boundaries.
  for (let got = 1; got > 0; offset += got)
    got = store.read(id, offset, into.subarray(offset, Math.min(length, offset + 777)));
  return { into, offset };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the far module imports nothing from picovoxel (I6a)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of readdirSync(join(import.meta.dirname, '..', 'src', 'far'))) {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'far', file), 'utf8');
    for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
      assert.ok(specifier!.startsWith('./'), `src/far/${file} imports ${specifier} from outside src/far/`);
    }
  }
});

for (const resizable of [true, false]) {
  test(`extent store over RAM (${resizable ? 'resizable' : 'plain'} segments): round trip, reuse, release`, () => {
    const backend = createRamBackend({ segmentBytes: 16 * KiB, extentBytes: 4 * KiB, resizable });
    const store = createExtentStore(backend, { extentBytes: 4 * KiB });
    assert.equal(store.kind, 'ram');
    const a = bytes(10 * KiB + 3, 1);
    const b = bytes(40 * KiB, 2); // spans three segments
    store.write(1, a.subarray(0, 5000));
    store.write(1, a.subarray(5000)); // appends across an extent boundary
    store.write(2, b);
    assert.equal(store.bytesHeld, a.length + b.length);
    assert.deepEqual(readAll(store, 1, a.length).into, a);
    assert.deepEqual(readAll(store, 2, b.length).into, b);
    assert.equal(store.read(3, 0, new Uint8Array(4)), 0, 'unknown id reads nothing');
    assert.equal(store.read(1, a.length, new Uint8Array(4)), 0, 'reads stop at the end');
    const committed = store.committedBytes;
    assert.ok(committed >= a.length + b.length);
    store.discard(2);
    store.discard(2); // idempotent
    assert.equal(store.bytesHeld, a.length);
    assert.ok(store.committedBytes < committed, 'emptied segments are returned');
    store.write(4, b); // reuses the freed extents
    assert.deepEqual(readAll(store, 4, b.length).into, b);
    store.discard(1);
    store.discard(4);
    assert.equal(store.committedBytes, 0, 'nothing held, nothing committed');
    store.close();
    store.close();
    assert.throws(
      () => store.write(1, a),
      (error: unknown) => error instanceof FarStoreError && error.kind === 'io',
    );
  });
}

test('RAM backend defaults: resizable when the engine has it; a read of an unwritten segment is an io error', () => {
  assert.equal(resizableArrayBuffersAvailable(), true, 'Node has resizable ArrayBuffers');
  const backend = createRamBackend();
  assert.throws(
    () => backend.readAt(0, new Uint8Array(1)),
    (error: unknown) => error instanceof FarStoreError && error.kind === 'io',
  );
  backend.release(5); // never written: ignored
  backend.close();
});

test('resizableArrayBuffersAvailable is false where the constructor rejects options', () => {
  vi.stubGlobal('ArrayBuffer', function refuse() {
    throw new TypeError('no resizable buffers');
  });
  assert.equal(resizableArrayBuffersAvailable(), false);
});

test('a host that refuses a segment makes the store full, not broken', () => {
  const store = createExtentStore(
    createRamBackend({ segmentBytes: 2 ** 40, extentBytes: 2 ** 20, resizable: false }),
  );
  assert.throws(
    () => store.write(1, new Uint8Array(8)),
    (error: unknown) =>
      error instanceof FarStoreError && error.kind === 'full' && error.cause instanceof RangeError,
  );
});

test('the size bound fails a write with kind full and keeps earlier images', () => {
  const store = createExtentStore(createRamBackend({ segmentBytes: 8 * KiB, extentBytes: 4 * KiB }), {
    extentBytes: 4 * KiB,
    maxBytes: 8 * KiB,
  });
  const first = bytes(6 * KiB, 3);
  store.write(1, first);
  assert.throws(
    () => store.write(2, bytes(4 * KiB, 4)),
    (error: unknown) =>
      error instanceof FarStoreError && error.kind === 'full' && /size bound of 8192/.test(error.message),
  );
  assert.deepEqual(readAll(store, 1, first.length).into, first);
});

/** A SyncFile over a growable buffer, with scripted misbehaviour. */
function memoryFile(overrides: Partial<SyncFile> = {}) {
  let data = new Uint8Array(0);
  const calls = { truncated: [] as number[], closed: 0 };
  const file: SyncFile = {
    write(chunk, at) {
      if (at + chunk.length > data.length) {
        const grown = new Uint8Array(at + chunk.length);
        grown.set(data);
        data = grown;
      }
      const take = Math.min(chunk.length, 3000); // short writes: the backend must loop
      data.set(chunk.subarray(0, take), at);
      return take;
    },
    read(into, at) {
      const take = Math.min(into.length, data.length - at, 3000);
      into.set(data.subarray(at, at + take));
      return take;
    },
    truncate(size) {
      calls.truncated.push(size);
      data = data.slice(0, size);
    },
    close() {
      calls.closed++;
    },
    ...overrides,
  };
  return { file, calls };
}

test('file backend: short writes and reads loop; space is given back when every image is gone', () => {
  const { file, calls } = memoryFile();
  const store = createExtentStore(createFileBackend(file, 4 * KiB), { extentBytes: 4 * KiB });
  assert.equal(store.kind, 'disk');
  const image = bytes(9 * KiB, 5);
  store.write(7, image);
  assert.equal(store.committedBytes, 12 * KiB);
  assert.deepEqual(readAll(store, 7, image.length).into, image);
  store.discard(7);
  assert.deepEqual(calls.truncated, [0]);
  assert.equal(store.committedBytes, 0);
  store.close();
  assert.equal(calls.closed, 1);
});

test('file backend: a truncate that throws is ignored', () => {
  const { file } = memoryFile({
    truncate() {
      throw new Error('busy');
    },
  });
  const store = createExtentStore(createFileBackend(file, 4 * KiB), { extentBytes: 4 * KiB });
  store.write(1, bytes(10, 1));
  store.discard(1);
});

test("file backend: a write count outside (0, requested] is refused (ephemeral OPFS's 2^32 − 8)", () => {
  for (const wrote of [2 ** 32 - 8, 0, -1]) {
    const { file } = memoryFile({ write: () => wrote });
    const store = createExtentStore(createFileBackend(file));
    assert.throws(
      () => store.write(1, new Uint8Array(16)),
      (error: unknown) =>
        error instanceof FarStoreError && error.kind === 'full' && error.message.includes(String(wrote)),
    );
  }
});

test('file backend: a short or overlong read is an io error', () => {
  for (const got of [0, 99]) {
    const { file } = memoryFile({ read: () => got });
    const store = createExtentStore(createFileBackend(file));
    store.write(1, new Uint8Array(16));
    assert.throws(
      () => store.read(1, 0, new Uint8Array(16)),
      (error: unknown) => error instanceof FarStoreError && error.kind === 'io',
    );
  }
});

test('file backend: host errors map to full (quota, ENOSPC, EDQUOT) or io', () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error('quota'), { name: 'QuotaExceededError' }), 'full'],
    [Object.assign(new Error('nospace'), { code: 'ENOSPC' }), 'full'],
    [Object.assign(new Error('quota'), { code: 'EDQUOT' }), 'full'],
    [new Error('EIO'), 'io'],
    [null, 'io'],
  ];
  for (const [thrown, kind] of cases) {
    const { file } = memoryFile({
      write() {
        throw thrown;
      },
      read() {
        throw thrown;
      },
    });
    const backend = createFileBackend(file);
    const check = (error: unknown) =>
      error instanceof FarStoreError && error.kind === kind && error.cause === thrown;
    assert.throws(() => backend.writeAt(0, new Uint8Array(4)), check);
    assert.throws(() => backend.readAt(0, new Uint8Array(4)), check);
  }
});

test('Node scratch: own directory, stale files of dead processes swept, live ones kept, removed on close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-far-test-'));
  try {
    const stale = join(dir, '999999999-1.bin'); // no such pid
    const live = join(dir, `${process.ppid}-1.bin`); // the parent process is alive
    const mine = join(dir, `${process.pid}-77.bin`);
    const foreign = join(dir, 'notes.txt');
    for (const path of [stale, live, mine, foreign]) writeFileSync(path, 'x');
    const file = openNodeScratchFile(dir);
    assert.equal(existsSync(stale), false, 'a dead process’s file is swept');
    assert.equal(existsSync(live), true, 'a live process’s file is kept');
    assert.equal(existsSync(mine), true, 'this process’s files are never swept');
    assert.equal(existsSync(foreign), true, 'files the store did not name are left alone');
    const store = createExtentStore(createFileBackend(file, 4 * KiB), { extentBytes: 4 * KiB });
    const image = bytes(20 * KiB, 9);
    store.write(1, image);
    assert.deepEqual(readAll(store, 1, image.length).into, image);
    store.discard(1); // truncates the file
    store.write(1, image);
    const created = readdirSync(dir).filter(
      (name) => name.startsWith(`${process.pid}-`) && name !== `${process.pid}-77.bin`,
    );
    assert.equal(created.length, 1);
    store.close();
    assert.equal(existsSync(join(dir, created[0]!)), false, 'the scratch file is removed on close');
    openNodeScratchFile(dir).close(); // a second open in the same process does not sweep again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const codeError = (code: string) => Object.assign(new Error(code), { code });

/** Runs `body` with `node:fs` members replaced, as the Node host reads them. */
async function withFs<T>(overrides: Record<string, unknown>, body: () => T): Promise<T> {
  const fs = await import('node:fs');
  const realGet = process.getBuiltinModule.bind(process);
  const spy = vi
    .spyOn(process, 'getBuiltinModule')
    .mockImplementation((id: string) => (id === 'node:fs' ? { ...fs, ...overrides } : realGet(id)));
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

test('Node scratch: on Linux with an unreadable PID namespace nothing is swept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-far-nons-'));
  const fs = process.getBuiltinModule('node:fs') as { readlinkSync: (path: string) => string };
  const readlink = vi.spyOn(fs, 'readlinkSync').mockImplementation(() => {
    throw new Error('EACCES');
  });
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  try {
    const stale = join(dir, '999999999-1.bin'); // no such pid here, but it may be live elsewhere
    writeFileSync(stale, 'x');
    openNodeScratchFile(dir).close();
    assert.equal(existsSync(stale), true, 'a pid outside a known namespace proves nothing');
  } finally {
    readlink.mockRestore();
    platform.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node scratch: a sweeper that loses the race to unlink carries on; a vanished file still closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-far-race-'));
  try {
    writeFileSync(join(dir, '999999998-1.bin'), 'x');
    await withFs(
      {
        unlinkSync() {
          throw codeError('ENOENT');
        },
      },
      () => {
        const file = openNodeScratchFile(dir);
        file.close(); // the name is already gone: nothing left to remove
      },
    );
    await withFs(
      {
        unlinkSync() {
          throw codeError('EACCES');
        },
      },
      () => {
        const file = openNodeScratchFile(dir);
        assert.throws(() => file.close(), /EACCES/, 'any other unlink failure reaches the caller');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node scratch: private and exclusive — 0700 directory, 0600 file, an existing path is never opened', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'picovoxel-far-mode-')), 'far');
  try {
    const file = openNodeScratchFile(dir);
    const [created] = readdirSync(dir);
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, created!)).mode & 0o777, 0o600);
    }
    file.close();
    // The next names are taken (a stale file of an earlier process with this pid, a planted
    // symlink): each is skipped, never truncated or followed.
    const counter = Number(/^\d+-(\d+)\.bin$/.exec(created!)![1]);
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep');
    writeFileSync(join(dir, `${process.pid}-${counter + 1}.bin`), 'stale');
    symlinkSync(target, join(dir, `${process.pid}-${counter + 2}.bin`));
    const next = openNodeScratchFile(dir);
    next.write(new Uint8Array([1, 2, 3]), 0);
    assert.equal(readFileSync(target, 'utf8'), 'keep');
    assert.equal(readFileSync(join(dir, `${process.pid}-${counter + 1}.bin`), 'utf8'), 'stale');
    assert.ok(existsSync(join(dir, `${process.pid}-${counter + 3}.bin`)));
    next.close();
    await withFs(
      {
        openSync() {
          throw codeError('EACCES');
        },
      },
      () => assert.throws(() => openNodeScratchFile(dir), /EACCES/, 'other open failures are not retried'),
    );
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('Node scratch: only ESRCH marks a dead owner; EPERM is a live process of another user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-far-eperm-'));
  try {
    const other = join(dir, '999999997-1.bin');
    writeFileSync(other, 'x');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw codeError('EPERM');
    });
    try {
      openNodeScratchFile(dir).close();
    } finally {
      kill.mockRestore();
    }
    assert.equal(existsSync(other), true, 'another user’s live file is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node scratch default directory is the OS temp dir; outside Node it refuses', async () => {
  const store = await openFarStore({ kind: 'disk', maxBytes: 1 << 20 });
  assert.equal(store.kind, 'disk');
  store.write(1, bytes(100, 1));
  assert.equal(store.bytesHeld, 100);
  store.close();
  assert.ok(existsSync(join(tmpdir(), defaultScratchName(hostname(), pidNamespace(nodeFs)))));
  assert.equal(defaultScratchName('a/b c'), 'picovoxel-far-a_b_c');
  assert.equal(defaultScratchName('', '42'), 'picovoxel-far-host-42');
  assert.equal(pidNamespace({ readlinkSync: () => 'pid:[4026531836]' }), '4026531836');
  assert.equal(pidNamespace({ readlinkSync: () => 'odd' }), undefined);
  assert.equal(canSweepByPid('linux', '4026531836'), true);
  assert.equal(canSweepByPid('linux', undefined), false);
  assert.equal(canSweepByPid('darwin', undefined), true);
  assert.equal(
    pidNamespace({
      readlinkSync: () => {
        throw new Error('ENOENT');
      },
    }),
    undefined,
  );

  vi.stubGlobal('process', { versions: {} });
  assert.equal(nodeProcess(), undefined);
  assert.throws(
    () => openNodeScratchFile(),
    (error: unknown) => error instanceof FarStoreError && error.kind === 'io',
  );
});

test('openFarStore ram: unbounded by default, bounded on request', async () => {
  const store = await openFarStore({ kind: 'ram', maxBytes: 2 ** 20 });
  store.write(1, new Uint8Array(2 ** 20));
  assert.throws(
    () => store.write(2, new Uint8Array(1)),
    (error: unknown) => error instanceof FarStoreError && error.kind === 'full',
  );
  store.close();
  (await openFarStore({ kind: 'ram' })).close();
});

// ── OPFS, with a scripted in-memory OPFS ────────────────────────────────────

interface FakeOpfsOptions {
  readDelayUs?: number;
  noSyncHandle?: boolean;
  lockedNames?: Set<string>;
  lockAll?: { value: boolean };
}

function fakeOpfs({
  readDelayUs = 0,
  noSyncHandle = false,
  lockedNames = new Set(),
  lockAll = { value: false },
}: FakeOpfsOptions = {}) {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  // A scripted clock: each call costs what a disk-backed or RAM-backed OPFS would,
  // so the probe's verdict does not depend on this machine's load.
  let nowMs = 0;
  vi.stubGlobal('performance', { now: () => nowMs });
  const spin = (us: number) => {
    nowMs += us / 1000;
  };
  const dir = {
    getDirectoryHandle: () => Promise.resolve(dir),
    getFileHandle(name: string) {
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      return Promise.resolve({
        createSyncAccessHandle() {
          if (noSyncHandle) return Promise.reject(new DOMException('not in a worker', 'InvalidStateError'));
          return Promise.resolve({
            write(chunk: Uint8Array, { at }: { at: number }) {
              spin(readDelayUs > 0 ? 900 : 20);
              let data = files.get(name)!;
              if (at + chunk.length > data.length) {
                const grown = new Uint8Array(at + chunk.length);
                grown.set(data);
                files.set(name, (data = grown));
              }
              data.set(chunk, at);
              return chunk.length;
            },
            read(into: Uint8Array, { at }: { at: number }) {
              spin(readDelayUs > 0 ? readDelayUs : 4);
              const data = files.get(name)!;
              const take = Math.max(0, Math.min(into.length, data.length - at));
              into.set(data.subarray(at, at + take));
              return take;
            },
            truncate(size: number) {
              files.set(name, files.get(name)!.slice(0, size));
            },
            flush() {},
            close() {},
          });
        },
      });
    },
    removeEntry(name: string) {
      if (lockAll.value || lockedNames.has(name)) {
        return Promise.reject(new DOMException('in use', 'NoModificationAllowedError'));
      }
      files.delete(name);
      removed.push(name);
      return Promise.resolve();
    },
    *keys() {
      yield* Array.from(files.keys()); // a snapshot: the sweep deletes while it iterates
    },
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(dir) } });
  return { files, removed };
}

test('OPFS probe: disk-backed when 4 KiB calls run at disk-cache speed; false when slow, handle-less or absent', async () => {
  vi.stubGlobal('navigator', undefined);
  assert.equal(await probeOpfs(), false, 'no navigator');
  fakeOpfs();
  assert.equal(await probeOpfs(), true, 'fast fake OPFS');
  fakeOpfs({ readDelayUs: 200 });
  assert.equal(await probeOpfs(), false, 'RAM-backed (ephemeral) latency');
  fakeOpfs({ noSyncHandle: true });
  assert.equal(await probeOpfs(), false, 'no sync handles off a dedicated worker');
});

test('OPFS scratch: swept once per directory (locked files kept), round trip, removed on close', async () => {
  const { files, removed } = fakeOpfs({ lockedNames: new Set(['held-by-other-worker.bin']) });
  files.set('stale.bin', new Uint8Array(8));
  files.set('held-by-other-worker.bin', new Uint8Array(8));
  const file = await openOpfsScratchFile('opfs-test-dir');
  assert.ok(removed.includes('stale.bin'));
  assert.ok(files.has('held-by-other-worker.bin'));
  const store = createExtentStore(createFileBackend(file, 4 * KiB), { extentBytes: 4 * KiB });
  const image = bytes(9 * KiB, 4);
  store.write(1, image);
  assert.deepEqual(readAll(store, 1, image.length).into, image);
  store.discard(1);
  store.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    [...files.keys()].filter((name) => name !== 'held-by-other-worker.bin').length,
    0,
    'scratch file removed',
  );
  files.set('second-stale.bin', new Uint8Array(1));
  (await openOpfsScratchFile('opfs-test-dir')).close();
  assert.ok(files.has('second-stale.bin'), 'no second sweep in the same worker');
});

test('OPFS scratch: a close whose removal is refused does not throw', async () => {
  const lockAll = { value: false };
  fakeOpfs({ lockAll });
  const file = await openOpfsScratchFile('opfs-locked-dir');
  lockAll.value = true;
  file.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('openFarStore disk outside Node: OPFS when the probe says disk-backed, refused otherwise', async () => {
  vi.stubGlobal('process', { versions: {} });
  fakeOpfs();
  const store = await openFarStore({ kind: 'disk', directory: 'opfs-open-test' });
  assert.equal(store.kind, 'disk');
  store.close();
  fakeOpfs({ readDelayUs: 200 });
  await assert.rejects(
    () => openFarStore({ kind: 'disk' }),
    (error: unknown) =>
      error instanceof FarStoreError && error.kind === 'io' && /dedicated worker/.test(error.message),
  );
  vi.stubGlobal('navigator', {});
  await assert.rejects(
    () => openOpfsScratchFile(),
    (error: unknown) => error instanceof FarStoreError,
  );
});
