// The grid pager: keeps the resident Voxels grids of a runtime under a byte
// budget by parking the least recently used ones to the far store outside the
// wasm heap (src/far/) and restoring them on their next use.
//
// One pager per runtime, because the budget is about the one wasm heap every
// session on the runtime shares. Each Voxels wrapper owns an entry; the entry,
// not the wrapper, holds the native handle, so a parked grid owns no handle and
// the pager never holds a wrapper (the GC can still collect it).
//
// Safe points: a grid is parked only when the outermost facade operation ends
// (`exit`), when a grid is created outside one (`adopt` at depth 0), or to make
// room for a restore. Grids an operation touched stay pinned until it ends.
// Below the budget nothing parks and nothing changes (I4).
//
// Failures (I2): out of memory while parking (K7_nPark -2, or -3 with error 1),
// while restoring (K7_nLastError() 1) or in the far store is PICO_OUT_OF_MEMORY;
// a failed operation's scope never parks afterwards (D16), so its own error
// stands and nothing calls into an instance that may have aborted.

import { refreshHeapViews } from './context.ts';
import { guard, outOfMemoryError, PicoError } from './errors.ts';
import { FarStoreError, type FarStore } from './far/index.ts';
import type { PicoWasmModule } from './types.ts';

/** How park frames are compressed. `'lz4'` (default) or `'none'` (compaction and shuffle only). */
export type PagerCodec = 'lz4' | 'none';
/** How park and restore use the thread pool. */
export type PagerMode = 'serial' | 'pooled' | 'pipelined';

/** `createPico({ pager })`: the grid pager. `false` turns it off. */
export interface PagerOptions {
  /**
   * Resident grid bytes (Σ `memUsage` of live Voxels) allowed at a safe point.
   * Default: 2 GiB, the headroom of the 4 GiB wasm32 heap, so ordinary models
   * never park.
   */
  budgetBytes?: number;
  /** Frame codec (default `'lz4'`). */
  codec?: PagerCodec;
  /**
   * `'pipelined'` (default on picovoxel/multi) overlaps coding on the pool with
   * storing and freeing; `'pooled'` codes in waves; `'serial'` (default on the
   * serial build) codes on the calling thread. Without two threads,
   * `'pipelined'` runs as `'pooled'`.
   */
  mode?: PagerMode;
  /**
   * The encode arena, taken once when the runtime starts — heap the model cannot
   * use. `slots`: leaf batches coded at once (default `min(4, threads)` on
   * picovoxel/multi, 1 on the serial build). `reserveMiB`: heap held back and
   * released at the start of every park so it can run on a full heap (default 8).
   */
  arena?: { slots?: number; reserveMiB?: number };
  /**
   * Where parked grids go. `'ram'` (default): JS memory beside the heap.
   * `'disk'`: a scratch file — Node `fs`, or OPFS in a dedicated worker whose
   * context probes as disk-backed (never an incognito context).
   */
  store?: 'ram' | 'disk';
  /** Size bound of the store in bytes (default unbounded for `'ram'`, 16 GiB for `'disk'`). */
  storeMaxBytes?: number;
  /** `'disk'` only: the scratch directory (a path in Node, a directory name in OPFS). */
  directory?: string;
  /** @internal test seam — grids below this many bytes never park (default 1 MiB). */
  minParkBytes?: number;
}

/** What the pager has done, for memory reports. */
export interface PagerStats {
  readonly budgetBytes: number;
  readonly codec: PagerCodec;
  readonly mode: PagerMode;
  readonly store: 'ram' | 'disk';
  /** Σ `memUsage` of resident grids. */
  readonly residentBytes: number;
  readonly parkedGrids: number;
  /** Σ `memUsage` the parked grids had when parked. */
  readonly parkedBytes: number;
  /** Bytes of park images in the far store. */
  readonly imageBytes: number;
  /** Bytes the far store holds on its host (RAM or disk). */
  readonly farBytes: number;
  /** Heap the encode arena holds. */
  readonly arenaBytes: number;
  readonly parks: number;
  readonly restores: number;
}

/** One paged grid. Holds the native handle; never the wrapper. */
export interface PagerEntry {
  readonly lib: bigint;
  /** The native handle; 0n while parked or lost. */
  handle: bigint;
  /** Runs before a park destroys the grid's handle (drops views onto the grid). */
  onPark?: () => void;
}

