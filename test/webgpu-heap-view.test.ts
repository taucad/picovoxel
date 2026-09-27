import { describe, expect, it, vi } from 'vitest';

import { createHeapStager } from '../spikes/webgpu/heap-view.ts';

describe('createHeapStager', () => {
  it('uses a resizable buffer when WebAssembly exposes one', () => {
    const buffer = new ArrayBuffer(32);
    const memory = {
      buffer,
      toResizableBuffer: vi.fn(() => buffer),
    };
    const writeBuffer = vi.fn();
    const stager = createHeapStager(memory);

    new Uint8Array(buffer).set([4, 5, 6], 8);
    stager.writeBuffer({ writeBuffer } as unknown as GPUQueue, {} as GPUBuffer, { heapOffset: 8, size: 3 });

    expect(stager.mode).toBe('rab');
    expect(memory.toResizableBuffer).toHaveBeenCalledTimes(1);
    expect([...writeBuffer.mock.calls[0]![2]]).toEqual([4, 5, 6]);
  });

  it('recreates non-RAB heap views synchronously after memory growth', () => {
    const wasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const memory = {
      get buffer() {
        return wasmMemory.buffer;
      },
    };
    const captured: number[][] = [];
    const queue = {
      writeBuffer: (
        _destination: GPUBuffer,
        _destinationOffset: number,
        source: ArrayBufferView<ArrayBufferLike>,
      ) => captured.push([...new Uint8Array(source.buffer, source.byteOffset, source.byteLength)]),
    } as unknown as GPUQueue;
    const stager = createHeapStager(memory);

    new Uint8Array(wasmMemory.buffer).set([1, 2, 3], 0);
    stager.writeBuffer(queue, {} as GPUBuffer, { heapOffset: 0, size: 3 });
    wasmMemory.grow(1);
    new Uint8Array(wasmMemory.buffer).set([7, 8, 9], 0);
    stager.writeBuffer(queue, {} as GPUBuffer, { heapOffset: 0, size: 3 });

    expect(stager.mode).toBe('ephemeral');
    expect(captured).toEqual([
      [1, 2, 3],
      [7, 8, 9],
    ]);
  });

  it('copies mapped readback bytes into the current heap buffer', () => {
    const wasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const stager = createHeapStager({
      get buffer() {
        return wasmMemory.buffer;
      },
    });

    stager.copyToHeap(new Uint8Array([10, 11, 12]), { heapOffset: 4 });
    wasmMemory.grow(1);
    stager.copyToHeap(new Uint8Array([20, 21, 22]), { heapOffset: 4 });

    expect([...new Uint8Array(wasmMemory.buffer, 4, 3)]).toEqual([20, 21, 22]);
  });
});
