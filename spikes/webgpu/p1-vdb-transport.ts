import { assertAccelerationEngaged, summarizeBootstrapMedian } from '../../bench/stats.mjs';

import { planDispatch } from './dispatch.ts';
import type { WebGpuCapabilityReport } from './device.ts';
import { ComputePipelineCache } from './pipeline-cache.ts';
import { loadPicoSpikeRuntime, type NanoSnapshotInfo, type PicoSpikeRuntime } from './spike-runtime.ts';
import { TimestampProfiler } from './timestamp-profiler.ts';

const WORKGROUP_SIZE = 64;
const REPEATS = 5;
const WARMUPS = 1;
const CHUNK_BYTES = 64 * 1024 * 1024;
const BINDING_ALIGNMENT = 256;
const MIB = 1024 * 1024;
const OFFSET_CPU_BASELINE_MS = 227.068;

interface GpuConstants {
  readonly buffer: {
    readonly COPY_DST: number;
    readonly COPY_SRC: number;
    readonly MAP_READ: number;
    readonly STORAGE: number;
    readonly UNIFORM: number;
  };
  readonly mapRead: number;
}

interface LeafChunk {
  readonly bindingOffset: number;
  readonly bindingSize: number;
  readonly dispatchX: number;
  readonly dispatchY: number;
  readonly elementCount: number;
  readonly leafOffsetBytes: number;
}

