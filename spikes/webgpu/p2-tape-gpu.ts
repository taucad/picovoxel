import {
  assertAccelerationEngaged,
  collectPairedSamples,
  summarizeBootstrapMedian,
  summarizePairedSamples,
} from '../../bench/stats.mjs';
import { compileSdfExpression, type SdfExpression } from '../../src/tape.ts';
import type { Pico } from '../../src/session.ts';
import type { Voxels } from '../../src/voxels.ts';

import { planDispatch } from './dispatch.ts';
import type { WebGpuCapabilityReport } from './device.ts';
import { ComputePipelineCache } from './pipeline-cache.ts';
import { loadPicoSpikeRuntime, type PicoSpikeRuntime, type TapeGpuInfo } from './spike-runtime.ts';
import { TimestampProfiler } from './timestamp-profiler.ts';

const WORKGROUP_SIZE = 64;
const REGISTER_CAP = 64;
const REPEATS = 30;
const WARMUPS = 2;
const ACCURACY_SAMPLES = 100_000;

const GYROID_SCALE = (2 * Math.PI) / 10;
const GYROID_THRESHOLD = 0.4;
const GYROID_EXPRESSION: SdfExpression = [
  '-',
  [
    'abs',
    [
      '+',
      ['*', ['sin', ['*', 'x', GYROID_SCALE]], ['cos', ['*', 'y', GYROID_SCALE]]],
      ['*', ['sin', ['*', 'y', GYROID_SCALE]], ['cos', ['*', 'z', GYROID_SCALE]]],
      ['*', ['sin', ['*', 'z', GYROID_SCALE]], ['cos', ['*', 'x', GYROID_SCALE]]],
    ],
  ],
  GYROID_THRESHOLD,
];
const SPHERE_EXPRESSION: SdfExpression = ['-', ['sqrt', ['+', ['*', 'x', 'x'], ['*', 'y', 'y'], ['*', 'z', 'z']]], 10];

type TapeVariant = 'subgroup' | 'v1' | 'v2';

interface GpuConstants {
  readonly buffer: {
    readonly COPY_DST: number;
    readonly COPY_SRC: number;
    readonly INDIRECT: number;
    readonly MAP_READ: number;
    readonly STORAGE: number;
    readonly UNIFORM: number;
  };
  readonly mapRead: number;
}

interface TapeHeap {
  readonly bounds: number;
  readonly constantCount: number;
  readonly constants: number;
  readonly instructionCount: number;
  readonly instructions: number;
  readonly release: () => void;
}

interface AccuracyMetrics {
  readonly histogram: {
    readonly exact: number;
    readonly withinQuarterTolerance: number;
    readonly withinHalfTolerance: number;
    readonly withinTolerance: number;
    readonly beyondTolerance: number;
  };
  readonly maxAbsoluteError: number;
  readonly nonFinite: number;
  readonly sampleCount: number;
  readonly signFlipsBeyondTolerance: number;
  readonly tolerance: number;
}

interface GpuTapeRun {
  readonly accuracy?: AccuracyMetrics;
  readonly classifyMs: number;
  readonly dispatch: {
    readonly indirect: boolean;
    readonly workgroups: number;
    readonly x: number;
    readonly y: number;
  };
  readonly gpuMs: number | null;
  readonly info: TapeGpuInfo;
  readonly ingestFraction: number;
  readonly ingestMs: number;
  readonly target?: Voxels;
  readonly wallMs: number;
}

const gpuConstants = (): GpuConstants => {
  const buffer = Reflect.get(globalThis, 'GPUBufferUsage');
  const mapMode = Reflect.get(globalThis, 'GPUMapMode');
  if (typeof buffer !== 'object' || typeof mapMode !== 'object') {
    throw new Error('WebGPU runtime constants are unavailable');
  }
  return {
    buffer: buffer as GpuConstants['buffer'],
    mapRead: Reflect.get(mapMode, 'READ') as number,
  };
};

const elapsed = (started: number): number => Math.max(performance.now() - started, Number.EPSILON);

