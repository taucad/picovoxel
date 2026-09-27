import { describe, expect, it, vi } from 'vitest';

import { TimestampProfiler } from '../spikes/webgpu/timestamp-profiler.ts';

const timestampBytes = (begin: bigint, end: bigint): ArrayBuffer => {
  const buffer = new ArrayBuffer(16);
  const values = new BigUint64Array(buffer);
  values[0] = begin;
  values[1] = end;
  return buffer;
};

describe('TimestampProfiler', () => {
  it('encodes, resolves, and reads a timestamp-query pair', async () => {
    const resolved = { destroy: vi.fn() };
    const mapped = {
      destroy: vi.fn(),
      getMappedRange: vi.fn(() => timestampBytes(1_000n, 5_001_000n)),
      mapAsync: vi.fn(() => Promise.resolve()),
      unmap: vi.fn(),
    };
    const querySet = { destroy: vi.fn() };
    const device = {
      createBuffer: vi.fn().mockReturnValueOnce(resolved).mockReturnValueOnce(mapped),
      createQuerySet: vi.fn(() => querySet),
    } as unknown as GPUDevice;
    const pass = {};
    const beginComputePass = vi.fn(() => pass);
    const copyBufferToBuffer = vi.fn();
    const resolveQuerySet = vi.fn();
    const encoder = { beginComputePass, copyBufferToBuffer, resolveQuerySet } as unknown as GPUCommandEncoder;
    const profiler = new TimestampProfiler(device, true);

    expect(profiler.beginPass(encoder, 'kernel')).toBe(pass);
    profiler.resolve(encoder);
    await expect(profiler.read()).resolves.toEqual({
      gpuMs: 5,
      source: 'timestamp-query',
    });

    expect(beginComputePass).toHaveBeenCalledWith({
      label: 'kernel',
      timestampWrites: {
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
        querySet,
      },
    });
    expect(resolveQuerySet).toHaveBeenCalledWith(querySet, 0, 2, resolved, 0);
    expect(copyBufferToBuffer).toHaveBeenCalledWith(resolved, 0, mapped, 0, 16);
    expect(mapped.mapAsync).toHaveBeenCalledWith(1, 0, 16);
    expect(mapped.unmap).toHaveBeenCalledTimes(1);
  });

  it('degrades explicitly to submit-fenced wall time when unsupported', async () => {
    const createQuerySet = vi.fn();
    const device = {
      createBuffer: vi.fn(),
      createQuerySet,
    } as unknown as GPUDevice;
    const pass = {};
    const beginComputePass = vi.fn(() => pass);
    const encoder = { beginComputePass } as unknown as GPUCommandEncoder;
    const profiler = new TimestampProfiler(device, false);

    expect(profiler.beginPass(encoder, 'kernel')).toBe(pass);
    await expect(profiler.read()).resolves.toEqual({
      gpuMs: null,
      source: 'submit-fenced-wall',
    });
    expect(beginComputePass).toHaveBeenCalledWith({ label: 'kernel' });
    expect(createQuerySet).not.toHaveBeenCalled();
  });
});
