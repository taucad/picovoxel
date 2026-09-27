import { bindPicoRaw, type PicoRaw } from '../../src/raw.generated.ts';
import {
  createPicoSession,
  type CreatePicoOptions,
  type Pico,
  type PicoGlueFactory,
} from '../../src/session.ts';
import type { PicoWasmModule } from '../../src/types.ts';
import { createHeapStager, type HeapStager } from './heap-view.ts';

export interface NanoSnapshotInfo {
  readonly activeCount: number;
  readonly byteSize: number;
  readonly data: number;
  readonly handle: number;
  readonly leafCount: number;
  readonly leafOffset: number;
  readonly leafStride: number;
}

export interface TapeGpuInfo {
  readonly background: number;
  readonly constantCount: number;
  readonly constantData: number;
  readonly interiorCount: number;
  readonly outputCount: number;
  readonly slabCount: number;
  readonly slabData: number;
  readonly tapeCount: number;
  readonly tapeData: number;
  readonly voxelSize: number;
}

export interface SpikePicoModule extends PicoWasmModule {
  readonly HEAPU8: Uint8Array;
  readonly PThread?: PicoWasmModule['PThread'] & {
    terminateAllThreads?: () => void;
  };
}

export interface WebGpuSpikeAbi {
  readonly nanoApplyValues: (snapshot: number) => number;
  readonly nanoBounds: (snapshot: number, bounds: number) => void;
  readonly nanoCreate: (library: bigint, voxels: bigint) => NanoSnapshotInfo;
  readonly nanoDispose: (snapshot: number) => void;
  readonly nanoPopulateSynthetic: (library: bigint, voxels: bigint, leafCount: number) => void;
  readonly nanoRebuildValues: (snapshot: number) => number;
  readonly nanoSampleBox: (snapshot: number, coordinates: number, count: number, values: number) => void;
  readonly nanoTransformActive: (snapshot: number, operation: number, operand: number) => number;
  readonly tapeClassify: (options: {
    readonly bounds: number;
    readonly constantCount: number;
    readonly constants: number;
    readonly instructionCount: number;
    readonly instructions: number;
    readonly library: bigint;
    readonly voxels: bigint;
  }) => number;
  readonly tapeDispose: (plan: number) => void;
  readonly tapeEvalCpuSamples: (plan: number, indices: number, count: number, values: number) => void;
  readonly tapeInfo: (plan: number) => TapeGpuInfo;
  readonly tapeIngest: (plan: number, values: number, valueCount: number) => number;
}

export interface PicoSpikeRuntime {
  readonly abi: WebGpuSpikeAbi;
  readonly module: SpikePicoModule;
  readonly raw: PicoRaw;
  readonly stager: HeapStager;
  readonly createSession: (options?: CreatePicoOptions) => Promise<Pico>;
  readonly dispose: () => void;
}

type NanoCreateC = (
  library: bigint,
  voxels: bigint,
  data: number,
  byteSize: number,
  leafCount: number,
  activeCount: number,
  leafOffset: number,
  leafStride: number,
) => number;

