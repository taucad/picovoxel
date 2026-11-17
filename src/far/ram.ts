// RAM backend: JS-owned segments beside the wasm heap.
//
// The default is resizable-ArrayBuffer segments: each grows on demand up to
// `segmentBytes` and is shrunk with resize(0) the moment its last extent is
// released, so resident memory follows the bytes actually held. Where
// resizable buffers are missing, plain segments are allocated whole and dropped
// when empty. A RangeError from the host (no memory for a segment) is the store
// being full.

import { FarStoreError, type ExtentBackend } from './store.ts';

/** `ArrayBuffer` with the ES2024 resizable members, typed locally (the lib target is ES2023). */
interface ResizableArrayBuffer extends ArrayBuffer {
  resize(byteLength: number): void;
}
type ResizableArrayBufferConstructor = new (
  byteLength: number,
  options: { maxByteLength: number },
) => ResizableArrayBuffer;

/** True when this engine can create resizable ArrayBuffers. */
export function resizableArrayBuffersAvailable(): boolean {
  try {
    const probe = new (ArrayBuffer as unknown as ResizableArrayBufferConstructor)(0, { maxByteLength: 16 });
    return typeof probe.resize === 'function';
  } catch {
    return false;
  }
}

export interface RamBackendOptions {
  /** Segment size in bytes (default 64 MiB); a multiple of `extentBytes`. */
  segmentBytes?: number;
  /** Extent size the extent store uses (default 1 MiB). */
  extentBytes?: number;
  /** Use resizable segments (default: when the engine supports them). */
  resizable?: boolean;
}

/** Segmented RAM backend for {@link createExtentStore}. */
export function createRamBackend(options: RamBackendOptions = {}): ExtentBackend {
  const segmentBytes = options.segmentBytes ?? 64 * 2 ** 20;
  const extentBytes = options.extentBytes ?? 2 ** 20;
  const resizable = options.resizable ?? resizableArrayBuffersAvailable();
  const perSegment = segmentBytes / extentBytes;
  const segments: Array<ArrayBuffer | undefined> = [];
  const used: number[] = [];
  const live = new Set<number>();

  const segmentFor = (index: number, end: number): ArrayBuffer => {
    try {
      let segment = segments[index];
      if (segment === undefined) {
        segment = resizable
          ? new (ArrayBuffer as unknown as ResizableArrayBufferConstructor)(0, {
              maxByteLength: segmentBytes,
            })
          : new ArrayBuffer(segmentBytes);
        segments[index] = segment;
      }
      if (segment.byteLength < end) {
        (segment as ResizableArrayBuffer).resize(
          Math.min(segmentBytes, Math.ceil(end / extentBytes) * extentBytes),
        );
      }
      return segment;
    } catch (cause) {
      throw new FarStoreError('full', 'far store: the host refused memory for a RAM segment', { cause });
    }
  };

  return {
    kind: 'ram',
    writeAt(position, bytes) {
      const index = Math.floor(position / segmentBytes);
      const within = position - index * segmentBytes;
      const extent = Math.floor(position / extentBytes);
      const segment = segmentFor(index, within + bytes.length);
      if (!live.has(extent)) {
        live.add(extent);
        used[index] = (used[index] ?? 0) + 1;
      }
      new Uint8Array(segment, within, bytes.length).set(bytes);
    },
    readAt(position, into) {
      const index = Math.floor(position / segmentBytes);
      const segment = segments[index];
      if (segment === undefined)
        throw new FarStoreError('io', `far store: read from an unwritten RAM segment ${index}`);
      into.set(new Uint8Array(segment, position - index * segmentBytes, into.length));
    },
    release(extent) {
      if (!live.delete(extent)) return;
      const index = Math.floor(extent / perSegment);
      used[index]! -= 1;
      if (used[index] === 0) {
        if (resizable) (segments[index] as ResizableArrayBuffer).resize(0);
        else segments[index] = undefined;
      }
    },
    committedBytes() {
      let total = 0;
      for (const segment of segments) total += segment?.byteLength ?? 0;
      return total;
    },
    close() {
      segments.length = 0;
      used.length = 0;
      live.clear();
    },
  };
}