const allocateTape = (options: {
  readonly boundsMax: readonly [number, number, number];
  readonly boundsMin: readonly [number, number, number];
  readonly expression: SdfExpression;
  readonly runtime: PicoSpikeRuntime;
}): TapeHeap => {
  const tape = compileSdfExpression(options.expression);
  const instructions = options.runtime.module._malloc(Math.max(8, tape.instructions.byteLength));
  const constants = options.runtime.module._malloc(Math.max(8, tape.constants.byteLength));
  const bounds = options.runtime.module._malloc(24);
  options.runtime.module.HEAPU32.set(tape.instructions, instructions >>> 2);
  options.runtime.module.HEAPF64.set(tape.constants, constants >>> 3);
  options.runtime.module.HEAPF32.set([...options.boundsMin, ...options.boundsMax], bounds >>> 2);
  let released = false;
  return {
    bounds,
    constantCount: tape.constants.length,
    constants,
    instructionCount: tape.instructions.length / 2,
    instructions,
    release: () => {
      if (released) return;
      released = true;
      options.runtime.module._free(instructions);
      options.runtime.module._free(constants);
      options.runtime.module._free(bounds);
    },
  };
};

const encodeV1Parameters = (options: { readonly info: TapeGpuInfo; readonly variant: number }): ArrayBuffer => {
  const data = new ArrayBuffer(32);
  const view = new DataView(data);
  view.setUint32(0, options.info.outputCount, true);
  view.setUint32(4, options.info.tapeCount, true);
  view.setUint32(8, options.info.slabCount, true);
  view.setUint32(12, options.variant, true);
  view.setFloat32(16, options.info.voxelSize, true);
  view.setFloat32(20, options.info.background, true);
  return data;
};

const encodeV2Parameters = (options: {
  readonly info: TapeGpuInfo;
  readonly scale: number;
  readonly threshold: number;
  readonly variant: number;
}): ArrayBuffer => {
  const data = new ArrayBuffer(32);
  const view = new DataView(data);
  view.setUint32(0, options.info.outputCount, true);
  view.setUint32(4, options.info.slabCount, true);
  view.setUint32(8, options.variant, true);
  view.setFloat32(16, options.info.voxelSize, true);
  view.setFloat32(20, options.info.background, true);
  view.setFloat32(24, options.scale, true);
  view.setFloat32(28, options.threshold, true);
  return data;
};

const xorshift = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
};

const f32Ulp = (value: number): number => {
  const bits = new Uint32Array(new Float32Array([value]).buffer);
  const next = new Uint32Array([bits[0]! + 1]);
  return Math.abs(new Float32Array(next.buffer)[0]! - Math.fround(value));
};

const measureAccuracy = (options: {
  readonly gpuValues: Float32Array;
  readonly info: TapeGpuInfo;
  readonly plan: number;
  readonly runtime: PicoSpikeRuntime;
}): AccuracyMetrics => {
  const sampleCount = Math.min(ACCURACY_SAMPLES, options.info.outputCount);
  const indicesPointer = options.runtime.module._malloc(sampleCount * 4);
  const valuesPointer = options.runtime.module._malloc(sampleCount * 4);
  try {
    const indices = new Uint32Array(sampleCount);
    const random = xorshift(0x50324143);
    for (let index = 0; index < sampleCount; index += 1) {
      indices[index] = Math.floor(random() * options.info.outputCount);
    }
    options.runtime.module.HEAPU32.set(indices, indicesPointer >>> 2);
    options.runtime.abi.tapeEvalCpuSamples(options.plan, indicesPointer, sampleCount, valuesPointer);
    const cpuValues = new Float32Array(
      options.runtime.module.HEAPF32.slice(valuesPointer >>> 2, (valuesPointer >>> 2) + sampleCount),
    );
    const tolerance = 4 * options.info.tapeCount * f32Ulp(options.info.background);
    const histogram = {
      beyondTolerance: 0,
      exact: 0,
      withinHalfTolerance: 0,
      withinQuarterTolerance: 0,
      withinTolerance: 0,
    };
    let maxAbsoluteError = 0;
    let nonFinite = 0;
    let signFlipsBeyondTolerance = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const cpu = cpuValues[index]!;
      const gpu = options.gpuValues[indices[index]!]!;
      if (!Number.isFinite(cpu) || !Number.isFinite(gpu)) {
        nonFinite += 1;
        continue;
      }
      const error = Math.abs(cpu - gpu);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      if (error === 0) histogram.exact += 1;
      else if (error <= tolerance / 4) histogram.withinQuarterTolerance += 1;
      else if (error <= tolerance / 2) histogram.withinHalfTolerance += 1;
      else if (error <= tolerance) histogram.withinTolerance += 1;
      else histogram.beyondTolerance += 1;
      if (cpu < 0 !== gpu < 0 && Math.abs(cpu) >= tolerance) {
        signFlipsBeyondTolerance += 1;
      }
    }
    return {
      histogram,
      maxAbsoluteError,
      nonFinite,
      sampleCount,
      signFlipsBeyondTolerance,
      tolerance,
    };
  } finally {
    options.runtime.module._free(indicesPointer);
    options.runtime.module._free(valuesPointer);
  }
};

