import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WEBGPU_LIMITS,
  MINIMUM_WEBGPU_LIMITS,
  requestWebGpuDevice,
} from '../spikes/webgpu/device.ts';

const adapterInfo = {
  architecture: 'm2',
  description: 'Mock Metal adapter',
  device: 'mock-device',
  subgroupMaxSize: 32,
  subgroupMinSize: 4,
  vendor: 'mock-vendor',
};

const supportedLimits = {
  maxBufferSize: 384 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxComputeWorkgroupStorageSize: 32 * 1024,
  maxStorageBufferBindingSize: 192 * 1024 * 1024,
};

const createAdapter = (overrides: Record<string, unknown> = {}) => {
  const device = new EventTarget();
  Object.assign(device, { lost: new Promise(() => undefined) });
  const requestDevice = vi.fn(async () => device);
  const adapter = {
    features: new Set<GPUFeatureName>(['shader-f16', 'timestamp-query']),
    info: adapterInfo,
    limits: supportedLimits,
    requestDevice,
    ...overrides,
  };
  return { adapter, device, requestDevice };
};

describe('requestWebGpuDevice', () => {
  it('returns typed unavailability when navigator.gpu is absent', async () => {
    await expect(requestWebGpuDevice({ gpu: null })).resolves.toEqual({
      reason: 'api-missing',
      status: 'unavailable',
    });
  });

  it('requests a high-performance adapter without compatibility mode', async () => {
    const { adapter } = createAdapter();
    const requestAdapter = vi.fn(async (_options?: GPURequestAdapterOptions) => adapter);

    const result = await requestWebGpuDevice({ gpu: { requestAdapter } as unknown as GPU });

    expect(result.status).toBe('available');
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(requestAdapter.mock.calls[0]?.[0]).not.toHaveProperty('featureLevel');
  });

  it('clamps desired limits and requests only adapter-supported optional features', async () => {
    const { adapter, requestDevice } = createAdapter();
    const requestAdapter = vi.fn(async (_options?: GPURequestAdapterOptions) => adapter);

    const result = await requestWebGpuDevice({ gpu: { requestAdapter } as unknown as GPU });

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(requestDevice).toHaveBeenCalledWith({
      requiredFeatures: ['shader-f16', 'timestamp-query'],
      requiredLimits: {
        maxBufferSize: supportedLimits.maxBufferSize,
        maxComputeInvocationsPerWorkgroup: DEFAULT_WEBGPU_LIMITS.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupsPerDimension: DEFAULT_WEBGPU_LIMITS.maxComputeWorkgroupsPerDimension,
        maxComputeWorkgroupStorageSize: DEFAULT_WEBGPU_LIMITS.maxComputeWorkgroupStorageSize,
        maxStorageBufferBindingSize: supportedLimits.maxStorageBufferBindingSize,
      },
    });
    expect(result.report.features).toEqual({
      adapter: ['shader-f16', 'timestamp-query'],
      requested: ['shader-f16', 'timestamp-query'],
    });
    expect(result.report.limits.adapter).toEqual(supportedLimits);
    expect(result.report.limits.desired).toEqual(DEFAULT_WEBGPU_LIMITS);
    expect(result.report.limits.required).toEqual({
      maxBufferSize: supportedLimits.maxBufferSize,
      maxComputeInvocationsPerWorkgroup: DEFAULT_WEBGPU_LIMITS.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupsPerDimension: DEFAULT_WEBGPU_LIMITS.maxComputeWorkgroupsPerDimension,
      maxComputeWorkgroupStorageSize: DEFAULT_WEBGPU_LIMITS.maxComputeWorkgroupStorageSize,
      maxStorageBufferBindingSize: supportedLimits.maxStorageBufferBindingSize,
    });
  });

  it('returns typed unavailability when no adapter is available', async () => {
    const requestAdapter = vi.fn(async () => null);

    await expect(requestWebGpuDevice({ gpu: { requestAdapter } as unknown as GPU })).resolves.toEqual({
      reason: 'adapter-unavailable',
      status: 'unavailable',
    });
  });

  it('rejects adapters below a declared kernel floor before requesting a device', async () => {
    const { adapter, requestDevice } = createAdapter({
      limits: {
        ...supportedLimits,
        maxComputeInvocationsPerWorkgroup: MINIMUM_WEBGPU_LIMITS.maxComputeInvocationsPerWorkgroup - 1,
      },
    });
    const requestAdapter = vi.fn(async () => adapter);

    const result = await requestWebGpuDevice({ gpu: { requestAdapter } as unknown as GPU });

    expect(result).toEqual({
      deficiencies: [
        {
          adapter: MINIMUM_WEBGPU_LIMITS.maxComputeInvocationsPerWorkgroup - 1,
          limit: 'maxComputeInvocationsPerWorkgroup',
          minimum: MINIMUM_WEBGPU_LIMITS.maxComputeInvocationsPerWorkgroup,
        },
      ],
      reason: 'insufficient-limits',
      status: 'unavailable',
    });
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('converts adapter and device failures to typed capability results', async () => {
    const adapterFailure = new Error('adapter boom');
    await expect(
      requestWebGpuDevice({
        gpu: {
          requestAdapter: vi.fn(async () => {
            throw adapterFailure;
          }),
        } as unknown as GPU,
      }),
    ).resolves.toEqual({
      detail: 'adapter boom',
      reason: 'adapter-request-failed',
      status: 'unavailable',
    });

    const { adapter } = createAdapter({
      requestDevice: vi.fn(async () => {
        throw new Error('device boom');
      }),
    });
    await expect(
      requestWebGpuDevice({
        gpu: { requestAdapter: vi.fn(async () => adapter) } as unknown as GPU,
      }),
    ).resolves.toEqual({
      detail: 'device boom',
      reason: 'device-request-failed',
      status: 'unavailable',
    });
  });
});
