import type { WebGpuSpikeCommand, WebGpuSpikeRequest, WebGpuSpikeResponse } from './protocol.ts';

export interface WorkerLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WebGpuSpikeRequest): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

const createModuleWorker = (): WorkerLike =>
  new Worker(new URL('./worker.js', import.meta.url), {
    name: 'picovoxel-webgpu-spike',
    type: 'module',
  });

const isResponse = (value: unknown): value is WebGpuSpikeResponse => {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'id') === 'number';
};

export class WebGpuSpikeClient {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #worker: WorkerLike;
  #destroyed = false;
  #nextId = 1;

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isResponse(event.data)) return;
    const pending = this.#pending.get(event.data.id);
    if (pending === undefined) return;
    this.#pending.delete(event.data.id);
    if ('error' in event.data) {
      pending.reject(new Error(event.data.error));
      return;
    }
    pending.resolve(event.data.result);
  };

  constructor(workerFactory: () => WorkerLike = createModuleWorker) {
    this.#worker = workerFactory();
    this.#worker.addEventListener('message', this.#onMessage);
  }

  request(command: WebGpuSpikeCommand): Promise<unknown> {
    if (this.#destroyed) return Promise.reject(new Error('WebGPU spike client is destroyed'));
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#worker.postMessage({ command, id });
    return response;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('WebGPU spike client is destroyed'));
    }
    this.#pending.clear();
  }
}