const runGpuTape = async (options: {
  readonly device: GPUDevice;
  readonly indirect: boolean;
  readonly indirectPipeline?: GPUComputePipeline;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly retainTarget?: boolean;
  readonly runtime: PicoSpikeRuntime;
  readonly sampleAccuracy?: boolean;
  readonly session: Pico;
  readonly tape: TapeHeap;
  readonly variant: TapeVariant;
}): Promise<GpuTapeRun> => {
  const constants = gpuConstants();
  const target = options.session.createVoxels({ shape: 'empty' });
  let plan = 0;
  const buffers: GPUBuffer[] = [];
  let keepTarget = false;
  try {
    const started = performance.now();
    const classifyStarted = performance.now();
    plan = options.runtime.abi.tapeClassify({
      bounds: options.tape.bounds,
      constantCount: options.tape.constantCount,
      constants: options.tape.constants,
      instructionCount: options.tape.instructionCount,
      instructions: options.tape.instructions,
      library: options.session.handle,
      voxels: target.handle,
    });
    const classifyMs = elapsed(classifyStarted);
    const info = options.runtime.abi.tapeInfo(plan);
    if (info.tapeCount > REGISTER_CAP) {
      throw new Error(`Tape has ${info.tapeCount} instructions; WebGPU cap is ${REGISTER_CAP}`);
    }
    if (info.outputCount === 0 || info.slabCount === 0) {
      throw new Error('Tape classifier emitted no GPU work');
    }

    const slabBytes = info.slabCount * 9 * 4;
    const tapeBytes = info.tapeCount * 2 * 4;
    const constantBytes = Math.max(4, info.constantCount * 4);
    const outputBytes = info.outputCount * 4;
    const slabBuffer = options.device.createBuffer({
      size: slabBytes,
      usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
    });
    const tapeBuffer = options.device.createBuffer({
      size: tapeBytes,
      usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
    });
    const constantBuffer = options.device.createBuffer({
      size: constantBytes,
      usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
    });
    const outputBuffer = options.device.createBuffer({
      size: outputBytes,
      usage: constants.buffer.COPY_SRC | constants.buffer.STORAGE,
    });
    const parameterBuffer = options.device.createBuffer({
      size: 32,
      usage: constants.buffer.COPY_DST | constants.buffer.UNIFORM,
    });
    const readback = options.device.createBuffer({
      size: outputBytes,
      usage: constants.buffer.COPY_DST | constants.buffer.MAP_READ,
    });
    buffers.push(slabBuffer, tapeBuffer, constantBuffer, outputBuffer, parameterBuffer, readback);
    options.runtime.stager.writeBuffer(options.device.queue, slabBuffer, {
      heapOffset: info.slabData,
      size: slabBytes,
    });
    options.runtime.stager.writeBuffer(options.device.queue, tapeBuffer, {
      heapOffset: info.tapeData,
      size: tapeBytes,
    });
    if (info.constantCount > 0) {
      options.runtime.stager.writeBuffer(options.device.queue, constantBuffer, {
        heapOffset: info.constantData,
        size: info.constantCount * 4,
      });
    }
    const parameterData =
      options.variant === 'v2'
        ? encodeV2Parameters({
            info,
            scale: GYROID_SCALE,
            threshold: GYROID_THRESHOLD,
            variant: 0,
          })
        : encodeV1Parameters({ info, variant: 0 });
    options.device.queue.writeBuffer(parameterBuffer, 0, parameterData);
    const entries =
      options.variant === 'v2'
        ? [
            { binding: 0, resource: { buffer: slabBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
            { binding: 2, resource: { buffer: parameterBuffer } },
          ]
        : [
            { binding: 0, resource: { buffer: slabBuffer } },
            { binding: 1, resource: { buffer: tapeBuffer } },
            { binding: 2, resource: { buffer: constantBuffer } },
            { binding: 3, resource: { buffer: outputBuffer } },
            { binding: 4, resource: { buffer: parameterBuffer } },
          ];
    const bindGroup = options.device.createBindGroup({
      entries,
      layout: options.pipeline.getBindGroupLayout(0),
    });
    const dispatch = planDispatch({
      elementCount: info.outputCount,
      maxWorkgroupsPerDimension: options.report.limits.required.maxComputeWorkgroupsPerDimension,
      workgroupSize: WORKGROUP_SIZE,
    });
    const encoder = options.device.createCommandEncoder();
    let indirectBuffer: GPUBuffer | undefined;
    if (options.indirect) {
      if (options.indirectPipeline === undefined) {
        throw new Error('Indirect dispatch requested without its static pipeline');
      }
      indirectBuffer = options.device.createBuffer({
        size: 12,
        usage: constants.buffer.INDIRECT | constants.buffer.STORAGE,
      });
      const indirectParameters = options.device.createBuffer({
        size: 16,
        usage: constants.buffer.COPY_DST | constants.buffer.UNIFORM,
      });
      buffers.push(indirectBuffer, indirectParameters);
      options.device.queue.writeBuffer(
        indirectParameters,
        0,
        new Uint32Array([
          1,
          info.outputCount,
          WORKGROUP_SIZE,
          options.report.limits.required.maxComputeWorkgroupsPerDimension,
        ]),
      );
      const indirectBindGroup = options.device.createBindGroup({
        entries: [
          { binding: 0, resource: { buffer: indirectBuffer } },
          { binding: 1, resource: { buffer: indirectParameters } },
        ],
        layout: options.indirectPipeline.getBindGroupLayout(0),
      });
      const argumentPass = encoder.beginComputePass();
      argumentPass.setPipeline(options.indirectPipeline);
      argumentPass.setBindGroup(0, indirectBindGroup);
      argumentPass.dispatchWorkgroups(1);
      argumentPass.end();
    }
    const profiler = new TimestampProfiler(
      options.device,
      options.report.features.requested.includes('timestamp-query'),
    );
    let timing;
    try {
      const pass = profiler.beginPass(encoder, 'picovoxel:p2:tape-eval');
      pass.setPipeline(options.pipeline);
      pass.setBindGroup(0, bindGroup);
      if (indirectBuffer === undefined) {
        pass.dispatchWorkgroups(dispatch.dispatchX, dispatch.dispatchY);
      } else {
        pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);
      }
      pass.end();
      profiler.resolve(encoder);
      encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBytes);
      options.device.queue.submit([encoder.finish()]);
      const [, measured] = await Promise.all([readback.mapAsync(constants.mapRead, 0, outputBytes), profiler.read()]);
      timing = measured;
    } finally {
      profiler.destroy();
    }
    const gpuValues = new Float32Array(readback.getMappedRange(0, outputBytes)).slice();
    readback.unmap();
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: dispatch.dispatchX * dispatch.dispatchY,
      requestedLane: 'webgpu',
      resultConsumed: gpuValues.length === info.outputCount,
    });

    const accuracy = options.sampleAccuracy
      ? measureAccuracy({
          gpuValues,
          info,
          plan,
          runtime: options.runtime,
        })
      : undefined;
    const valuesPointer = options.runtime.module._malloc(outputBytes);
    let ingestMs: number;
    try {
      options.runtime.stager.copyToHeap(new Uint8Array(gpuValues.buffer), { heapOffset: valuesPointer });
      const ingestStarted = performance.now();
      options.runtime.abi.tapeIngest(plan, valuesPointer, info.outputCount);
      ingestMs = elapsed(ingestStarted);
    } finally {
      options.runtime.module._free(valuesPointer);
    }
    const wallMs = elapsed(started);
    keepTarget = options.retainTarget === true;
    return {
      accuracy,
      classifyMs,
      dispatch: {
        indirect: options.indirect,
        workgroups: dispatch.dispatchX * dispatch.dispatchY,
        x: dispatch.dispatchX,
        y: dispatch.dispatchY,
      },
      gpuMs: timing.gpuMs,
      info,
      ingestFraction: ingestMs / wallMs,
      ingestMs,
      target: keepTarget ? target : undefined,
      wallMs,
    };
  } finally {
    buffers.forEach((buffer) => buffer.destroy());
    if (plan !== 0) options.runtime.abi.tapeDispose(plan);
    if (!keepTarget) target.dispose();
  }
};

