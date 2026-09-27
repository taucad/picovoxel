import {
  assertAccelerationEngaged,
  collectPairedSamples,
  summarizeBootstrapMedian,
  summarizePairedSamples,
} from '../../bench/stats.mjs';

import { CpuTapeProbe, type GyroidProbeParameters, type ProbeRun } from './cpu-tape-probe.ts';
import { planDispatch, type DispatchPlan } from './dispatch.ts';
import type { WebGpuCapabilityReport } from './device.ts';
import { ComputePipelineCache } from './pipeline-cache.ts';
import { TimestampProfiler, type GpuTiming } from './timestamp-profiler.ts';

const WORKGROUP_SIZE = 64;
const POINT_COUNTS = [1, 4, 16].map((mib) => mib * 1024 * 1024);
const MAX_POINT_COUNT = POINT_COUNTS.at(-1)!;
const REPEATS = 30;
const WARMUPS = 2;
const ACCURACY_TOLERANCE = 2e-4;

interface WebGpuRuntimeConstants {
  readonly bufferUsage: {
    readonly COPY_DST: number;
    readonly COPY_SRC: number;
    readonly MAP_READ: number;
    readonly STORAGE: number;
    readonly UNIFORM: number;
  };
  readonly mapMode: {
    readonly READ: number;
  };
}

const runtimeConstants = (): WebGpuRuntimeConstants => {
  const bufferUsage = Reflect.get(globalThis, 'GPUBufferUsage');
  const mapMode = Reflect.get(globalThis, 'GPUMapMode');
  if (typeof bufferUsage !== 'object' || typeof mapMode !== 'object') {
    throw new Error('WebGPU runtime constants are unavailable');
  }
  return {
    bufferUsage: bufferUsage as WebGpuRuntimeConstants['bufferUsage'],
    mapMode: mapMode as WebGpuRuntimeConstants['mapMode'],
  };
};

interface GpuProbeRun extends ProbeRun {
  readonly dispatch: DispatchPlan;
  readonly gpuTiming: GpuTiming;
}

class GpuGyroidProbe {
  readonly #bindGroup: GPUBindGroup;
  readonly #device: GPUDevice;
  readonly #maxWorkgroupsPerDimension: number;
  readonly #output: GPUBuffer;
  readonly #parameters: GPUBuffer;
  readonly #pipeline: GPUComputePipeline;
  readonly #readback: GPUBuffer;
  readonly #timestamps: TimestampProfiler;

  private constructor(options: {
    bindGroup: GPUBindGroup;
    device: GPUDevice;
    maxWorkgroupsPerDimension: number;
    output: GPUBuffer;
    parameters: GPUBuffer;
    pipeline: GPUComputePipeline;
    readback: GPUBuffer;
    timestamps: TimestampProfiler;
  }) {
    this.#bindGroup = options.bindGroup;
    this.#device = options.device;
    this.#maxWorkgroupsPerDimension = options.maxWorkgroupsPerDimension;
    this.#output = options.output;
    this.#parameters = options.parameters;
    this.#pipeline = options.pipeline;
    this.#readback = options.readback;
    this.#timestamps = options.timestamps;
  }