export interface Pager {
  /** Takes over a new grid's handle. */
  adopt(lib: bigint, handle: bigint): PagerEntry;
  /**
   * The entry's handle, restored and pinned until the next safe point: the end of the
   * outermost operation, or a grid created outside one. Outside any operation (the raw
   * `handle` getter at depth 0) the pin lasts until that next safe point too, so every raw
   * handle read since the last one stays valid together; the next safe point unpins them
   * all and enforces the budget again.
   */
  acquire(entry: PagerEntry): bigint;
  /** Re-measures a grid an operation changed in place. */
  touch(entry: PagerEntry): void;
  /**
   * Ends the entry without freeing its grid, which must be resident (acquired in
   * the current operation): a consuming call hands the grid to its result's wrapper,
   * which adopts it as a new entry.
   */
  detach(entry: PagerEntry): void;
  /** Frees the grid, resident or parked (dispose and GC). Never throws. */
  release(entry: PagerEntry): void;
  /** Opens an operation scope. */
  enter(): void;
  /** Closes it; `failed` skips the safe point, so a failed operation's error stands (D16). */
  exit(failed: boolean): void;
  /** Parks every unpinned resident grid. */
  parkAll(): void;
  /** Drops every entry of a Library instance being destroyed (its handles die with it). */
  forgetLibrary(lib: bigint): void;
  readonly stats: PagerStats;
  /** Releases the store and the trampolines. */
  close(): void;
}

/** The raw exports the pager calls. */
export interface PagerRaw {
  K7_nPark(
    lib: bigint,
    handle: bigint,
    transform: number,
    codec: number,
    level: number,
    blockLeaves: number,
    flags: number,
    sink: number,
  ): bigint;
  K7_hRestore(lib: bigint, source: number): bigint;
  K7_nArena(slots: number, blockLeaves: number, reserveMiB: number, mode: number): bigint;
  K7_nRearm(): number;
  K7_nLastError(): number;
  Voxels_nMemUsage(lib: bigint, handle: bigint): bigint;
  Voxels_Destroy(lib: bigint, handle: bigint): void;
}

/** Default budget: half the 4 GiB wasm32 heap, its headroom for resident grids. */
export const DEFAULT_BUDGET_BYTES = 2 ** 31;
const TRANSFORM_COMPACT_SHUFFLE = 4;
const BLOCK_LEAVES = 512;
const FLAG_DESTRUCTIVE = 1;
const MODES: Record<PagerMode, number> = { serial: 0, pooled: 1, pipelined: 2 };

interface Entry extends PagerEntry {
  bytes: number;
  lastUse: number;
  pinned: boolean;
  state: 'resident' | 'parked' | 'lost' | 'gone';
  imageId: number;
  imageBytes: number;
}

export interface CreatePagerOptions {
  module: PicoWasmModule;
  raw: PagerRaw;
  store: FarStore;
  /** Threads the module runs on (1 on the serial build). */
  threads: number;
  options: PagerOptions;
}