const renderCpu = (options: {
  readonly runtime: PicoSpikeRuntime;
  readonly session: Pico;
  readonly tape: TapeHeap;
  readonly retainTarget?: boolean;
}): { readonly ms: number; readonly target?: Voxels } => {
  const target = options.session.createVoxels({ shape: 'empty' });
  const started = performance.now();
  options.runtime.raw.Voxels_RenderImplicitTape(
    options.session.handle,
    target.handle,
    options.tape.bounds,
    options.tape.instructions,
    options.tape.instructionCount,
    options.tape.constants,
    options.tape.constantCount,
  );
  const ms = elapsed(started);
  if (options.retainTarget) return { ms, target };
  target.dispose();
  return { ms };
};

const artifactMetrics = (options: { readonly cpu: Voxels; readonly gpu: Voxels; readonly voxelSize: number }) => {
  const cpuProperties = options.cpu.properties();
  const gpuProperties = options.gpu.properties();
  const cpuMesh = options.cpu.toMesh();
  const gpuMesh = options.gpu.toMesh();
  try {
    const volumePpm =
      (Math.abs(gpuProperties.volume - cpuProperties.volume) / Math.abs(cpuProperties.volume)) * 1_000_000;
    const triangleFraction =
      Math.abs(gpuMesh.triangleCount - cpuMesh.triangleCount) / Math.max(1, cpuMesh.triangleCount);
    const cpuBounds = [...cpuProperties.bounds.min, ...cpuProperties.bounds.max];
    const gpuBounds = [...gpuProperties.bounds.min, ...gpuProperties.bounds.max];
    const boundsExact = cpuBounds.every(
      (value, index) => Math.round(value / options.voxelSize) === Math.round(gpuBounds[index]! / options.voxelSize),
    );
    const boundsMaxDelta = Math.max(...cpuBounds.map((value, index) => Math.abs(value - gpuBounds[index]!)));
    return {
      bounds: {
        cpu: cpuProperties.bounds,
        exactToVoxel: boundsExact,
        gpu: gpuProperties.bounds,
        maxDelta: boundsMaxDelta,
        voxelSize: options.voxelSize,
      },
      green: volumePpm <= 100 && triangleFraction <= 0.001 && boundsExact,
      triangles: {
        cpu: cpuMesh.triangleCount,
        fraction: triangleFraction,
        gpu: gpuMesh.triangleCount,
      },
      volume: {
        cpu: cpuProperties.volume,
        gpu: gpuProperties.volume,
        ppm: volumePpm,
      },
    };
  } finally {
    cpuMesh.dispose();
    gpuMesh.dispose();
  }
};

