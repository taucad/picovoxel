// Far store: byte images outside the wasm heap, addressed by numeric id.
//
// A kernel's scratch working memory (I6): nothing in here knows about grids,
// sessions or picovoxel. An image is written once, front to back, read back by
// position and discarded. The extent store maps images onto fixed-size extents
// of a positional backend (RAM segments or one scratch file) with a free list,
// so space is reused the moment an image is discarded and never waits on the
// garbage collector.

/** Why a far-store operation failed. `'full'`: the store reached its size bound or the host refused memory or disk. */
export type FarStoreErrorKind = 'full' | 'io';

/** A far-store failure. Carries no kernel types, so a caller maps it to its own error. */
export class FarStoreError extends Error {
  readonly kind: FarStoreErrorKind;

  constructor(kind: FarStoreErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FarStoreError';
    this.kind = kind;
  }
}

/** Where a far store lives: JS memory beside the heap, or a scratch file. */
type FarStoreKind = 'ram' | 'disk';

/** The byte store outside the wasm heap. Ids are the caller's; one writer at a time. */
export interface FarStore {
  readonly kind: FarStoreKind;
  /** Appends `chunk` to image `id`, creating the image on first write. */
  write(id: number, chunk: Uint8Array): void;
  /** Copies image bytes from `offset` into `into`; returns the count copied (0 at the end or for an unknown id). */
  read(id: number, offset: number, into: Uint8Array): number;
  /** Drops image `id` and returns its space. Unknown ids are ignored. */
  discard(id: number): void;
  /** Image bytes the store holds. */
  readonly bytesHeld: number;
  /** Bytes the store occupies on its host: committed RAM, or the scratch file's used extents. */
  readonly committedBytes: number;
  /** Releases the backend (closes and removes a scratch file). Idempotent. */
  close(): void;
}

/** A positional byte device the extent store writes through. */
export interface ExtentBackend {
  readonly kind: FarStoreKind;
  writeAt(position: number, bytes: Uint8Array): void;
  readAt(position: number, into: Uint8Array): void;
  /** Extent `index` holds no data any more (a RAM backend can return its pages). */
  release(index: number): void;
  /** Bytes the backend holds on its host. */
  committedBytes(): number;
  close(): void;
}

export interface ExtentStoreOptions {
  /** Extent size in bytes (default 1 MiB). Must divide the backend's segment size. */
  extentBytes?: number;
  /** Size bound: writes that need an extent beyond it fail with kind `'full'` (default unbounded). */
  maxBytes?: number;
}

/** Fixed-size extents with a free list over any positional backend. */
export function createExtentStore(backend: ExtentBackend, options: ExtentStoreOptions = {}): FarStore {
  const extentBytes = options.extentBytes ?? 1 << 20;
  const maxExtents = Math.floor((options.maxBytes ?? Number.POSITIVE_INFINITY) / extentBytes);
  const images = new Map<number, { extents: number[]; length: number }>();
  const free: number[] = [];
  let high = 0;
  let held = 0;
  let closed = false;

  const takeExtent = (): number => {
    const reused = free.pop();
    if (reused !== undefined) return reused;
    if (high >= maxExtents) {
      throw new FarStoreError(
        'full',
        `far store: the ${backend.kind} store reached its size bound of ${maxExtents * extentBytes} bytes`,
      );
    }
    return high++;
  };

  return {
    kind: backend.kind,
    write(id, chunk) {
      if (closed) throw new FarStoreError('io', 'far store: write after close');
      let image = images.get(id);
      if (!image) images.set(id, (image = { extents: [], length: 0 }));
      let done = 0;
      while (done < chunk.length) {
        const within = image.length % extentBytes;
        if (within === 0) image.extents.push(takeExtent());
        const take = Math.min(extentBytes - within, chunk.length - done);
        backend.writeAt(image.extents.at(-1)! * extentBytes + within, chunk.subarray(done, done + take));
        image.length += take;
        held += take;
        done += take;
      }
    },
    read(id, offset, into) {
      const image = images.get(id);
      if (!image) return 0;
      let done = 0;
      while (done < into.length && offset + done < image.length) {
        const at = offset + done;
        const within = at % extentBytes;
        const take = Math.min(extentBytes - within, into.length - done, image.length - at);
        backend.readAt(
          image.extents[Math.floor(at / extentBytes)]! * extentBytes + within,
          into.subarray(done, done + take),
        );
        done += take;
      }
      return done;
    },
    discard(id) {
      const image = images.get(id);
      if (!image) return;
      images.delete(id);
      held -= image.length;
      for (const extent of image.extents) {
        free.push(extent);
        backend.release(extent);
      }
    },
    get bytesHeld() {
      return held;
    },
    get committedBytes() {
      return backend.committedBytes();
    },
    close() {
      if (closed) return;
      closed = true;
      images.clear();
      free.length = 0;
      held = 0;
      high = 0;
      backend.close();
    },
  };
}
