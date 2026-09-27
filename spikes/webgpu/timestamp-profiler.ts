const TIMESTAMP_BYTES = 2 * BigUint64Array.BYTES_PER_ELEMENT;
const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  COPY_SRC: 0x0004,
  MAP_READ: 0x0001,
  QUERY_RESOLVE: 0x0200,
} as const;
const MAP_MODE_READ = 0x0001;

export type GpuTiming =
  | { readonly gpuMs: number; readonly source: 'timestamp-query' }
  | { readonly gpuMs: null; readonly source: 'submit-fenced-wall' };

export class TimestampProfiler {
  readonly #enabled: boolean;
  readonly #querySet?: GPUQuerySet;
  readonly #readback?: GPUBuffer;
  readonly #resolved?: GPUBuffer;

  constructor(device: GPUDevice, enabled: boolean) {
    this.#enabled = enabled;
    if (!enabled) return;
    this.#querySet = device.createQuerySet({
      count: 2,
      label: 'picovoxel:timestamp-query',
      type: 'timestamp',
    });
    this.#resolved = device.createBuffer({
      label: 'picovoxel:timestamp-resolved',
      size: TIMESTAMP_BYTES,
      usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC,
    });
    this.#readback = device.createBuffer({
      label: 'picovoxel:timestamp-readback',
      size: TIMESTAMP_BYTES,
      usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
    });
  }

  beginPass(encoder: GPUCommandEncoder, label: string): GPUComputePassEncoder {
    if (!this.#enabled) return encoder.beginComputePass({ label });
    return encoder.beginComputePass({
      label,
      timestampWrites: {
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
        querySet: this.#querySet!,
      },
    });
  }

  resolve(encoder: GPUCommandEncoder): void {
    if (!this.#enabled) return;
    encoder.resolveQuerySet(this.#querySet!, 0, 2, this.#resolved!, 0);
    encoder.copyBufferToBuffer(this.#resolved!, 0, this.#readback!, 0, TIMESTAMP_BYTES);
  }

  async read(): Promise<GpuTiming> {
    if (!this.#enabled) return { gpuMs: null, source: 'submit-fenced-wall' };
    await this.#readback!.mapAsync(MAP_MODE_READ, 0, TIMESTAMP_BYTES);
    const timestamps = new BigUint64Array(this.#readback!.getMappedRange(0, TIMESTAMP_BYTES));
    const begin = timestamps[0]!;
    const end = timestamps[1]!;
    this.#readback!.unmap();
    if (end < begin) throw new Error(`Invalid GPU timestamp order: ${begin} > ${end}`);
    return {
      gpuMs: Number(end - begin) / 1_000_000,
      source: 'timestamp-query',
    };
  }

  destroy(): void {
    this.#querySet?.destroy();
    this.#readback?.destroy();
    this.#resolved?.destroy();
  }
}