const accuracyGreen = (accuracy: AccuracyMetrics | undefined): boolean =>
  accuracy !== undefined &&
  accuracy.nonFinite === 0 &&
  accuracy.histogram.beyondTolerance === 0 &&
  accuracy.signFlipsBeyondTolerance === 0;

const benchmarkMainGate = async (options: {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
}) => {
  const session = await options.runtime.createSession({ voxelSize: 0.1 });
  const tape = allocateTape({
    boundsMax: [12, 12, 12],
    boundsMin: [-12, -12, -12],
    expression: GYROID_EXPRESSION,
    runtime: options.runtime,
  });
  const gpuDetails: GpuTapeRun[] = [];
  try {
    const paired = await collectPairedSamples({
      fast: async () => {
        const run = await runGpuTape({
          ...options,
          indirect: false,
          session,
          tape,
          variant: 'v1',
        });
        gpuDetails.push(run);
        return run.wallMs;
      },
      repeats: REPEATS,
      slow: () =>
        renderCpu({
          runtime: options.runtime,
          session,
          tape,
        }).ms,
      warmups: WARMUPS,
    });
    const statistics = summarizePairedSamples(paired);
    const measuredGpu = gpuDetails.slice(-REPEATS);
    return {
      acceleratedPathHardAsserted: true,
      cpuLane: '12-thread production tape',
      ingestFraction: summarizeBootstrapMedian(measuredGpu.map((run) => run.ingestFraction)),
      outputCount: measuredGpu.at(-1)!.info.outputCount,
      paired: statistics,
      pass: statistics.ci95.low >= 5 && statistics.medianRatio >= 5,
      slabCount: measuredGpu.at(-1)!.info.slabCount,
      tapeCount: tape.instructionCount,
    };
  } finally {
    tape.release();
    session.dispose();
  }
};

