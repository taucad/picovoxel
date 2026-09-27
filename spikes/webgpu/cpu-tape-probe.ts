export interface GyroidProbeParameters {
  readonly elementCount: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly scale: number;
  readonly spacing: number;
  readonly threshold: number;
  readonly width: number;
}

export interface ProbeRun {
  readonly checksum: number;
  readonly ms: number;
  readonly sampleIndices: readonly number[];
  readonly sampleValues: readonly number[];
}

interface CpuTapeModule {
  readonly HEAPF32: Float32Array;
  readonly _free: (pointer: number) => void;
  readonly _malloc: (size: number) => number;
  readonly cwrap: (
    name: string,
    returnType: 'number',
    argumentTypes: readonly 'number'[],
  ) => (...arguments_: number[]) => number;
}

interface CpuTapeModuleNamespace {
  readonly default: () => Promise<CpuTapeModule>;
}

const sampleIndices = (elementCount: number): number[] =>
  Array.from(new Set(Array.from({ length: 257 }, (_, index) => Math.floor((index * (elementCount - 1)) / 256))));

export class CpuTapeProbe {
  readonly #evaluate: (...arguments_: number[]) => number;
  readonly #lastThreadCount: () => number;
  readonly #maxElementCount: number;
  readonly #module: CpuTapeModule;
  readonly #outputPointer: number;

  private constructor(module: CpuTapeModule, maxElementCount: number) {
    this.#module = module;
    this.#maxElementCount = maxElementCount;
    this.#outputPointer = module._malloc(maxElementCount * Float32Array.BYTES_PER_ELEMENT);
    if (this.#outputPointer === 0) throw new Error('CPU tape probe output allocation failed');
    this.#evaluate = module.cwrap(
      'CpuTapeProbe_Eval',
      'number',
      Array.from({ length: 11 }, () => 'number'),
    );
    this.#lastThreadCount = module.cwrap('CpuTapeProbe_LastThreadCount', 'number', []);
  }

  static async create(maxElementCount: number): Promise<CpuTapeProbe> {
    const filename = 'cpu-tape-probe.mjs';
    const moduleUrl = new URL(filename, import.meta.url);
    const namespace = (await import(moduleUrl.href)) as CpuTapeModuleNamespace;
    return new CpuTapeProbe(await namespace.default(), maxElementCount);
  }

  get lastThreadCount(): number {
    return this.#lastThreadCount();
  }

  run(parameters: GyroidProbeParameters, threadLimit: number): ProbeRun {
    if (parameters.elementCount > this.#maxElementCount) {
      throw new RangeError('CPU tape probe request exceeds its output allocation');
    }
    const begin = performance.now();
    const evaluated = this.#evaluate(
      this.#outputPointer,
      parameters.elementCount,
      parameters.width,
      parameters.height,
      parameters.originX,
      parameters.originY,
      parameters.originZ,
      parameters.spacing,
      parameters.scale,
      parameters.threshold,
      threadLimit,
    );
    const indices = sampleIndices(parameters.elementCount);
    const outputOffset = this.#outputPointer / Float32Array.BYTES_PER_ELEMENT;
    const values = indices.map((index) => this.#module.HEAPF32[outputOffset + index]!);
    const ms = performance.now() - begin;
    if (evaluated !== parameters.elementCount) {
      throw new Error(`CPU tape probe evaluated ${evaluated}/${parameters.elementCount} points`);
    }
    return {
      checksum: values.reduce((sum, value) => sum + value, 0),
      ms,
      sampleIndices: indices,
      sampleValues: values,
    };
  }

  destroy(): void {
    this.#module._free(this.#outputPointer);
  }
}