  static async create(
    device: GPUDevice,
    pipelines: ComputePipelineCache,
    report: WebGpuCapabilityReport,
  ): Promise<GpuGyroidProbe> {
    const { bufferUsage } = runtimeConstants();
    const byteLength = MAX_POINT_COUNT * Float32Array.BYTES_PER_ELEMENT;
    const output = device.createBuffer({
      label: 'picovoxel:p0:gyroid-output',
      size: byteLength,
      usage: bufferUsage.COPY_SRC | bufferUsage.STORAGE,
    });
    const readback = device.createBuffer({
      label: 'picovoxel:p0:gyroid-readback',
      size: byteLength,
      usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ,
    });
    const parameters = device.createBuffer({
      label: 'picovoxel:p0:gyroid-parameters',
      size: 48,
      usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM,
    });
    const pipeline = await pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'gyroid-unrolled',
    });
    const bindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: output } },
        { binding: 1, resource: { buffer: parameters } },
      ],
      label: 'picovoxel:p0:gyroid-bind-group',
      layout: pipeline.getBindGroupLayout(0),
    });
    const timestamps = new TimestampProfiler(device, report.features.requested.includes('timestamp-query'));
    return new GpuGyroidProbe({
      bindGroup,
      device,
      maxWorkgroupsPerDimension: report.limits.required.maxComputeWorkgroupsPerDimension,
      output,
      parameters,
      pipeline,
      readback,
      timestamps,
    });
  }

  #encodeParameters(parameters: GyroidProbeParameters): ArrayBuffer {
    const encoded = new ArrayBuffer(48);
    const view = new DataView(encoded);
    view.setUint32(0, parameters.elementCount, true);
    view.setUint32(4, parameters.width, true);
    view.setUint32(8, parameters.height, true);
    view.setUint32(12, 0, true);
    view.setFloat32(16, parameters.originX, true);
    view.setFloat32(20, parameters.originY, true);
    view.setFloat32(24, parameters.originZ, true);
    view.setFloat32(28, parameters.spacing, true);
    view.setFloat32(32, parameters.scale, true);
    view.setFloat32(36, parameters.threshold, true);
    return encoded;
  }

  async run(parameters: GyroidProbeParameters): Promise<GpuProbeRun> {
    const { mapMode } = runtimeConstants();
    const dispatch = planDispatch({
      elementCount: parameters.elementCount,
      maxWorkgroupsPerDimension: this.#maxWorkgroupsPerDimension,
      workgroupSize: WORKGROUP_SIZE,
    });
    const byteLength = parameters.elementCount * Float32Array.BYTES_PER_ELEMENT;
    const begin = performance.now();
    this.#device.queue.writeBuffer(this.#parameters, 0, this.#encodeParameters(parameters));
    const encoder = this.#device.createCommandEncoder({
      label: 'picovoxel:p0:gyroid-encoder',
    });
    const pass = this.#timestamps.beginPass(encoder, 'picovoxel:p0:gyroid-pass');
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.dispatchWorkgroups(dispatch.dispatchX, dispatch.dispatchY);
    pass.end();
    this.#timestamps.resolve(encoder);
    encoder.copyBufferToBuffer(this.#output, 0, this.#readback, 0, byteLength);
    this.#device.queue.submit([encoder.finish()]);
    const [, gpuTiming] = await Promise.all([
      this.#readback.mapAsync(mapMode.READ, 0, byteLength),
      this.#timestamps.read(),
    ]);
    const mapped = new Float32Array(this.#readback.getMappedRange(0, byteLength));
    const indices = Array.from(
      new Set(
        Array.from({ length: 257 }, (_, index) => Math.floor((index * (parameters.elementCount - 1)) / 256)),
      ),
    );
    const values = indices.map((index) => mapped[index]!);
    const checksum = values.reduce((sum, value) => sum + value, 0);
    const ms = performance.now() - begin;
    this.#readback.unmap();
    return {
      checksum,
      dispatch,
      gpuTiming,
      ms,
      sampleIndices: indices,
      sampleValues: values,
    };
  }

  destroy(): void {
    this.#output.destroy();
    this.#parameters.destroy();
    this.#readback.destroy();
    this.#timestamps.destroy();
  }
}

const compareSamples = (cpu: ProbeRun, gpu: GpuProbeRun) => {
  if (cpu.sampleIndices.length !== gpu.sampleIndices.length) {
    throw new Error('CPU/GPU gyroid sample sets differ');
  }
  let maxAbsoluteError = 0;
  let maxRelativeError = 0;
  for (let index = 0; index < cpu.sampleIndices.length; index += 1) {
    if (cpu.sampleIndices[index] !== gpu.sampleIndices[index]) {
      throw new Error('CPU/GPU gyroid sample indices differ');
    }
    const cpuValue = cpu.sampleValues[index]!;
    const gpuValue = gpu.sampleValues[index]!;
    const absoluteError = Math.abs(cpuValue - gpuValue);
    maxAbsoluteError = Math.max(maxAbsoluteError, absoluteError);
    maxRelativeError = Math.max(
      maxRelativeError,
      absoluteError / Math.max(Math.abs(cpuValue), Number.EPSILON),
    );
  }
  if (maxAbsoluteError > ACCURACY_TOLERANCE) {
    throw new Error(
      `Unrolled gyroid exceeds CPU-oracle tolerance: ${maxAbsoluteError} > ${ACCURACY_TOLERANCE}`,
    );
  }
  return {
    maxAbsoluteError,
    maxRelativeError,
    sampleCount: cpu.sampleIndices.length,
    tolerance: ACCURACY_TOLERANCE,
  };
};