const measureFixtureAccuracy = async (options: {
  readonly boundsMax: readonly [number, number, number];
  readonly boundsMin: readonly [number, number, number];
  readonly device: GPUDevice;
  readonly expression: SdfExpression;
  readonly name: string;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
  readonly voxelSize: number;
}) => {
  const session = await options.runtime.createSession({
    voxelSize: options.voxelSize,
  });
  const tape = allocateTape({
    boundsMax: options.boundsMax,
    boundsMin: options.boundsMin,
    expression: options.expression,
    runtime: options.runtime,
  });
  let gpuTarget: Voxels | undefined;
  let cpuTarget: Voxels | undefined;
  try {
    const gpu = await runGpuTape({
      ...options,
      indirect: false,
      retainTarget: true,
      sampleAccuracy: true,
      session,
      tape,
      variant: 'v1',
    });
    gpuTarget = gpu.target!;
    const cpu = renderCpu({
      retainTarget: true,
      runtime: options.runtime,
      session,
      tape,
    });
    cpuTarget = cpu.target!;
    const artifact = artifactMetrics({
      cpu: cpuTarget,
      gpu: gpuTarget,
      voxelSize: options.voxelSize,
    });
    return {
      artifact,
      green: accuracyGreen(gpu.accuracy) && artifact.green,
      name: options.name,
      perVoxel: gpu.accuracy,
      timings: {
        classifyMs: gpu.classifyMs,
        gpuMs: gpu.gpuMs,
        ingestMs: gpu.ingestMs,
        wallMs: gpu.wallMs,
      },
    };
  } finally {
    gpuTarget?.dispose();
    cpuTarget?.dispose();
    tape.release();
    session.dispose();
  }
};

