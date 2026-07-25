interface WasmMemoryLike {
  readonly buffer: ArrayBufferLike;
  readonly toResizableBuffer?: () => ArrayBuffer;
}

interface HeapWrite {
  readonly destinationOffset?: number;
  readonly heapOffset: number;
  readonly size: number;
}

interface HeapCopy {
  readonly heapOffset: number;
}

export interface HeapStager {
  readonly mode: 'ephemeral' | 'rab';
  readonly copyToHeap: (source: Uint8Array, copy: HeapCopy) => void;
  readonly writeBuffer: (queue: GPUQueue, destination: GPUBuffer, write: HeapWrite) => void;
}

export const createHeapStager = (memory: WasmMemoryLike): HeapStager => {
  const resizableBuffer = memory.toResizableBuffer?.();

  return {
    mode: resizableBuffer === undefined ? 'ephemeral' : 'rab',
    copyToHeap: (source, copy) => {
      // On non-RAB glue, reading memory.buffer and creating the view must remain
      // in this same synchronous frame: memory.grow() detaches older buffers.
      const destination = new Uint8Array(resizableBuffer ?? memory.buffer, copy.heapOffset, source.byteLength);
      destination.set(source);
    },
    writeBuffer: (queue, destination, write) => {
      // queue.writeBuffer consumes the source synchronously, so no heap-backed
      // view survives this frame on the non-RAB path.
      const source = new Uint8Array(resizableBuffer ?? memory.buffer, write.heapOffset, write.size);
      queue.writeBuffer(destination, write.destinationOffset ?? 0, source);
    },
  };
};
