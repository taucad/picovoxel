export interface ComputePipelineRequest {
  readonly constants?: Readonly<Record<string, number>>;
  readonly entryPoint: string;
  readonly shaderId: string;
}

const specializationKey = (constants: Readonly<Record<string, number>> | undefined): string =>
  JSON.stringify(Object.entries(constants ?? {}).sort(([left], [right]) => left.localeCompare(right)));

const compilationError = (shaderId: string, messages: readonly GPUCompilationMessage[]): Error | null => {
  const errors = messages.filter((message) => message.type === 'error');
  if (errors.length === 0) return null;
  return new Error(
    errors
      .map((message) => `${shaderId}:${message.lineNum}:${message.linePos}: ${message.message}`)
      .join('\n'),
  );
};

export class ComputePipelineCache {
  readonly #device: GPUDevice;
  readonly #pipelines = new Map<string, Promise<GPUComputePipeline>>();
  readonly #shaderModules = new Map<string, Promise<GPUShaderModule>>();
  readonly #sources: Readonly<Record<string, string>>;

  constructor(device: GPUDevice, sources: Readonly<Record<string, string>>) {
    this.#device = device;
    this.#sources = sources;
  }

  async #getShaderModule(shaderId: string): Promise<GPUShaderModule> {
    const cached = this.#shaderModules.get(shaderId);
    if (cached !== undefined) return cached;

    const source = this.#sources[shaderId];
    if (source === undefined) throw new Error(`Unknown static WGSL shader: ${shaderId}`);
    const pending = (async () => {
      const module = this.#device.createShaderModule({
        code: source,
        label: `picovoxel:${shaderId}`,
      });
      const info = await module.getCompilationInfo();
      const error = compilationError(shaderId, info.messages);
      if (error !== null) throw error;
      return module;
    })();
    this.#shaderModules.set(shaderId, pending);
    try {
      return await pending;
    } catch (error) {
      this.#shaderModules.delete(shaderId);
      throw error;
    }
  }

  async #create(request: ComputePipelineRequest): Promise<GPUComputePipeline> {
    const module = await this.#getShaderModule(request.shaderId);
    this.#device.pushErrorScope('validation');
    let pipeline: GPUComputePipeline | undefined;
    let creationFailure: unknown;
    try {
      pipeline = await this.#device.createComputePipelineAsync({
        compute: {
          constants: request.constants,
          entryPoint: request.entryPoint,
          module,
        },
        label: `picovoxel:${request.shaderId}:${request.entryPoint}`,
        layout: 'auto',
      });
    } catch (error) {
      creationFailure = error;
    }
    const validationError = await this.#device.popErrorScope();
    if (validationError !== null) throw new Error(validationError.message);
    if (creationFailure !== undefined) throw creationFailure;
    if (pipeline === undefined) throw new Error('WebGPU pipeline creation returned no pipeline');
    return pipeline;
  }

  get(request: ComputePipelineRequest): Promise<GPUComputePipeline> {
    const key = [request.shaderId, request.entryPoint, specializationKey(request.constants)].join('\u0000');
    const cached = this.#pipelines.get(key);
    if (cached !== undefined) return cached;

    const pending = this.#create(request);
    this.#pipelines.set(key, pending);
    void pending.catch(() => this.#pipelines.delete(key));
    return pending;
  }
}