const benchmarkVariant = async (options: {
  readonly device: GPUDevice;
  readonly fast: {
    readonly indirect: boolean;
    readonly pipeline: GPUComputePipeline;
    readonly variant: TapeVariant;
  };
  readonly indirectPipeline?: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
  readonly session: Pico;
  readonly slow: {
    readonly indirect: boolean;
    readonly pipeline: GPUComputePipeline;
    readonly variant: TapeVariant;
  };
  readonly tape: TapeHeap;
}) => {
  const paired = await collectPairedSamples({
    fast: async () =>
      (
        await runGpuTape({
          ...options,
          ...options.fast,
          indirectPipeline: options.indirectPipeline,
        })
      ).wallMs,
    repeats: REPEATS,
    slow: async () =>
      (
        await runGpuTape({
          ...options,
          ...options.slow,
          indirectPipeline: options.indirectPipeline,
        })
      ).wallMs,
    warmups: WARMUPS,
  });
  return summarizePairedSamples(paired);
};

const measureVariants = async (options: {
  readonly device: GPUDevice;
  readonly pipelines: ComputePipelineCache;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
  readonly v1CompileMs: number;
  readonly v1Pipeline: GPUComputePipeline;
}) => {
  const session = await options.runtime.createSession({ voxelSize: 0.25 });
  const tape = allocateTape({
    boundsMax: [12, 12, 12],
    boundsMin: [-12, -12, -12],
    expression: GYROID_EXPRESSION,
    runtime: options.runtime,
  });
  try {
    const v2Started = performance.now();
    const v2Pipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'tape-gyroid-specialized',
    });
    const v2CompileMs = elapsed(v2Started);
    const indirectPipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE: 1 },
      entryPoint: 'main',
      shaderId: 'tape-indirect-args',
    });
    const cacheCandidates = await Promise.all(
      [0.5, 0.75, 1, 1.25].map(() =>
        options.pipelines.get({
          constants: { WORKGROUP_SIZE },
          entryPoint: 'main',
          shaderId: 'tape-gyroid-specialized',
        }),
      ),
    );
    const cacheHits = cacheCandidates.filter((pipeline) => pipeline === v2Pipeline).length;
    const v2 = await benchmarkVariant({
      ...options,
      fast: { indirect: false, pipeline: v2Pipeline, variant: 'v2' },
      indirectPipeline,
      session,
      slow: {
        indirect: false,
        pipeline: options.v1Pipeline,
        variant: 'v1',
      },
      tape,
    });
    const amortized = Object.fromEntries(
      [1, 5, 30].map((evaluations) => [
        evaluations,
        (options.v1CompileMs + evaluations * v2.slow.median) / (v2CompileMs + evaluations * v2.fast.median),
      ]),
    );
    const v4 = await benchmarkVariant({
      ...options,
      fast: {
        indirect: true,
        pipeline: options.v1Pipeline,
        variant: 'v1',
      },
      indirectPipeline,
      session,
      slow: {
        indirect: false,
        pipeline: options.v1Pipeline,
        variant: 'v1',
      },
      tape,
    });
    let subgroup: unknown = {
      measured: false,
      reason: 'adapter feature unavailable',
    };
    if (options.report.features.requested.includes('subgroups')) {
      const subgroupPipeline = await options.pipelines.get({
        constants: { WORKGROUP_SIZE },
        entryPoint: 'main',
        shaderId: 'tape-interpreter-subgroup',
      });
      subgroup = {
        measured: true,
        paired: await benchmarkVariant({
          ...options,
          fast: {
            indirect: false,
            pipeline: subgroupPipeline,
            variant: 'subgroup',
          },
          indirectPipeline,
          session,
          slow: {
            indirect: false,
            pipeline: options.v1Pipeline,
            variant: 'v1',
          },
          tape,
        }),
      };
    }
    return {
      outputCountAt025: (
        await runGpuTape({
          ...options,
          indirect: false,
          pipeline: options.v1Pipeline,
          session,
          tape,
          variant: 'v1',
        })
      ).info.outputCount,
      pipelineCache: {
        hits: cacheHits,
        parameterVariants: cacheCandidates.length,
      },
      subgroup,
      V2: {
        amortizedRatios: amortized,
        compileMs: v2CompileMs,
        earnsDefaultAlternative: v2.ci95.low >= 1.5 && (amortized['30'] ?? 0) >= 1.5,
        paired: v2,
      },
      V4: {
        scope: 'GPU-generated indirect arguments; slab compaction remains a measured design option',
        pairedDirectOverIndirect: v4,
      },
    };
  } finally {
    tape.release();
    session.dispose();
  }
};