export const runGyroidThroughputProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipelines: ComputePipelineCache;
  readonly report: WebGpuCapabilityReport;
}) => {
  const hardwareConcurrency = globalThis.navigator.hardwareConcurrency;
  const threadLimit = Math.min(12, hardwareConcurrency);
  if (threadLimit !== 12) {
    throw new Error(`P0 reference gate requires 12 CPU threads; navigator reports ${hardwareConcurrency}`);
  }

  const cpu = await CpuTapeProbe.create(MAX_POINT_COUNT);
  const gpu = await GpuGyroidProbe.create(options.device, options.pipelines, options.report);
  try {
    const sizes = [];
    let totalDispatches = 0;
    for (const elementCount of POINT_COUNTS) {
      const parameters: GyroidProbeParameters = {
        elementCount,
        height: 256,
        originX: -12,
        originY: -12,
        originZ: -12,
        scale: (2 * Math.PI) / 10,
        spacing: 0.1,
        threshold: 0.4,
        width: 256,
      };
      let lastCpu: ProbeRun | undefined;
      let lastGpu: GpuProbeRun | undefined;
      const gpuKernelMs: number[] = [];
      const paired = await collectPairedSamples({
        fast: async () => {
          lastGpu = await gpu.run(parameters);
          if (lastGpu.gpuTiming.gpuMs !== null) {
            gpuKernelMs.push(lastGpu.gpuTiming.gpuMs);
          }
          totalDispatches += 1;
          return lastGpu.ms;
        },
        repeats: REPEATS,
        slow: () => {
          lastCpu = cpu.run(parameters, threadLimit);
          return lastCpu.ms;
        },
        warmups: WARMUPS,
      });
      if (lastCpu === undefined || lastGpu === undefined) {
        throw new Error('Gyroid paired benchmark produced no samples');
      }
      if (cpu.lastThreadCount !== threadLimit) {
        throw new Error(
          `CPU comparator did not engage all ${threadLimit} TBB threads (${cpu.lastThreadCount} observed)`,
        );
      }
      const statistics = summarizePairedSamples(paired);
      sizes.push({
        accuracy: compareSamples(lastCpu, lastGpu),
        cpuThreads: {
          configured: threadLimit,
          observedInParallelBody: cpu.lastThreadCount,
        },
        elementCount,
        gpuDispatch: lastGpu.dispatch,
        gpuKernel:
          gpuKernelMs.length === 0
            ? { source: 'submit-fenced-wall' }
            : {
                source: 'timestamp-query',
                statistics: summarizeBootstrapMedian(gpuKernelMs.slice(WARMUPS)),
              },
        gpuOutputChecksum: lastGpu.checksum,
        statistics,
        throughput: {
          cpuEvaluationsPerMs: elementCount / statistics.slow.median,
          gpuEvaluationsPerMs: elementCount / statistics.fast.median,
        },
      });
    }

    const gate = sizes.at(-1)!;
    assertAccelerationEngaged({
      activeLane: 'gpu',
      adapter: options.report.adapter.vendor,
      dispatchCount: totalDispatches,
      requestedLane: 'gpu',
      resultConsumed: Number.isFinite(gate.gpuOutputChecksum) && gate.accuracy.sampleCount > 0,
    });
    return {
      decision: gate.statistics.ci95.low >= 2 ? 'go' : 'no-go',
      gate: {
        actualLower95: gate.statistics.ci95.low,
        requiredLower95: 2,
        size: gate.elementCount,
      },
      methodology: {
        cpu:
          '12-thread TBB C-ABI unrolled upper bound for the CPU tape math; ' +
          'identical generated points and f64 libm intermediates',
        fastLane: 'GPU dispatch + submit + full output readback/map + sampled consumption',
        repeats: REPEATS,
        warmups: WARMUPS,
      },
      sizes,
    };
  } finally {
    gpu.destroy();
    cpu.destroy();
  }
};
