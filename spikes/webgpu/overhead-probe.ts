import {
  assertAccelerationEngaged,
  collectPairedSamples,
  fitLinearCost,
  summarizeBootstrapMedian,
  summarizePairedSamples,
} from '../../bench/stats.mjs';

import { planDispatch } from './dispatch.ts';
import type { WebGpuCapabilityReport } from './device.ts';
import { ComputePipelineCache } from './pipeline-cache.ts';
import { TimestampProfiler } from './timestamp-profiler.ts';

const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  COPY_SRC: 0x0004,
  MAP_READ: 0x0001,
  STORAGE: 0x0080,
  UNIFORM: 0x0040,
} as const;
const MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 64;
const REPEATS = 30;
const WARMUPS = 2;
const RUNS_PER_CURVE_POINT = REPEATS + WARMUPS;
const CURVE_BYTES = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024, 128 * 1024 * 1024, 256 * 1024 * 1024];

const collectSamples = async (body: () => Promise<number>): Promise<number[]> => {
  for (let index = 0; index < WARMUPS; index += 1) await body();
  const samples = [];
  for (let index = 0; index < REPEATS; index += 1) samples.push(await body());
  return samples;
};

const timestampEnabled = (report: WebGpuCapabilityReport): boolean =>
  report.features.requested.includes('timestamp-query');