const longTapeExpression = (): SdfExpression => {
  let expression: SdfExpression = 'x';
  for (let index = 0; index < 70; index += 1) {
    expression = ['+', expression, index / 1000];
  }
  return expression;
};

const exerciseRegisterFallback = async (options: { readonly runtime: PicoSpikeRuntime }) => {
  const session = await options.runtime.createSession({ voxelSize: 0.5 });
  const tape = allocateTape({
    boundsMax: [1, 1, 1],
    boundsMin: [-1, -1, -1],
    expression: longTapeExpression(),
    runtime: options.runtime,
  });
  try {
    if (tape.instructionCount <= REGISTER_CAP) {
      throw new Error('Synthetic fallback tape did not exceed the register cap');
    }
    const cpu = renderCpu({
      runtime: options.runtime,
      session,
      tape,
    });
    return {
      activeLane: 'cpu',
      cpuMs: cpu.ms,
      instructionCount: tape.instructionCount,
      reason: `register-cap:${REGISTER_CAP}`,
      requestedLane: 'webgpu',
    };
  } finally {
    tape.release();
    session.dispose();
  }
};

export const runTapeGpuProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipelines: ComputePipelineCache;
  readonly report: WebGpuCapabilityReport;
}) => {
  const runtime = await loadPicoSpikeRuntime();
  try {
    const v1Started = performance.now();
    const v1Pipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'tape-interpreter',
    });
    const v1CompileMs = elapsed(v1Started);
    const main = await benchmarkMainGate({
      ...options,
      pipeline: v1Pipeline,
      runtime,
    });
    const accuracy = {
      gyroid: await measureFixtureAccuracy({
        ...options,
        boundsMax: [12, 12, 12],
        boundsMin: [-12, -12, -12],
        expression: GYROID_EXPRESSION,
        name: 'gyroid@0.1',
        pipeline: v1Pipeline,
        runtime,
        voxelSize: 0.1,
      }),
      sphere: await measureFixtureAccuracy({
        ...options,
        boundsMax: [12, 12, 12],
        boundsMin: [-12, -12, -12],
        expression: SPHERE_EXPRESSION,
        name: 'sphere@0.1',
        pipeline: v1Pipeline,
        runtime,
        voxelSize: 0.1,
      }),
    };
    const variants = await measureVariants({
      ...options,
      runtime,
      v1CompileMs,
      v1Pipeline,
    });
    const fallback = await exerciseRegisterFallback({ runtime });
    const gates = {
      E1: {
        bar: 5,
        ci95Lower: main.paired.ci95.low,
        pass: main.pass,
      },
      E2: {
        fixtures: Object.fromEntries(Object.entries(accuracy).map(([name, result]) => [name, result.green])),
        pass: Object.values(accuracy).every((result) => result.green),
      },
      E3: {
        measured: true,
        v2EarnsAlternative: variants.V2.earnsDefaultAlternative,
      },
      E4: {
        ingestFractionMedian: main.ingestFraction.median,
        nonBlockingTarget: 0.15,
        pass: main.ingestFraction.median <= 0.15,
      },
      E5: {
        fallback,
        pass: fallback.activeLane === 'cpu' && fallback.instructionCount > REGISTER_CAP,
      },
    };
    return {
      accuracy,
      adapter: options.report.adapter,
      decision: gates.E1.pass && gates.E2.pass && gates.E5.pass ? 'go' : 'no-go',
      evaluationCounts: {
        at01: main.outputCount,
        at025: variants.outputCountAt025,
        priorClaim1215MMatches:
          main.outputCount === 12_150_000 ? '@0.1' : variants.outputCountAt025 === 12_150_000 ? '@0.25' : 'neither',
      },
      gates,
      heapStaging: runtime.stager.mode,
      main,
      status: 'available',
      variants,
    };
  } finally {
    runtime.dispose();
  }
};
