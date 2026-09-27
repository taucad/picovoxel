import { describe, expect, it, vi } from 'vitest';

import { ComputePipelineCache } from '../spikes/webgpu/pipeline-cache.ts';

const createDevice = (messages: readonly Record<string, unknown>[] = []) => {
  const shaderModule = {
    getCompilationInfo: vi.fn(async () => ({ messages })),
  };
  const createShaderModule = vi.fn(() => shaderModule);
  const createComputePipelineAsync = vi.fn(async (descriptor: GPUComputePipelineDescriptor) => ({
    descriptor,
  }));
  const pushErrorScope = vi.fn();
  const popErrorScope = vi.fn<() => Promise<GPUError | null>>(async () => null);
  return {
    createComputePipelineAsync,
    createShaderModule,
    device: {
      createComputePipelineAsync,
      createShaderModule,
      popErrorScope,
      pushErrorScope,
    } as unknown as GPUDevice,
    popErrorScope,
    pushErrorScope,
  };
};

describe('ComputePipelineCache', () => {
  it('keys pipelines on shader identity, entry point, and normalized specialization', async () => {
    const { createComputePipelineAsync, createShaderModule, device } = createDevice();
    const cache = new ComputePipelineCache(device, {
      empty: '@compute fn main() {}',
    });

    const first = await cache.get({
      constants: { Z: 2, A: 1 },
      entryPoint: 'main',
      shaderId: 'empty',
    });
    const same = await cache.get({
      constants: { A: 1, Z: 2 },
      entryPoint: 'main',
      shaderId: 'empty',
    });
    const specialized = await cache.get({
      constants: { A: 1, Z: 4 },
      entryPoint: 'main',
      shaderId: 'empty',
    });

    expect(same).toBe(first);
    expect(specialized).not.toBe(first);
    expect(createShaderModule).toHaveBeenCalledTimes(1);
    expect(createComputePipelineAsync).toHaveBeenCalledTimes(2);
  });

  it('surfaces WGSL compilation diagnostics before pipeline creation', async () => {
    const { createComputePipelineAsync, device } = createDevice([
      {
        lineNum: 7,
        linePos: 4,
        message: 'unknown identifier',
        type: 'error',
      },
    ]);
    const cache = new ComputePipelineCache(device, {
      broken: '@compute fn main() {}',
    });

    await expect(cache.get({ entryPoint: 'main', shaderId: 'broken' })).rejects.toThrow(
      'broken:7:4: unknown identifier',
    );
    expect(createComputePipelineAsync).not.toHaveBeenCalled();
  });

  it('surfaces validation error scopes from asynchronous pipeline creation', async () => {
    const fixture = createDevice();
    fixture.popErrorScope.mockResolvedValueOnce({
      message: 'workgroup size exceeds requested limit',
    } as GPUValidationError);
    const cache = new ComputePipelineCache(fixture.device, {
      empty: '@compute fn main() {}',
    });

    await expect(cache.get({ entryPoint: 'main', shaderId: 'empty' })).rejects.toThrow(
      'workgroup size exceeds requested limit',
    );
    expect(fixture.pushErrorScope).toHaveBeenCalledWith('validation');
  });
});