const bindSpikeAbi = (module: SpikePicoModule): WebGpuSpikeAbi => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the cwrap signature it expects back
  const wrap = <FunctionType>(
    name: string,
    returnType: string | null,
    argumentTypes: readonly string[],
  ): FunctionType => module.cwrap(name, returnType, argumentTypes) as unknown as FunctionType;

  const nanoCreateC = wrap<NanoCreateC>('Voxels_NanoCreate', 'number', [
    'bigint',
    'bigint',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
  ]);
  const nanoApplyValues = wrap<(snapshot: number) => number>('Voxels_NanoApplyValues', 'number', ['number']);
  const nanoRebuildValues = wrap<(snapshot: number) => number>('Voxels_NanoRebuildValues', 'number', [
    'number',
  ]);
  const nanoTransformActive = wrap<(snapshot: number, operation: number, operand: number) => number>(
    'Voxels_NanoTransformActive',
    'number',
    ['number', 'number', 'number'],
  );
  const nanoBounds = wrap<(snapshot: number, bounds: number) => void>('Voxels_NanoBounds', null, [
    'number',
    'number',
  ]);
  const nanoSampleBox = wrap<(snapshot: number, coordinates: number, count: number, values: number) => void>(
    'Voxels_NanoSampleBox',
    null,
    ['number', 'number', 'number', 'number'],
  );
  const nanoPopulateSynthetic = wrap<(library: bigint, voxels: bigint, leafCount: number) => void>(
    'Voxels_NanoPopulateSynthetic',
    null,
    ['bigint', 'bigint', 'number'],
  );
  const nanoDispose = wrap<(snapshot: number) => void>('Voxels_NanoDispose', null, ['number']);
  const tapeClassifyC = wrap<
    (
      library: bigint,
      voxels: bigint,
      bounds: number,
      instructions: number,
      instructionCount: number,
      constants: number,
      constantCount: number,
    ) => number
  >('Voxels_TapeGpuClassify', 'number', [
    'bigint',
    'bigint',
    'number',
    'number',
    'number',
    'number',
    'number',
  ]);
  const tapeGetInfo = wrap<(plan: number, info: number) => void>('Voxels_TapeGpuGetInfo', null, [
    'number',
    'number',
  ]);
  const tapeEvalCpuSamples = wrap<(plan: number, indices: number, count: number, values: number) => void>(
    'Voxels_TapeGpuEvalCpuSamples',
    null,
    ['number', 'number', 'number', 'number'],
  );
  const tapeIngest = wrap<(plan: number, values: number, valueCount: number) => number>(
    'Voxels_TapeGpuIngest',
    'number',
    ['number', 'number', 'number'],
  );
  const tapeDispose = wrap<(plan: number) => void>('Voxels_TapeGpuDispose', null, ['number']);

  return {
    nanoApplyValues,
    nanoBounds,
    nanoCreate: (library, voxels) => {
      const outputs = module._malloc(24);
      try {
        const handle = nanoCreateC(
          library,
          voxels,
          outputs,
          outputs + 4,
          outputs + 8,
          outputs + 12,
          outputs + 16,
          outputs + 20,
        );
        const base = outputs >>> 2;
        return {
          activeCount: module.HEAPU32[base + 3]!,
          byteSize: module.HEAPU32[base + 1]!,
          data: module.HEAPU32[base]!,
          handle,
          leafCount: module.HEAPU32[base + 2]!,
          leafOffset: module.HEAPU32[base + 4]!,
          leafStride: module.HEAPU32[base + 5]!,
        };
      } finally {
        module._free(outputs);
      }
    },
    nanoDispose,
    nanoPopulateSynthetic,
    nanoRebuildValues,
    nanoSampleBox,
    nanoTransformActive,
    tapeClassify: (options) =>
      tapeClassifyC(
        options.library,
        options.voxels,
        options.bounds,
        options.instructions,
        options.instructionCount,
        options.constants,
        options.constantCount,
      ),
    tapeDispose,
    tapeEvalCpuSamples,
    tapeInfo: (plan) => {
      const info = module._malloc(40);
      try {
        tapeGetInfo(plan, info);
        const words = info >>> 2;
        return {
          background: module.HEAPF32[words + 9]!,
          constantCount: module.HEAPU32[words + 5]!,
          constantData: module.HEAPU32[words + 4]!,
          interiorCount: module.HEAPU32[words + 7]!,
          outputCount: module.HEAPU32[words + 6]!,
          slabCount: module.HEAPU32[words + 1]!,
          slabData: module.HEAPU32[words]!,
          tapeCount: module.HEAPU32[words + 3]!,
          tapeData: module.HEAPU32[words + 2]!,
          voxelSize: module.HEAPF32[words + 8]!,
        };
      } finally {
        module._free(info);
      }
    },
    tapeIngest,
  };
};

const loadFactory = async (): Promise<PicoGlueFactory> => {
  const moduleUrl = new URL('../picovoxel-dist/pico-webgpu-spike.mjs', import.meta.url).href;
  const imported = (await import(moduleUrl)) as unknown;
  if (
    typeof imported !== 'object' ||
    imported === null ||
    typeof Reflect.get(imported, 'default') !== 'function'
  ) {
    throw new Error('PicoGK WebGPU spike module has no default factory');
  }
  return Reflect.get(imported, 'default') as PicoGlueFactory;
};

export const loadPicoSpikeRuntime = async (): Promise<PicoSpikeRuntime> => {
  const factory = await loadFactory();
  const module = (await factory()) as SpikePicoModule;
  const raw = bindPicoRaw(module);
  const memory = {
    get buffer(): ArrayBufferLike {
      return module.HEAPU8.buffer;
    },
  };
  let disposed = false;

  return {
    abi: bindSpikeAbi(module),
    createSession: (options = {}) => {
      if (disposed) throw new Error('PicoGK WebGPU spike runtime is disposed');
      return createPicoSession(() => Promise.resolve(module), options);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      module.PThread?.terminateAllThreads();
    },
    module,
    raw,
    stager: createHeapStager(memory),
  };
};
