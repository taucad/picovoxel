// Disk backend: one scratch file per store, through a synchronous positional
// file — a Node file descriptor or an OPFS FileSystemSyncAccessHandle.
//
// The disk tier is scratch (I6c): its own directory, outside any project or
// product store, swept of stale files when first used in a process or worker,
// size-bounded by the extent store, and removed on close. Nothing a product
// record points to ever goes here.
//
// Every count a write or read returns is checked against (0, requested]: an
// ephemeral Chromium context's OPFS returns 2^32 − 8 from write() once full
// instead of throwing, and trusting it would drop data silently.

import { FarStoreError, type ExtentBackend } from './store.ts';

/** The synchronous positional file both disk hosts provide. */
export interface SyncFile {
  write(bytes: Uint8Array, at: number): number;
  read(into: Uint8Array, at: number): number;
  truncate(size: number): void;
  close(): void;
}

/** Positional backend over a {@link SyncFile}. */
export function createFileBackend(file: SyncFile, extentBytes = 2 ** 20): ExtentBackend {
  const live = new Set<number>();
  let high = 0;
  const fail = (cause: unknown, what: string): never => {
    if (cause instanceof FarStoreError) throw cause;
    const name = (cause as { name?: string; code?: string } | null)?.name;
    const code = (cause as { code?: string } | null)?.code;
    const full = name === 'QuotaExceededError' || code === 'ENOSPC' || code === 'EDQUOT';
    throw new FarStoreError(full ? 'full' : 'io', `far store: ${what} on the scratch file failed`, { cause });
  };
  return {
    kind: 'disk',
    writeAt(position, bytes) {
      try {
        let done = 0;
        while (done < bytes.length) {
          const wrote = file.write(bytes.subarray(done), position + done);
          if (!(wrote > 0 && wrote <= bytes.length - done)) {
            throw new FarStoreError(
              'full',
              `far store: a scratch write returned ${wrote} for ${bytes.length - done} bytes`,
            );
          }
          done += wrote;
        }
      } catch (cause) {
        fail(cause, 'a write');
      }
      const extent = Math.floor(position / extentBytes);
      live.add(extent);
      high = Math.max(high, extent + 1);
    },
    readAt(position, into) {
      try {
        let done = 0;
        while (done < into.length) {
          const got = file.read(into.subarray(done), position + done);
          if (!(got > 0 && got <= into.length - done)) {
            throw new FarStoreError(
              'io',
              `far store: a scratch read returned ${got} for ${into.length - done} bytes`,
            );
          }
          done += got;
        }
      } catch (cause) {
        fail(cause, 'a read');
      }
    },
    release(extent) {
      live.delete(extent);
      if (live.size === 0 && high > 0) {
        // Every image is gone: give the file's space back.
        high = 0;
        try {
          file.truncate(0);
        } catch {
          /* best effort: the space is reused by the next write anyway */
        }
      }
    },
    committedBytes() {
      return live.size * extentBytes;
    },
    close() {
      file.close();
    },
  };
}

// ── Node ────────────────────────────────────────────────────────────────────

/** The `node:fs` members the Node host uses. */
interface NodeFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  ftruncateSync(fd: number, length: number): void;
  closeSync(fd: number): void;
}

interface NodeProcess {
  pid: number;
  kill(pid: number, signal: number): boolean;
  getBuiltinModule?(id: string): unknown;
}

/** The current Node process, or undefined outside Node. Read through globalThis so bundlers see no Node import. */
export function nodeProcess(): NodeProcess | undefined {
  const candidate = (globalThis as { process?: NodeProcess & { versions?: { node?: string } } }).process;
  return typeof candidate?.versions?.node === 'string' && typeof candidate.getBuiltinModule === 'function'
    ? candidate
    : undefined;
}

const swept = new Set<string>();
let fileCounter = 0;

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/**
 * Opens a Node scratch file in `directory`, sweeping files left by dead processes on first use.
 * The directory is created owner-only and the file exclusively (`wx+`, mode 0600), so an
 * existing path, a planted symlink included, is never opened: the next name is tried instead.
 */
