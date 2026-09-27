import { describe, expect, it, vi } from 'vitest';

import { WebGpuSpikeClient, type WorkerLike } from '../spikes/webgpu/client.ts';

class MockWorker implements WorkerLike {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  respond(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>);
  }
}

describe('WebGpuSpikeClient', () => {
  it('schedules commands through an owned module worker', async () => {
    const worker = new MockWorker();
    const client = new WebGpuSpikeClient(() => worker);

    const response = client.request({ kind: 'probe' });
    expect(worker.postMessage).toHaveBeenCalledWith({
      command: { kind: 'probe' },
      id: 1,
    });
    worker.respond({ id: 1, result: { status: 'unavailable', reason: 'api-missing' } });

    await expect(response).resolves.toEqual({
      reason: 'api-missing',
      status: 'unavailable',
    });
    client.destroy();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects worker-reported failures without losing later responses', async () => {
    const worker = new MockWorker();
    const client = new WebGpuSpikeClient(() => worker);

    const first = client.request({ kind: 'probe' });
    const second = client.request({ kind: 'probe' });
    worker.respond({ error: 'shader validation failed', id: 1 });
    worker.respond({ id: 2, result: { status: 'available' } });

    await expect(first).rejects.toThrow('shader validation failed');
    await expect(second).resolves.toEqual({ status: 'available' });
    client.destroy();
  });

  it('rejects pending and future work after destruction', async () => {
    const worker = new MockWorker();
    const client = new WebGpuSpikeClient(() => worker);

    const pending = client.request({ kind: 'probe' });
    client.destroy();

    await expect(pending).rejects.toThrow('destroyed');
    await expect(client.request({ kind: 'probe' })).rejects.toThrow('destroyed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