const runEmptyDispatches = async (
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  dispatchCount: number,
  separateSubmits: boolean,
): Promise<number> => {
  const begin = performance.now();
  if (separateSubmits) {
    for (let index = 0; index < dispatchCount; index += 1) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  } else {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (let index = 0; index < dispatchCount; index += 1) {
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  return performance.now() - begin;
};

const runDispatchProbe = async (device: GPUDevice, pipelines: ComputePipelineCache) => {
  const pipeline = await pipelines.get({
    constants: { ELEMENT_COUNT: 1, WORKGROUP_SIZE },
    entryPoint: 'main',
    shaderId: 'empty',
  });
  const sequentialDispatches = 256;
  const overheadUs = await collectSamples(async () => {
    const elapsed = await runEmptyDispatches(device, pipeline, sequentialDispatches, false);
    return (elapsed * 1_000) / sequentialDispatches;
  });
  const batching = await collectPairedSamples({
    fast: () => runEmptyDispatches(device, pipeline, 16, false),
    repeats: REPEATS,
    slow: () => runEmptyDispatches(device, pipeline, 16, true),
    warmups: WARMUPS,
  });
  return {
    batching16: summarizePairedSamples(batching),
    dispatchesPerSample: sequentialDispatches,
    overheadUs: summarizeBootstrapMedian(overheadUs),
  };
};

const runReadbackProbe = async (device: GPUDevice) => {
  const curve = [];
  let consumedMappings = 0;
  for (const byteLength of CURVE_BYTES) {
    const source = device.createBuffer({
      label: `picovoxel:p0:readback-source:${byteLength}`,
      size: byteLength,
      usage: BUFFER_USAGE.COPY_SRC,
    });
    const readback = device.createBuffer({
      label: `picovoxel:p0:readback-map:${byteLength}`,
      size: byteLength,
      usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
    });
    try {
      const samples = await collectSamples(async () => {
        const begin = performance.now();
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, 0, readback, 0, byteLength);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(MAP_MODE_READ, 0, byteLength);
        const mapped = new Uint8Array(readback.getMappedRange(0, byteLength));
        if (mapped.byteLength !== byteLength) {
          throw new Error(`Readback mapped ${mapped.byteLength}/${byteLength} bytes`);
        }
        void mapped[0];
        void mapped[mapped.length - 1];
        consumedMappings += 1;
        const ms = performance.now() - begin;
        readback.unmap();
        return ms;
      });
      curve.push({
        bytes: byteLength,
        statistics: summarizeBootstrapMedian(samples),
      });
    } finally {
      source.destroy();
      readback.destroy();
    }
  }
  return {
    consumedMappings,
    costModel: fitLinearCost(curve.map(({ bytes, statistics }) => ({ bytes, ms: statistics.median }))),
    curve,
  };
};

const encodeSaxpyParameters = (elementCount: number): ArrayBuffer => {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setFloat32(0, 2, true);
  view.setUint32(4, elementCount, true);
  return buffer;
};

const runSaxpyProbe = async (device: GPUDevice, pipelines: ComputePipelineCache, report: WebGpuCapabilityReport) => {
  const pipeline = await pipelines.get({
    constants: { WORKGROUP_SIZE },
    entryPoint: 'main',
    shaderId: 'saxpy',
  });
  const timestamps = new TimestampProfiler(device, timestampEnabled(report));
  const curve = [];
  try {
    for (const byteLength of CURVE_BYTES) {
      const elementCount = byteLength / Float32Array.BYTES_PER_ELEMENT;
      const xValues = device.createBuffer({
        label: `picovoxel:p0:saxpy-x:${byteLength}`,
        size: byteLength,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.STORAGE,
      });
      const yValues = device.createBuffer({
        label: `picovoxel:p0:saxpy-y:${byteLength}`,
        size: byteLength,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.STORAGE,
      });
      const parameters = device.createBuffer({
        label: `picovoxel:p0:saxpy-parameters:${byteLength}`,
        size: 16,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.UNIFORM,
      });
      const readback = device.createBuffer({
        label: `picovoxel:p0:saxpy-readback:${byteLength}`,
        size: 4,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
      });
      const bindGroup = device.createBindGroup({
        entries: [
          { binding: 0, resource: { buffer: xValues } },
          { binding: 1, resource: { buffer: yValues } },
          { binding: 2, resource: { buffer: parameters } },
        ],
        layout: pipeline.getBindGroupLayout(0),
      });
      const dispatch = planDispatch({
        elementCount,
        maxWorkgroupsPerDimension: report.limits.required.maxComputeWorkgroupsPerDimension,
        workgroupSize: WORKGROUP_SIZE,
      });
      device.queue.writeBuffer(xValues, 0, new Float32Array([1]));
      device.queue.writeBuffer(yValues, 0, new Float32Array([1]));
      device.queue.writeBuffer(parameters, 0, encodeSaxpyParameters(elementCount));
      const gpuMs: number[] = [];
      let lastValue = Number.NaN;
      try {
        const wallMs = await collectSamples(async () => {
          const begin = performance.now();
          const encoder = device.createCommandEncoder();
          const pass = timestamps.beginPass(encoder, 'picovoxel:p0:saxpy-pass');
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(dispatch.dispatchX, dispatch.dispatchY);
          pass.end();
          timestamps.resolve(encoder);
          encoder.copyBufferToBuffer(yValues, 0, readback, 0, 4);
          device.queue.submit([encoder.finish()]);
          const [, gpuTiming] = await Promise.all([readback.mapAsync(MAP_MODE_READ, 0, 4), timestamps.read()]);
          lastValue = new Float32Array(readback.getMappedRange(0, 4))[0]!;
          const ms = performance.now() - begin;
          readback.unmap();
          if (gpuTiming.gpuMs !== null) gpuMs.push(gpuTiming.gpuMs);
          return ms;
        });
        const expectedValue = 1 + 2 * RUNS_PER_CURVE_POINT;
        if (lastValue !== expectedValue) {
          throw new Error(`Saxpy oracle mismatch: ${lastValue} != ${expectedValue}`);
        }
        const wall = summarizeBootstrapMedian(wallMs);
        const measuredGpuMs = gpuMs.slice(WARMUPS);
        const gpu =
          measuredGpuMs.length > 0 && measuredGpuMs.every((sample) => sample > 0)
            ? summarizeBootstrapMedian(measuredGpuMs)
            : null;
        const effectiveMs = gpu?.median ?? wall.median;
        curve.push({
          bytes: byteLength,
          dispatch,
          effectiveBandwidthGBps: (3 * byteLength) / (effectiveMs * 1_000_000),
          gpu:
            gpu === null
              ? {
                  samplesMs: measuredGpuMs,
                  source: gpuMs.length === 0 ? 'submit-fenced-wall' : 'timestamp-resolution-insufficient',
                }
              : { source: 'timestamp-query', statistics: gpu },
          output: lastValue,
          expectedOutput: expectedValue,
          wall,
        });
      } finally {
        xValues.destroy();
        yValues.destroy();
        parameters.destroy();
        readback.destroy();
      }
    }
  } finally {
    timestamps.destroy();
  }
  return curve;
};

interface ReductionPass {
  readonly bindGroup: GPUBindGroup;
  readonly dispatchX: number;
  readonly dispatchY: number;
  readonly output: GPUBuffer;
  readonly outputCount: number;
  readonly parameters: GPUBuffer;
}

const runReductionProbe = async (
  device: GPUDevice,
  pipelines: ComputePipelineCache,
  report: WebGpuCapabilityReport,
) => {
  const pipeline = await pipelines.get({
    constants: { WORKGROUP_SIZE },
    entryPoint: 'main',
    shaderId: 'reduce',
  });
  const timestamps = new TimestampProfiler(device, timestampEnabled(report));
  const curve = [];
  try {
    for (const byteLength of CURVE_BYTES) {
      const elementCount = byteLength / Float32Array.BYTES_PER_ELEMENT;
      const scratchBytes = Math.ceil(elementCount / WORKGROUP_SIZE) * Float32Array.BYTES_PER_ELEMENT;
      const input = device.createBuffer({
        size: byteLength,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.STORAGE,
      });
      const scratchA = device.createBuffer({
        size: scratchBytes,
        usage: BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.STORAGE,
      });
      const scratchB = device.createBuffer({
        size: scratchBytes,
        usage: BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.STORAGE,
      });
      const readback = device.createBuffer({
        size: 4,
        usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
      });
      device.queue.writeBuffer(input, 0, new Float32Array([1]));

      const passes: ReductionPass[] = [];
      let currentInput = input;
      let currentCount = elementCount;
      let writeA = true;
      let effectiveBytes = 0;
      while (currentCount > 1) {
        const outputCount = Math.ceil(currentCount / WORKGROUP_SIZE);
        const output = writeA ? scratchA : scratchB;
        const parameters = device.createBuffer({
          size: 16,
          usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.UNIFORM,
        });
        device.queue.writeBuffer(parameters, 0, new Uint32Array([currentCount, 0, 0, 0]));
        const dispatch = planDispatch({
          elementCount: currentCount,
          maxWorkgroupsPerDimension: report.limits.required.maxComputeWorkgroupsPerDimension,
          workgroupSize: WORKGROUP_SIZE,
        });
        passes.push({
          bindGroup: device.createBindGroup({
            entries: [
              { binding: 0, resource: { buffer: currentInput } },
              { binding: 1, resource: { buffer: output } },
              { binding: 2, resource: { buffer: parameters } },
            ],
            layout: pipeline.getBindGroupLayout(0),
          }),
          dispatchX: dispatch.dispatchX,
          dispatchY: dispatch.dispatchY,
          output,
          outputCount,
          parameters,
        });
        effectiveBytes += (currentCount + outputCount) * Float32Array.BYTES_PER_ELEMENT;
        currentInput = output;
        currentCount = outputCount;
        writeA = !writeA;
      }

      const gpuMs: number[] = [];
      let lastValue = Number.NaN;
      try {
        const wallMs = await collectSamples(async () => {
          const begin = performance.now();
          const encoder = device.createCommandEncoder();
          const pass = timestamps.beginPass(encoder, 'picovoxel:p0:reduce-pass');
          pass.setPipeline(pipeline);
          for (const reduction of passes) {
            pass.setBindGroup(0, reduction.bindGroup);
            pass.dispatchWorkgroups(reduction.dispatchX, reduction.dispatchY);
          }
          pass.end();
          timestamps.resolve(encoder);
          encoder.copyBufferToBuffer(passes.at(-1)!.output, 0, readback, 0, 4);
          device.queue.submit([encoder.finish()]);
          const [, gpuTiming] = await Promise.all([readback.mapAsync(MAP_MODE_READ, 0, 4), timestamps.read()]);
          lastValue = new Float32Array(readback.getMappedRange(0, 4))[0]!;
          const ms = performance.now() - begin;
          readback.unmap();
          if (gpuTiming.gpuMs !== null) gpuMs.push(gpuTiming.gpuMs);
          return ms;
        });
        if (Math.abs(lastValue - 1) > 1e-6) {
          throw new Error(`Reduction oracle mismatch: ${lastValue} != 1`);
        }
        const wall = summarizeBootstrapMedian(wallMs);
        const measuredGpuMs = gpuMs.slice(WARMUPS);
        const gpu =
          measuredGpuMs.length > 0 && measuredGpuMs.every((sample) => sample > 0)
            ? summarizeBootstrapMedian(measuredGpuMs)
            : null;
        const effectiveMs = gpu?.median ?? wall.median;
        curve.push({
          bytes: byteLength,
          effectiveBandwidthGBps: effectiveBytes / (effectiveMs * 1_000_000),
          gpu:
            gpu === null
              ? {
                  samplesMs: measuredGpuMs,
                  source: gpuMs.length === 0 ? 'submit-fenced-wall' : 'timestamp-resolution-insufficient',
                }
              : { source: 'timestamp-query', statistics: gpu },
          output: lastValue,
          passCount: passes.length,
          wall,
        });
      } finally {
        for (const reduction of passes) reduction.parameters.destroy();
        input.destroy();
        scratchA.destroy();
        scratchB.destroy();
        readback.destroy();
      }
    }
  } finally {
    timestamps.destroy();
  }
  return curve;
};

export const runOverheadProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipelines: ComputePipelineCache;
  readonly report: WebGpuCapabilityReport;
}) => {
  const dispatch = await runDispatchProbe(options.device, options.pipelines);
  const readback = await runReadbackProbe(options.device);
  const saxpy = await runSaxpyProbe(options.device, options.pipelines, options.report);
  const reduction = await runReductionProbe(options.device, options.pipelines, options.report);
  const oneMiB = readback.curve.find(({ bytes }) => bytes === 1024 * 1024);
  if (oneMiB === undefined) throw new Error('1 MiB readback gate sample is missing');
  const dispatchGreen = dispatch.overheadUs.ci95.high <= 50;
  const readbackGreen = oneMiB.statistics.ci95.high <= 1;
  const measuredRuns = RUNS_PER_CURVE_POINT;
  const dispatched =
    measuredRuns * 256 +
    measuredRuns * 16 * 2 +
    measuredRuns * CURVE_BYTES.length +
    measuredRuns * reduction.reduce((sum, sample) => sum + sample.passCount, 0);
  assertAccelerationEngaged({
    activeLane: 'gpu',
    adapter: options.report.adapter.vendor,
    dispatchCount: dispatched,
    requestedLane: 'gpu',
    resultConsumed:
      readback.consumedMappings > 0 &&
      saxpy.every(({ expectedOutput, output }) => output === expectedOutput) &&
      reduction.every(({ output }) => output === 1),
  });
  return {
    decision: dispatchGreen && readbackGreen ? 'go' : 'no-go',
    dispatch,
    gates: {
      dispatch: {
        actualUpper95Us: dispatch.overheadUs.ci95.high,
        green: dispatchGreen,
        requiredUpper95Us: 50,
      },
      readback1MiB: {
        actualUpper95Ms: oneMiB.statistics.ci95.high,
        green: readbackGreen,
        requiredUpper95Ms: 1,
      },
    },
    methodology: {
      repeats: REPEATS,
      timestampQuery: timestampEnabled(options.report),
      warmups: WARMUPS,
    },
    readback,
    reduction,
    saxpy,
  };
};
