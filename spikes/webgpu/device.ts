const LIMIT_NAMES = [
  'maxComputeInvocationsPerWorkgroup',
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxComputeWorkgroupsPerDimension',
  'maxComputeWorkgroupStorageSize',
] as const;

const OPTIONAL_FEATURES = ['shader-f16', 'timestamp-query', 'subgroups'] as const;

type LimitName = (typeof LIMIT_NAMES)[number];
type LimitTable = Readonly<Record<LimitName, number>>;

export const DEFAULT_WEBGPU_LIMITS: LimitTable = Object.freeze({
  maxBufferSize: 512 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxComputeWorkgroupStorageSize: 32 * 1024,
  maxStorageBufferBindingSize: 256 * 1024 * 1024,
});

export const MINIMUM_WEBGPU_LIMITS: LimitTable = Object.freeze({
  maxBufferSize: 256 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 128,
  maxComputeWorkgroupsPerDimension: 65_535,
  maxComputeWorkgroupStorageSize: 16 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
});

export interface WebGpuDiagnostic {
  readonly detail: string;
  readonly kind: 'device-lost' | 'uncaptured-error';
}

export interface WebGpuLimitDeficiency {
  readonly adapter: number;
  readonly limit: LimitName;
  readonly minimum: number;
}

export interface WebGpuCapabilityReport {
  readonly adapter: {
    readonly architecture: string;
    readonly description: string;
    readonly device: string;
    readonly subgroupMaxSize?: number;
    readonly subgroupMinSize?: number;
    readonly vendor: string;
  };
  readonly features: {
    readonly adapter: readonly string[];
    readonly requested: readonly GPUFeatureName[];
  };
  readonly limits: {
    readonly adapter: LimitTable;
    readonly desired: LimitTable;
    readonly required: LimitTable;
  };
}

export type WebGpuCapability =
  | {
      readonly status: 'available';
      readonly device: GPUDevice;
      readonly report: WebGpuCapabilityReport;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'api-missing' | 'adapter-unavailable';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'adapter-request-failed' | 'device-request-failed';
      readonly detail: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'insufficient-limits';
      readonly deficiencies: readonly WebGpuLimitDeficiency[];
    };

export interface RequestWebGpuDeviceOptions {
  readonly desiredLimits?: Partial<LimitTable>;
  readonly gpu?: GPU | null;
  readonly minimumLimits?: Partial<LimitTable>;
  readonly onDiagnostic?: (diagnostic: WebGpuDiagnostic) => void;
}

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const resolveGpu = (provided: GPU | null | undefined): GPU | null => {
  if (provided !== undefined) return provided;
  return globalThis.navigator?.gpu ?? null;
};

const readLimits = (limits: GPUSupportedLimits): LimitTable =>
  Object.freeze(Object.fromEntries(LIMIT_NAMES.map((name) => [name, limits[name]]))) as unknown as LimitTable;

const mergeLimits = (defaults: LimitTable, overrides: Partial<LimitTable> | undefined): LimitTable =>
  Object.freeze({ ...defaults, ...overrides });

const readAdapterInfo = (info: GPUAdapterInfo): WebGpuCapabilityReport['adapter'] => {
  const subgroup =
    info.subgroupMaxSize === undefined
      ? {}
      : {
          subgroupMaxSize: info.subgroupMaxSize,
          subgroupMinSize: info.subgroupMinSize,
        };
  return Object.freeze({
    architecture: info.architecture,
    description: info.description,
    device: info.device,
    ...subgroup,
    vendor: info.vendor,
  });
};

const attachDeviceDiagnostics = (
  device: GPUDevice,
  onDiagnostic: ((diagnostic: WebGpuDiagnostic) => void) | undefined,
): void => {
  if (onDiagnostic === undefined) return;
  device.addEventListener('uncapturederror', (event) => {
    onDiagnostic({ detail: event.error.message, kind: 'uncaptured-error' });
  });
  void device.lost.then(
    (info) => onDiagnostic({ detail: `${info.reason}: ${info.message}`, kind: 'device-lost' }),
    (error: unknown) => onDiagnostic({ detail: errorDetail(error), kind: 'device-lost' }),
  );
};

export const requestWebGpuDevice = async (
  options: RequestWebGpuDeviceOptions = {},
): Promise<WebGpuCapability> => {
  const gpu = resolveGpu(options.gpu);
  if (gpu === null) return { reason: 'api-missing', status: 'unavailable' };

  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (error) {
    return {
      detail: errorDetail(error),
      reason: 'adapter-request-failed',
      status: 'unavailable',
    };
  }
  if (adapter === null) return { reason: 'adapter-unavailable', status: 'unavailable' };

  const adapterLimits = readLimits(adapter.limits);
  const desiredLimits = mergeLimits(DEFAULT_WEBGPU_LIMITS, options.desiredLimits);
  const minimumLimits = mergeLimits(MINIMUM_WEBGPU_LIMITS, options.minimumLimits);
  const deficiencies = LIMIT_NAMES.flatMap((limit) =>
    adapterLimits[limit] < minimumLimits[limit]
      ? [{ adapter: adapterLimits[limit], limit, minimum: minimumLimits[limit] }]
      : [],
  );
  if (deficiencies.length > 0) {
    return { deficiencies, reason: 'insufficient-limits', status: 'unavailable' };
  }

  const requiredLimits = Object.freeze(
    Object.fromEntries(
      LIMIT_NAMES.map((limit) => [limit, Math.min(desiredLimits[limit], adapterLimits[limit])]),
    ),
  ) as unknown as LimitTable;
  const adapterFeatures = [...adapter.features.values()].sort();
  const requiredFeatures = OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  } catch (error) {
    return {
      detail: errorDetail(error),
      reason: 'device-request-failed',
      status: 'unavailable',
    };
  }

  attachDeviceDiagnostics(device, options.onDiagnostic);
  return {
    device,
    report: Object.freeze({
      adapter: readAdapterInfo(adapter.info),
      features: Object.freeze({
        adapter: Object.freeze(adapterFeatures),
        requested: Object.freeze([...requiredFeatures]),
      }),
      limits: Object.freeze({
        adapter: adapterLimits,
        desired: desiredLimits,
        required: requiredLimits,
      }),
    }),
    status: 'available',
  };
};