export function openNodeScratchFile(directory?: string): SyncFile {
  const process = nodeProcess();
  if (!process) throw new FarStoreError('io', 'far store: the Node disk host needs Node 22.3 or later');
  const fs = process.getBuiltinModule!('node:fs') as NodeFs;
  const path = process.getBuiltinModule!('node:path') as { join(...parts: string[]): string };
  const os = process.getBuiltinModule!('node:os') as { tmpdir(): string };
  const dir = directory ?? path.join(os.tmpdir(), 'picovoxel-far');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!swept.has(dir)) {
    swept.add(dir);
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d+)-\d+\.bin$/.exec(name);
      if (!match) continue;
      const owner = Number(match[1]);
      if (owner === process.pid) continue;
      try {
        process.kill(owner, 0); // still running: not ours to remove
      } catch (error) {
        // Only ESRCH means no such process; EPERM is a live process of another user.
        if (errorCode(error) !== 'ESRCH') continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* raced with another sweeper */
        }
      }
    }
  }
  let file: string;
  let fd: number;
  for (;;) {
    file = path.join(dir, `${process.pid}-${++fileCounter}.bin`);
    try {
      fd = fs.openSync(file, 'wx+', 0o600);
      break;
    } catch (error) {
      // Taken: a stale file of an earlier process with this pid, or a planted path.
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  return {
    write: (bytes, at) => fs.writeSync(fd, bytes, 0, bytes.length, at),
    read: (into, at) => fs.readSync(fd, into, 0, into.length, at),
    truncate: (size) => fs.ftruncateSync(fd, size),
    close() {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error; // already gone: a temp cleaner got there first
      }
    },
  };
}

// ── OPFS ────────────────────────────────────────────────────────────────────

interface SyncAccessHandle {
  write(buffer: Uint8Array, options: { at: number }): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}
interface OpfsDirectory {
  getDirectoryHandle(name: string, options: { create: true }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options: { create: true }): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}
interface StorageLike {
  getDirectory?(): Promise<OpfsDirectory>;
}

function opfsRoot(): (() => Promise<OpfsDirectory>) | undefined {
  const storage = (globalThis as unknown as { navigator?: { storage?: StorageLike } }).navigator?.storage;
  return typeof storage?.getDirectory === 'function' ? () => storage.getDirectory!() : undefined;
}

/**
 * Whether OPFS here is disk-backed (K4's probe): sync handles exist (dedicated
 * worker) and 4 KiB reads and writes run at disk-cache speed. An ephemeral
 * (incognito) context keeps OPFS in RAM at hundreds of microseconds per call and
 * reports success while dropping data once full, so it must never be used.
 */
export async function probeOpfs(directoryName = 'picovoxel-far'): Promise<boolean> {
  const root = opfsRoot();
  if (!root) return false;
  try {
    const dir = await (await root()).getDirectoryHandle(directoryName, { create: true });
    const name = `probe-${Math.random().toString(36).slice(2)}`;
    const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
    try {
      const block = new Uint8Array(4096);
      const rounds = 64;
      const writeStart = performance.now();
      for (let i = 0; i < rounds; i++) handle.write(block, { at: i * 4096 });
      const writeUs = ((performance.now() - writeStart) * 1000) / rounds;
      const readStart = performance.now();
      for (let i = 0; i < rounds; i++) handle.read(block, { at: ((i * 37) % rounds) * 4096 });
      const readUs = ((performance.now() - readStart) * 1000) / rounds;
      return readUs < 60 && writeUs < 400;
    } finally {
      handle.close();
      await dir.removeEntry(name);
    }
  } catch {
    return false; // no sync handles (not a dedicated worker) or OPFS refused
  }
}

/** Opens an OPFS scratch file in `directoryName`, sweeping files no live worker holds on first use. */
export async function openOpfsScratchFile(directoryName = 'picovoxel-far'): Promise<SyncFile> {
  const root = opfsRoot();
  if (!root) throw new FarStoreError('io', 'far store: OPFS is not available here');
  const dir = await (await root()).getDirectoryHandle(directoryName, { create: true });
  const sweepKey = `opfs:${directoryName}`;
  if (!swept.has(sweepKey)) {
    swept.add(sweepKey);
    for await (const name of dir.keys()) {
      try {
        await dir.removeEntry(name); // a file another worker holds open refuses removal
      } catch {
        /* in use */
      }
    }
  }
  const name = `${Date.now()}-${++fileCounter}-${Math.random().toString(36).slice(2)}.bin`;
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  return {
    write: (bytes, at) => handle.write(bytes, { at }),
    read: (into, at) => handle.read(into, { at }),
    truncate: (size) => handle.truncate(size),
    close() {
      handle.close();
      void dir.removeEntry(name).catch(() => undefined);
    },
  };
}