/** Validates the public options; throws PICO_INVALID_ARGUMENT before anything is allocated. */
export function resolvePagerOptions(options: PagerOptions, threads: number) {
  const budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const codec = options.codec ?? 'lz4';
  const mode = options.mode ?? (threads > 1 ? 'pipelined' : 'serial');
  const slots = options.arena?.slots ?? (threads > 1 ? Math.min(4, threads) : 1);
  const reserveMiB = options.arena?.reserveMiB ?? 8;
  const store = options.store ?? 'ram';
  const bad = (what: string): never => {
    throw new PicoError('PICO_INVALID_ARGUMENT', `pager: ${what}`);
  };
  if (!(budgetBytes >= 0)) bad(`budgetBytes must be a byte count of 0 or more, got ${budgetBytes}`);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for untyped JavaScript callers
  if (codec !== 'lz4' && codec !== 'none') bad(`codec must be 'lz4' or 'none', got ${codec as string}`);
  if (!Object.hasOwn(MODES, mode)) bad(`mode must be 'serial', 'pooled' or 'pipelined', got ${mode}`);
  if (!(Number.isInteger(slots) && slots >= 1 && slots <= 64))
    bad(`arena.slots must be an integer from 1 to 64, got ${slots}`);
  if (!(Number.isInteger(reserveMiB) && reserveMiB >= 0 && reserveMiB <= 1024)) {
    bad(`arena.reserveMiB must be an integer from 0 to 1024, got ${reserveMiB}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for untyped JavaScript callers
  if (store !== 'ram' && store !== 'disk') bad(`store must be 'ram' or 'disk', got ${store as string}`);
  if (options.storeMaxBytes !== undefined && !(options.storeMaxBytes > 0)) {
    bad(`storeMaxBytes must be a positive byte count, got ${options.storeMaxBytes}`);
  }
  return {
    budgetBytes,
    codec,
    mode,
    slots,
    reserveMiB,
    store,
    storeMaxBytes: options.storeMaxBytes,
    directory: options.directory,
    minParkBytes: options.minParkBytes ?? 2 ** 20,
  };
}

export function createPager({ module, raw, store, threads, options }: CreatePagerOptions): Pager {
  const resolved = resolvePagerOptions(options, threads);
  const { budgetBytes, codec, mode, minParkBytes } = resolved;
  const codecNumber = codec === 'lz4' ? 1 : 0;

  const arenaBytes = Number(raw.K7_nArena(resolved.slots, BLOCK_LEAVES, resolved.reserveMiB, MODES[mode]));
  if (arenaBytes < 0) throw outOfMemoryError('pager: reserving the park arena');

  const entries = new Set<Entry>();
  const pinned: Entry[] = [];
  let depth = 0;
  let tick = 0;
  let nextImage = 1;
  let residentBytes = 0;
  let parkedBytes = 0;
  let parkedGrids = 0;
  let parks = 0;
  let restores = 0;

  // One sink and one source for the pager's lifetime (addFunction is slow). They
  // never throw into wasm: a store failure is a status code, its error kept here.
  let ioImage = 0;
  let ioOffset = 0;
  let ioError: unknown;
  const heap = (pointer: number, bytes: number): Uint8Array => {
    refreshHeapViews(module);
    const at = pointer >>> 0;
    return module.HEAPU8.subarray(at, at + bytes);
  };
  const sink = module.addFunction((pointer: number, bytes: number): number => {
    try {
      store.write(ioImage, heap(pointer, bytes));
      return 0;
    } catch (error) {
      ioError = error;
      return error instanceof FarStoreError && error.kind === 'full' ? 1 : 2;
    }
  }, 'iii');
  const source = module.addFunction((pointer: number, capacity: number): number => {
    try {
      const got = store.read(ioImage, ioOffset, heap(pointer, capacity));
      ioOffset += got;
      return got;
    } catch (error) {
      ioError = error;
      return -1;
    }
  }, 'iii');

  const park = (entry: Entry): void => {
    const id = nextImage++;
    ioImage = id;
    ioError = undefined;
    const written = Number(
      guard('K7_nPark', () =>
        raw.K7_nPark(
          entry.lib,
          entry.handle,
          TRANSFORM_COMPACT_SHUFFLE,
          codecNumber,
          1,
          BLOCK_LEAVES,
          FLAG_DESTRUCTIVE,
          sink,
        ),
      )(),
    );
    if (written < 0) {
      store.discard(id);
      const cause = ioError;
      const outOfMemory = raw.K7_nLastError() === 1;
      if (written === -3) {
        // Leaves were freed before the failure: the grid cannot be kept.
        entry.onPark?.();
        raw.Voxels_Destroy(entry.lib, entry.handle);
        entry.handle = 0n;
        entry.state = 'lost';
        residentBytes -= entry.bytes;
        entries.delete(entry);
      }
      // The park released the encode reserve. Take it back now, except after -2 (the grid is still
      // whole): the heap may be what ran out, or the far store filled first, and re-taking it on a
      // full heap would fail too (mimalloc traps there), so the next park that frees a grid takes
      // it back instead.
      if (written !== -2) raw.K7_nRearm();
      if (outOfMemory) {
        throw outOfMemoryError('pager: parking a grid', {
          cause,
          where: cause === undefined ? 'heap' : 'far',
        });
      }
      throw new PicoError(
        'PICO_CALL_FAILED',
        'pager: parking a grid failed (the far store could not take its image).',
        {
          cause,
        },
      );
    }
    entry.onPark?.();
    raw.Voxels_Destroy(entry.lib, entry.handle);
    raw.K7_nRearm(); // the freed grid pays the reserve back
    entry.handle = 0n;
    entry.state = 'parked';
    entry.imageId = id;
    entry.imageBytes = written;
    residentBytes -= entry.bytes;
    parkedBytes += entry.bytes;
    parkedGrids++;
    parks++;
  };

  /** Parks least recently used unpinned grids until `extra` more bytes fit the budget. */
  const makeRoom = (extra: number): void => {
    if (residentBytes + extra <= budgetBytes) return;
    const candidates = [...entries]
      .filter((entry) => entry.state === 'resident' && !entry.pinned && entry.bytes >= minParkBytes)
      .sort((a, b) => a.lastUse - b.lastUse);
    for (const entry of candidates) {
      if (residentBytes + extra <= budgetBytes) break;
      park(entry);
    }
  };

  const restore = (entry: Entry): void => {
    makeRoom(entry.bytes);
    ioImage = entry.imageId;
    ioOffset = 0;
    ioError = undefined;
    const handle = guard('K7_hRestore', () => raw.K7_hRestore(entry.lib, source))();
    if (!handle) {
      // The image stays in the store: freeing heap and retrying can still restore it.
      if (raw.K7_nLastError() === 1) throw outOfMemoryError('pager: restoring a parked grid');
      throw new PicoError(
        'PICO_CALL_FAILED',
        'pager: a parked grid could not be restored: its image is corrupt or the far store could not read it.',
        { cause: ioError },
      );
    }
    store.discard(entry.imageId);
    entry.handle = handle;
    entry.state = 'resident';
    entry.imageId = 0;
    entry.imageBytes = 0;
    residentBytes += entry.bytes;
    parkedBytes -= entry.bytes;
    parkedGrids--;
    restores++;
  };

  /** Frees an entry's grid, resident or parked; a no-op for one already gone. Never throws. */
  const release = (entry: Entry): void => {
    if (!entries.delete(entry)) return;
    if (entry.state === 'resident') {
      residentBytes -= entry.bytes;
      try {
        raw.Voxels_Destroy(entry.lib, entry.handle);
      } catch {
        /* the session was torn down first */
      }
    } else {
      // Only resident and parked entries are in the set ('lost' ones leave it).
      store.discard(entry.imageId);
      parkedBytes -= entry.bytes;
      parkedGrids--;
    }
    entry.state = 'gone';
    entry.handle = 0n;
  };

  const pin = (entry: Entry): void => {
    if (entry.pinned) return;
    entry.pinned = true;
    pinned.push(entry);
  };
  const unpinAll = (): void => {
    for (const entry of pinned) entry.pinned = false;
    pinned.length = 0;
  };

  const measure = (entry: Entry): number =>
    Number(guard('Voxels_nMemUsage', () => raw.Voxels_nMemUsage(entry.lib, entry.handle))());

  return {
    adopt(lib, handle) {
      const entry: Entry = {
        lib,
        handle,
        bytes: 0,
        lastUse: ++tick,
        pinned: false,
        state: 'resident',
        imageId: 0,
        imageBytes: 0,
      };
      entry.bytes = measure(entry);
      entries.add(entry);
      residentBytes += entry.bytes;
      if (depth > 0) {
        pin(entry);
        return entry;
      }
      // Created outside any Voxels operation (a session factory): a safe point. The pins of raw
      // handles read since the last one end, and only the new grid is kept. When making room
      // fails, the caller gets the error and never a wrapper, so the new grid is freed here.
      unpinAll();
      pin(entry);
      let failed = true;
      try {
        makeRoom(0);
        failed = false;
      } finally {
        unpinAll();
        if (failed) release(entry);
      }
      return entry;
    },
    acquire(publicEntry) {
      const entry = publicEntry as Entry;
      if (entry.state === 'lost') {
        throw outOfMemoryError('pager: this Voxels', {
          detail: 'it was lost when parking it failed part way, as memory ran out',
        });
      }
      if (entry.state === 'gone') return entry.handle;
      pin(entry);
      if (entry.state === 'parked') restore(entry);
      entry.lastUse = ++tick;
      return entry.handle;
    },
    touch(publicEntry) {
      const entry = publicEntry as Entry;
      if (entry.state !== 'resident') return;
      const bytes = measure(entry);
      residentBytes += bytes - entry.bytes;
      entry.bytes = bytes;
    },
    detach(publicEntry) {
      const entry = publicEntry as Entry;
      entries.delete(entry);
      residentBytes -= entry.bytes;
      entry.state = 'gone';
      entry.handle = 0n;
    },
    release(publicEntry) {
      release(publicEntry as Entry);
    },
    enter() {
      depth++;
    },
    exit(failed) {
      if (--depth > 0) return;
      unpinAll();
      if (!failed) makeRoom(0);
    },
    parkAll() {
      unpinAll();
      for (const entry of entries) if (entry.state === 'resident') park(entry);
    },
    forgetLibrary(lib) {
      for (const entry of entries) {
        if (entry.lib !== lib) continue;
        entries.delete(entry);
        if (entry.state === 'resident') residentBytes -= entry.bytes;
        if (entry.state === 'parked') {
          store.discard(entry.imageId);
          parkedBytes -= entry.bytes;
          parkedGrids--;
        }
        // The handle stays: a stale wrapper's next call names an object of a destroyed
        // instance and fails with PICO_INVALID_HANDLE, as it does with the pager off.
        entry.state = 'gone';
      }
    },
    get stats(): PagerStats {
      return {
        budgetBytes,
        codec,
        mode,
        store: store.kind,
        residentBytes,
        parkedGrids,
        parkedBytes,
        imageBytes: store.bytesHeld,
        farBytes: store.committedBytes,
        arenaBytes,
        parks,
        restores,
      };
    },
    close() {
      try {
        store.close();
      } finally {
        // Released even when the store fails to close; the store's error still propagates.
        try {
          raw.K7_nArena(0, BLOCK_LEAVES, 0, 0);
          module.removeFunction(sink);
          module.removeFunction(source);
        } catch {
          /* the module is going away with the runtime */
        }
      }
    },
  };
}