interface LeafTransformRun {
  readonly bytes: Uint8Array;
  readonly chunks: readonly LeafChunk[];
  readonly dispatchCount: number;
  readonly gpuMs: number | null;
  readonly gpuTimingSource: string;
  readonly uploadEnqueueMs: number;
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

const copyHeap = (runtime: PicoSpikeRuntime, pointer: number, size: number): Uint8Array =>
  new Uint8Array(runtime.module.HEAPU8.buffer, pointer, size).slice();

const elapsed = (started: number): number => Math.max(performance.now() - started, Number.EPSILON);

const withTimeout = async <Value>(promise: Promise<Value>, label: string): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not complete within 15 seconds`)), 15_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const collect = async <Value>(
  body: () => Promise<Value> | Value,
): Promise<{ readonly samplesMs: number[]; readonly value: Value }> => {
  let value!: Value;
  for (let index = 0; index < WARMUPS; index += 1) {
    value = await body();
  }
  const samplesMs: number[] = [];
  for (let index = 0; index < REPEATS; index += 1) {
    const started = performance.now();
    value = await body();
    samplesMs.push(elapsed(started));
  }
  return { samplesMs, value };
};

const alignDown = (value: number, alignment: number): number => Math.floor(value / alignment) * alignment;

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

const planLeafChunks = (options: {
  readonly info: NanoSnapshotInfo;
  readonly maxBindingBytes: number;
  readonly maxWorkgroups: number;
}): LeafChunk[] => {
  const { info } = options;
  const bindingCap = Math.min(CHUNK_BYTES, options.maxBindingBytes);
  const leavesPerChunk = Math.floor((bindingCap - BINDING_ALIGNMENT) / info.leafStride);
  if (leavesPerChunk < 1) {
    throw new Error(`NanoVDB leaf stride ${info.leafStride} exceeds binding cap ${bindingCap}`);
  }

  const chunks: LeafChunk[] = [];
  for (let leafStart = 0; leafStart < info.leafCount; leafStart += leavesPerChunk) {
    const leafCount = Math.min(leavesPerChunk, info.leafCount - leafStart);
    const firstLeaf = info.leafOffset + leafStart * info.leafStride;
    const lastLeaf = firstLeaf + leafCount * info.leafStride;
    const bindingOffset = alignDown(firstLeaf, BINDING_ALIGNMENT);
    const bindingSize = alignUp(lastLeaf - bindingOffset, 4);
    if (bindingSize > bindingCap) {
      throw new Error(`NanoVDB chunk ${bindingSize} exceeds binding cap ${bindingCap}`);
    }
    const elementCount = leafCount * 512;
    const dispatch = planDispatch({
      elementCount,
      maxWorkgroupsPerDimension: options.maxWorkgroups,
      workgroupSize: WORKGROUP_SIZE,
    });
    chunks.push({
      bindingOffset,
      bindingSize,
      dispatchX: dispatch.dispatchX,
      dispatchY: dispatch.dispatchY,
      elementCount,
      leafOffsetBytes: firstLeaf - bindingOffset,
    });
  }
  return chunks;
};

const encodeLeafParameters = (options: {
  readonly chunk: LeafChunk;
  readonly leafStride: number;
  readonly operand: number;
  readonly operation: number;
}): ArrayBuffer => {
  const data = new ArrayBuffer(32);
  const view = new DataView(data);
  view.setUint32(0, options.chunk.elementCount, true);
  view.setUint32(4, options.chunk.leafOffsetBytes, true);
  view.setUint32(8, options.leafStride, true);
  view.setUint32(12, options.operation, true);
  view.setFloat32(16, options.operand, true);
  return data;
};

const runLeafTransform = async (options: {
  readonly device: GPUDevice;
  readonly info: NanoSnapshotInfo;
  readonly operand: number;
  readonly operation: number;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
}): Promise<LeafTransformRun> => {
  const constants = gpuConstants();
  const chunks = planLeafChunks({
    info: options.info,
    maxBindingBytes: options.report.limits.required.maxStorageBufferBindingSize,
    maxWorkgroups: options.report.limits.required.maxComputeWorkgroupsPerDimension,
  });
  options.device.pushErrorScope('validation');
  const grid = options.device.createBuffer({
    label: 'picovoxel:p1:nanovdb-grid',
    size: options.info.byteSize,
    usage: constants.buffer.COPY_DST | constants.buffer.COPY_SRC | constants.buffer.STORAGE,
  });
  const readback = options.device.createBuffer({
    label: 'picovoxel:p1:nanovdb-readback',
    size: options.info.byteSize,
    usage: constants.buffer.COPY_DST | constants.buffer.MAP_READ,
  });
  const uniforms: GPUBuffer[] = [];
  const bindGroups: GPUBindGroup[] = [];
  const profiler = new TimestampProfiler(options.device, options.report.features.requested.includes('timestamp-query'));

  try {
    const uploadStarted = performance.now();
    options.runtime.stager.writeBuffer(options.device.queue, grid, {
      heapOffset: options.info.data,
      size: options.info.byteSize,
    });
    const uploadEnqueueMs = elapsed(uploadStarted);

    for (const chunk of chunks) {
      const uniform = options.device.createBuffer({
        size: 32,
        usage: constants.buffer.COPY_DST | constants.buffer.UNIFORM,
      });
      options.device.queue.writeBuffer(
        uniform,
        0,
        encodeLeafParameters({
          chunk,
          leafStride: options.info.leafStride,
          operand: options.operand,
          operation: options.operation,
        }),
      );
      uniforms.push(uniform);
      bindGroups.push(
        options.device.createBindGroup({
          entries: [
            {
              binding: 0,
              resource: {
                buffer: grid,
                offset: chunk.bindingOffset,
                size: chunk.bindingSize,
              },
            },
            { binding: 1, resource: { buffer: uniform } },
          ],
          layout: options.pipeline.getBindGroupLayout(0),
        }),
      );
    }
    const started = performance.now();
    const encoder = options.device.createCommandEncoder();
    const pass = profiler.beginPass(encoder, 'picovoxel:p1:leaf-transform');
    pass.setPipeline(options.pipeline);
    chunks.forEach((chunk, index) => {
      pass.setBindGroup(0, bindGroups[index]!);
      pass.dispatchWorkgroups(chunk.dispatchX, chunk.dispatchY);
    });
    pass.end();
    profiler.resolve(encoder);
    encoder.copyBufferToBuffer(grid, 0, readback, 0, options.info.byteSize);
    options.device.queue.submit([encoder.finish()]);
    const validationError = await options.device.popErrorScope();
    if (validationError !== null) {
      throw new Error(`P1 leaf transform validation: ${validationError.message}`);
    }
    const map = readback.mapAsync(constants.mapRead, 0, options.info.byteSize);
    const timed = profiler.read();
    const fenced = options.device.queue.onSubmittedWorkDone();
    const [, timing] = await withTimeout(Promise.all([map, timed, fenced]), 'P1 leaf transform');
    const bytes = new Uint8Array(readback.getMappedRange(0, options.info.byteSize)).slice();
    const wallMs = elapsed(started);
    readback.unmap();
    return {
      bytes,
      chunks,
      dispatchCount: chunks.length,
      gpuMs: timing.gpuMs,
      gpuTimingSource: timing.source,
      uploadEnqueueMs,
      wallMs,
    };
  } finally {
    profiler.destroy();
    uniforms.forEach((buffer) => buffer.destroy());
    grid.destroy();
    readback.destroy();
  }
};

const firstByteMismatch = (left: Uint8Array, right: Uint8Array): number | null => {
  if (left.byteLength !== right.byteLength) return -1;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return null;
};

const runParityKernel = async (options: {
  readonly device: GPUDevice;
  readonly name: string;
  readonly operand: number;
  readonly operation: number;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
}) => {
  const session = await options.runtime.createSession({ voxelSize: 0.25 });
  const voxels = session.createVoxels({ shape: 'sphere', radius: 10 });
  let snapshot: NanoSnapshotInfo | undefined;
  let roundTrip: NanoSnapshotInfo | undefined;
  try {
    snapshot = options.runtime.abi.nanoCreate(session.handle, voxels.handle);
    const pristine = copyHeap(options.runtime, snapshot.data, snapshot.byteSize);
    const cpuWritten = options.runtime.abi.nanoTransformActive(snapshot.handle, options.operation, options.operand);
    const expected = copyHeap(options.runtime, snapshot.data, snapshot.byteSize);
    options.runtime.stager.copyToHeap(pristine, {
      heapOffset: snapshot.data,
    });

    const gpu = await runLeafTransform({
      device: options.device,
      info: snapshot,
      operand: options.operand,
      operation: options.operation,
      pipeline: options.pipeline,
      report: options.report,
      runtime: options.runtime,
    });
    const gpuMismatch = firstByteMismatch(gpu.bytes, expected);
    if (gpuMismatch !== null) {
      throw new Error(`${options.name} GPU/CPU NanoVDB mismatch at byte ${gpuMismatch}`);
    }
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: gpu.dispatchCount,
      requestedLane: 'webgpu',
      resultConsumed: gpu.bytes.byteLength === snapshot.byteSize,
    });

    options.runtime.stager.copyToHeap(gpu.bytes, {
      heapOffset: snapshot.data,
    });
    const applied = options.runtime.abi.nanoApplyValues(snapshot.handle);
    roundTrip = options.runtime.abi.nanoCreate(session.handle, voxels.handle);
    const roundTripBytes = copyHeap(options.runtime, roundTrip.data, roundTrip.byteSize);
    const roundTripMismatch = firstByteMismatch(roundTripBytes, expected);
    if (roundTripMismatch !== null) {
      throw new Error(`${options.name} apply round-trip mismatch at byte ${roundTripMismatch}`);
    }
    return {
      activeCount: snapshot.activeCount,
      applied,
      byteExact: true,
      byteSize: snapshot.byteSize,
      chunks: gpu.chunks.length,
      cpuWritten,
      gpuTiming: {
        gpuMs: gpu.gpuMs,
        source: gpu.gpuTimingSource,
        wallMs: gpu.wallMs,
      },
      leafCount: snapshot.leafCount,
      roundTripByteExact: true,
    };
  } finally {
    if (roundTrip !== undefined) {
      options.runtime.abi.nanoDispose(roundTrip.handle);
    }
    if (snapshot !== undefined) {
      options.runtime.abi.nanoDispose(snapshot.handle);
    }
    voxels.dispose();
    session.dispose();
  }
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

const orderedFloatBits = (value: number): number => {
  const data = new DataView(new ArrayBuffer(4));
  data.setFloat32(0, value, true);
  const bits = data.getUint32(0, true);
  return (bits & 0x80000000) === 0 ? 0x80000000 + bits : 0x80000000 - (bits & 0x7fffffff);
};

const runTrilinearProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
}) => {
  const constants = gpuConstants();
  const sampleCount = 100_000;
  const session = await options.runtime.createSession({ voxelSize: 0.25 });
  const voxels = session.createVoxels({ shape: 'sphere', radius: 10 });
  const snapshot = options.runtime.abi.nanoCreate(session.handle, voxels.handle);
  const boundsPointer = options.runtime.module._malloc(24);
  const cpuCoordinatesPointer = options.runtime.module._malloc(sampleCount * 3 * 4);
  const cpuValuesPointer = options.runtime.module._malloc(sampleCount * 4);
  const buffers: GPUBuffer[] = [];
  try {
    if (snapshot.byteSize > options.report.limits.required.maxStorageBufferBindingSize) {
      throw new Error('K4 fixture unexpectedly exceeds one reader binding');
    }
    options.runtime.abi.nanoBounds(snapshot.handle, boundsPointer);
    const bounds = new Int32Array(options.runtime.module.HEAP32.slice(boundsPointer >>> 2, (boundsPointer >>> 2) + 6));
    const random = xorshift(0x4b345031);
    const cpuCoordinates = new Float32Array(sampleCount * 3);
    const gpuCoordinates = new Float32Array(sampleCount * 4);
    for (let index = 0; index < sampleCount; index += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const minimum = bounds[axis]! - 1;
        const maximum = bounds[axis + 3]! + 1;
        const value = Math.fround(minimum + random() * (maximum - minimum));
        cpuCoordinates[3 * index + axis] = value;
        gpuCoordinates[4 * index + axis] = value;
      }
    }
    options.runtime.module.HEAPF32.set(cpuCoordinates, cpuCoordinatesPointer >>> 2);
    options.runtime.abi.nanoSampleBox(snapshot.handle, cpuCoordinatesPointer, sampleCount, cpuValuesPointer);
    const cpuValues = new Float32Array(
      options.runtime.module.HEAPF32.slice(cpuValuesPointer >>> 2, (cpuValuesPointer >>> 2) + sampleCount),
    );

    const grid = options.device.createBuffer({
      size: snapshot.byteSize,
      usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
    });
    const points = options.device.createBuffer({
      size: gpuCoordinates.byteLength,
      usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
    });
    const output = options.device.createBuffer({
      size: cpuValues.byteLength,
      usage: constants.buffer.COPY_SRC | constants.buffer.STORAGE,
    });
    const parameters = options.device.createBuffer({
      size: 16,
      usage: constants.buffer.COPY_DST | constants.buffer.UNIFORM,
    });
    const readback = options.device.createBuffer({
      size: cpuValues.byteLength,
      usage: constants.buffer.COPY_DST | constants.buffer.MAP_READ,
    });
    buffers.push(grid, points, output, parameters, readback);
    options.runtime.stager.writeBuffer(options.device.queue, grid, {
      heapOffset: snapshot.data,
      size: snapshot.byteSize,
    });
    options.device.queue.writeBuffer(points, 0, gpuCoordinates);
    options.device.queue.writeBuffer(parameters, 0, new Uint32Array([sampleCount, snapshot.byteSize, 0, 0]));
    const bindGroup = options.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: grid } },
        { binding: 1, resource: { buffer: points } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: parameters } },
      ],
      layout: options.pipeline.getBindGroupLayout(0),
    });
    const dispatch = planDispatch({
      elementCount: sampleCount,
      maxWorkgroupsPerDimension: options.report.limits.required.maxComputeWorkgroupsPerDimension,
      workgroupSize: WORKGROUP_SIZE,
    });
    const encoder = options.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(options.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(dispatch.dispatchX, dispatch.dispatchY);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, cpuValues.byteLength);
    options.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(constants.mapRead, 0, cpuValues.byteLength);
    const gpuValues = new Float32Array(readback.getMappedRange(0, cpuValues.byteLength)).slice();
    readback.unmap();

    let maxAbsoluteError = 0;
    let maxUlp = 0;
    let nonFinite = 0;
    const histogram = {
      exact: 0,
      ulp1: 0,
      ulp2To4: 0,
      ulp5To16: 0,
      ulp17Plus: 0,
    };
    for (let index = 0; index < sampleCount; index += 1) {
      const cpu = cpuValues[index]!;
      const gpu = gpuValues[index]!;
      if (!Number.isFinite(cpu) || !Number.isFinite(gpu)) {
        nonFinite += 1;
        continue;
      }
      maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(cpu - gpu));
      const ulp = Math.abs(orderedFloatBits(cpu) - orderedFloatBits(gpu));
      maxUlp = Math.max(maxUlp, ulp);
      if (ulp === 0) histogram.exact += 1;
      else if (ulp === 1) histogram.ulp1 += 1;
      else if (ulp <= 4) histogram.ulp2To4 += 1;
      else if (ulp <= 16) histogram.ulp5To16 += 1;
      else histogram.ulp17Plus += 1;
    }
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: dispatch.dispatchX * dispatch.dispatchY,
      requestedLane: 'webgpu',
      resultConsumed: gpuValues.length === sampleCount,
    });
    if (nonFinite > 0) {
      throw new Error(`K4 produced ${nonFinite} non-finite comparisons`);
    }
    return {
      histogram,
      maxAbsoluteError,
      maxUlp,
      sampleCount,
    };
  } finally {
    buffers.forEach((buffer) => buffer.destroy());
    options.runtime.module._free(boundsPointer);
    options.runtime.module._free(cpuCoordinatesPointer);
    options.runtime.module._free(cpuValuesPointer);
    options.runtime.abi.nanoDispose(snapshot.handle);
    voxels.dispose();
    session.dispose();
  }
};

const FMA_OPERANDS = [
  [59.336978912353516, -833.156005859375, 49436.91796875],
  [13.295721054077148, -123.22908020019531, 1638.3519287109375],
  [76.48648071289062, 539.8080444335938, -41287.953125],
  [-541.4644165039062, -173.85125732421875, -94134.3125],
  [974.5603637695312, -582.8273315429688, 568000.4375],
  [928.5485229492188, 605.8433837890625, -562554.9375],
  [810.6235961914062, -493.9886779785156, 400438.8125],
  [835.0673217773438, -672.02197265625, 561183.625],
  [934.2449951171875, 911.886962890625, -851925.75],
  [507.95458984375, 832.4600830078125, -422851.9375],
  [-876.4014282226562, 937.616455078125, 821728.4375],
  [592.7744140625, 183.68252563476562, -108882.2890625],
  [35.910091400146484, 619.2056884765625, -22235.65234375],
  [-43.92039108276367, -184.41712951660156, -8099.603515625],
  [-66.99906158447266, -467.2255554199219, -31303.73828125],
  [-775.6477661132812, -590.029296875, -457654.96875],
] as const;

const runFmaProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
}) => {
  const constants = gpuConstants();
  const operands = new Float32Array(FMA_OPERANDS.length * 4);
  FMA_OPERANDS.forEach(([a, b, c], index) => {
    operands.set([a, b, c, 0], 4 * index);
  });
  const outputBytes = FMA_OPERANDS.length * 4;
  const input = options.device.createBuffer({
    size: operands.byteLength,
    usage: constants.buffer.COPY_DST | constants.buffer.STORAGE,
  });
  const output = options.device.createBuffer({
    size: outputBytes,
    usage: constants.buffer.COPY_SRC | constants.buffer.STORAGE,
  });
  const parameters = options.device.createBuffer({
    size: 16,
    usage: constants.buffer.COPY_DST | constants.buffer.UNIFORM,
  });
  const readback = options.device.createBuffer({
    size: outputBytes,
    usage: constants.buffer.COPY_DST | constants.buffer.MAP_READ,
  });
  try {
    options.device.queue.writeBuffer(input, 0, operands);
    options.device.queue.writeBuffer(parameters, 0, new Uint32Array([FMA_OPERANDS.length, 0, 0, 0]));
    const bindGroup = options.device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: parameters } },
      ],
      layout: options.pipeline.getBindGroupLayout(0),
    });
    const encoder = options.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(options.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(FMA_OPERANDS.length / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
    options.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(constants.mapRead, 0, outputBytes);
    const results = new Float32Array(readback.getMappedRange(0, outputBytes)).slice();
    readback.unmap();

    let fusedMatches = 0;
    let unfusedMatches = 0;
    let other = 0;
    FMA_OPERANDS.forEach(([a, b, c], index) => {
      const fused = Math.fround(a * b + c);
      const unfused = Math.fround(Math.fround(a * b) + c);
      const gpu = results[index]!;
      if (gpu === fused) fusedMatches += 1;
      else if (gpu === unfused) unfusedMatches += 1;
      else other += 1;
    });
    if (other > 0) {
      throw new Error(`FMA probe produced ${other} unclassified results`);
    }
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: 1,
      requestedLane: 'webgpu',
      resultConsumed: results.length === FMA_OPERANDS.length,
    });
    return {
      fusedMatches,
      observation:
        fusedMatches === FMA_OPERANDS.length ? 'fused' : unfusedMatches === FMA_OPERANDS.length ? 'unfused' : 'mixed',
      other,
      samples: FMA_OPERANDS.length,
      unfusedMatches,
    };
  } finally {
    input.destroy();
    output.destroy();
    parameters.destroy();
    readback.destroy();
  }
};

const runCostRegime = async (options: {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
  readonly voxelSize: number;
}) => {
  const session = await options.runtime.createSession({
    voxelSize: options.voxelSize,
  });
  const voxels = session.createVoxels({ shape: 'sphere', radius: 20 });
  let snapshot: NanoSnapshotInfo | undefined;
  try {
    const create = await collect(() => {
      const created = options.runtime.abi.nanoCreate(session.handle, voxels.handle);
      options.runtime.abi.nanoDispose(created.handle);
      return created.byteSize;
    });
    snapshot = options.runtime.abi.nanoCreate(session.handle, voxels.handle);

    let lastGpu!: LeafTransformRun;
    for (let index = 0; index < WARMUPS; index += 1) {
      lastGpu = await runLeafTransform({
        device: options.device,
        info: snapshot,
        operand: 1,
        operation: 0,
        pipeline: options.pipeline,
        report: options.report,
        runtime: options.runtime,
      });
    }
    const wallMs: number[] = [];
    const uploadEnqueueMs: number[] = [];
    const kernelGpuMs: number[] = [];
    for (let index = 0; index < REPEATS; index += 1) {
      lastGpu = await runLeafTransform({
        device: options.device,
        info: snapshot,
        operand: 1,
        operation: 0,
        pipeline: options.pipeline,
        report: options.report,
        runtime: options.runtime,
      });
      wallMs.push(lastGpu.wallMs);
      uploadEnqueueMs.push(lastGpu.uploadEnqueueMs);
      if (lastGpu.gpuMs !== null) kernelGpuMs.push(lastGpu.gpuMs);
    }
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: lastGpu.dispatchCount,
      requestedLane: 'webgpu',
      resultConsumed: lastGpu.bytes.byteLength === snapshot.byteSize,
    });

    options.runtime.stager.copyToHeap(lastGpu.bytes, {
      heapOffset: snapshot.data,
    });
    const apply = await collect(() => options.runtime.abi.nanoApplyValues(snapshot!.handle));
    const rebuild = await collect(() => options.runtime.abi.nanoRebuildValues(snapshot!.handle));
    const createStatistics = summarizeBootstrapMedian(create.samplesMs);
    const wallStatistics = summarizeBootstrapMedian(wallMs);
    const uploadStatistics = summarizeBootstrapMedian(uploadEnqueueMs);
    const applyStatistics = summarizeBootstrapMedian(apply.samplesMs);
    const rebuildStatistics = summarizeBootstrapMedian(rebuild.samplesMs);
    const kernelStatistics =
      kernelGpuMs.length === REPEATS && kernelGpuMs.every((sample) => sample > 0)
        ? summarizeBootstrapMedian(kernelGpuMs)
        : null;
    const effectiveKernelMs = kernelStatistics?.median ?? Math.min(wallStatistics.median, 0);
    const writebackMs = Math.min(applyStatistics.median, rebuildStatistics.median);
    const transportMs = createStatistics.median + Math.max(0, wallStatistics.median - effectiveKernelMs) + writebackMs;
    return {
      activeCount: snapshot.activeCount,
      apply: applyStatistics,
      byteSize: snapshot.byteSize,
      chunks: lastGpu.chunks.length,
      createNanoGrid: createStatistics,
      effectiveUploadGBps: snapshot.byteSize / (uploadStatistics.median * 1_000_000),
      gpuWall: wallStatistics,
      kernelGpu: kernelStatistics,
      kernelGpuRawMs: kernelGpuMs,
      kernelTimestampZeroSamples: kernelGpuMs.filter((sample) => sample === 0).length,
      leafCount: snapshot.leafCount,
      rebuild: rebuildStatistics,
      transportFractionOfOffset: transportMs / OFFSET_CPU_BASELINE_MS,
      transportMs,
      uploadEnqueue: uploadStatistics,
      voxelSize: options.voxelSize,
    };
  } finally {
    if (snapshot !== undefined) {
      options.runtime.abi.nanoDispose(snapshot.handle);
    }
    voxels.dispose();
    session.dispose();
  }
};

const runChunkingProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly report: WebGpuCapabilityReport;
  readonly runtime: PicoSpikeRuntime;
}) => {
  const session = await options.runtime.createSession({ voxelSize: 0.5 });
  const voxels = session.createVoxels({ shape: 'empty' });
  let snapshot: NanoSnapshotInfo | undefined;
  try {
    options.runtime.abi.nanoPopulateSynthetic(session.handle, voxels.handle, 70_000);
    snapshot = options.runtime.abi.nanoCreate(session.handle, voxels.handle);
    if (snapshot.byteSize <= 128 * MIB) {
      throw new Error(`Synthetic NanoVDB is only ${snapshot.byteSize} bytes; expected >128 MiB`);
    }
    const expected = copyHeap(options.runtime, snapshot.data, snapshot.byteSize);
    const gpu = await runLeafTransform({
      device: options.device,
      info: snapshot,
      operand: 1,
      operation: 0,
      pipeline: options.pipeline,
      report: options.report,
      runtime: options.runtime,
    });
    const mismatch = firstByteMismatch(gpu.bytes, expected);
    if (mismatch !== null) {
      throw new Error(`Chunked identity mismatch at byte ${mismatch}`);
    }
    if (gpu.chunks.length < 2) {
      throw new Error('Synthetic NanoVDB did not engage chunked bindings');
    }
    assertAccelerationEngaged({
      activeLane: 'webgpu',
      adapter: options.report.adapter.description || options.report.adapter.device || options.report.adapter.vendor,
      dispatchCount: gpu.dispatchCount,
      requestedLane: 'webgpu',
      resultConsumed: mismatch === null,
    });
    return {
      activeCount: snapshot.activeCount,
      bindingSizes: gpu.chunks.map((chunk) => chunk.bindingSize),
      bitExact: true,
      byteSize: snapshot.byteSize,
      chunks: gpu.chunks.length,
      leafCount: snapshot.leafCount,
      maximumChunkBytes: Math.max(...gpu.chunks.map((chunk) => chunk.bindingSize)),
    };
  } finally {
    if (snapshot !== undefined) {
      options.runtime.abi.nanoDispose(snapshot.handle);
    }
    voxels.dispose();
    session.dispose();
  }
};

export const runVdbTransportProbe = async (options: {
  readonly device: GPUDevice;
  readonly pipelines: ComputePipelineCache;
  readonly report: WebGpuCapabilityReport;
}) => {
  const runtime = await loadPicoSpikeRuntime();
  try {
    console.info('[picovoxel:spike] P1 runtime ready');
    const leafPipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'nanovdb-leaf-transform',
    });
    const samplePipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'nanovdb-sample',
    });
    const fmaPipeline = await options.pipelines.get({
      constants: { WORKGROUP_SIZE },
      entryPoint: 'main',
      shaderId: 'mul-add-probe',
    });
    console.info('[picovoxel:spike] P1 static pipelines compiled');

    const K1 = await runParityKernel({
      ...options,
      name: 'K1 identity',
      operand: 0,
      operation: 0,
      pipeline: leafPipeline,
      runtime,
    });
    console.info('[picovoxel:spike] P1 K1 complete');
    const K2 = await runParityKernel({
      ...options,
      name: 'K2 scale',
      operand: 2,
      operation: 1,
      pipeline: leafPipeline,
      runtime,
    });
    console.info('[picovoxel:spike] P1 K2 complete');
    const K3 = await runParityKernel({
      ...options,
      name: 'K3 offset',
      operand: 0.5,
      operation: 2,
      pipeline: leafPipeline,
      runtime,
    });
    console.info('[picovoxel:spike] P1 K3 complete');
    const parity = { K1, K2, K3 };
    const trilinear = await runTrilinearProbe({
      ...options,
      pipeline: samplePipeline,
      runtime,
    });
    console.info('[picovoxel:spike] P1 K4 complete');
    const fma = await runFmaProbe({
      ...options,
      pipeline: fmaPipeline,
    });
    console.info('[picovoxel:spike] P1 FMA probe complete');
    const costCurve = [];
    for (const voxelSize of [0.5, 0.25, 0.125, 0.0625]) {
      costCurve.push(
        await runCostRegime({
          ...options,
          pipeline: leafPipeline,
          runtime,
          voxelSize,
        }),
      );
      console.info(`[picovoxel:spike] P1 cost regime ${voxelSize} complete`);
    }
    const chunking = await runChunkingProbe({
      ...options,
      pipeline: leafPipeline,
      runtime,
    });
    console.info('[picovoxel:spike] P1 >128 MiB chunk probe complete');
    const blockingGates = {
      E1: Object.values(parity).every((kernel) => kernel.byteExact && kernel.roundTripByteExact),
      E2: costCurve.length === 4,
      E3: chunking.byteSize > 128 * MIB && chunking.chunks > 1,
      E5: fma.other === 0,
    };
    const atOrAbove585k = costCurve.filter((regime) => regime.activeCount >= 585_000);
    const e4 = {
      decision:
        atOrAbove585k.length > 0 && atOrAbove585k.every((regime) => regime.transportFractionOfOffset <= 0.3)
          ? 'per-op-economics-survive'
          : 'gpu-resident-chaining-required',
      limit: 0.3,
      measured: atOrAbove585k.map((regime) => ({
        activeCount: regime.activeCount,
        fraction: regime.transportFractionOfOffset,
      })),
    };
    return {
      adapter: options.report.adapter,
      chunking,
      costCurve,
      decision: Object.values(blockingGates).every(Boolean) ? 'go' : 'no-go',
      fma,
      gates: { ...blockingGates, E4: e4 },
      heapStaging: runtime.stager.mode,
      parity,
      status: 'available',
      trilinear,
    };
  } finally {
    runtime.dispose();
  }
};
