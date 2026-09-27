import { requestWebGpuDevice, type WebGpuDiagnostic } from './device.ts';
import { runGyroidThroughputProbe } from './gyroid-probe.ts';
import { runOverheadProbe } from './overhead-probe.ts';
import { runVdbTransportProbe } from './p1-vdb-transport.ts';
import { runTapeGpuProbe } from './p2-tape-gpu.ts';
import { ComputePipelineCache } from './pipeline-cache.ts';
import type { WebGpuSpikeRequest, WebGpuSpikeResponse } from './protocol.ts';
import { SHADER_SOURCES } from './shaders.ts';

interface SpikeContext {
  readonly device: GPUDevice;
  readonly diagnostics: WebGpuDiagnostic[];
  readonly limits: Awaited<ReturnType<typeof requestWebGpuDevice>> & {
    readonly status: 'available';
  };
  readonly pipelines: ComputePipelineCache;
}

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WebGpuSpikeResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
let context: SpikeContext | undefined;

const isRequest = (value: unknown): value is WebGpuSpikeRequest => {
  if (typeof value !== 'object' || value === null) return false;
  const command: unknown = Reflect.get(value, 'command');
  return (
    typeof Reflect.get(value, 'id') === 'number' &&
    typeof command === 'object' &&
    command !== null &&
    (Reflect.get(command, 'kind') === 'probe' ||
      Reflect.get(command, 'kind') === 'run-p0' ||
      Reflect.get(command, 'kind') === 'run-p1' ||
      Reflect.get(command, 'kind') === 'run-p2')
  );
};

const getContext = async (): Promise<
  SpikeContext | Exclude<Awaited<ReturnType<typeof requestWebGpuDevice>>, { status: 'available' }>
> => {
  if (context !== undefined) return context;

  const diagnostics: WebGpuDiagnostic[] = [];
  const capability = await requestWebGpuDevice({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  if (capability.status === 'unavailable') return capability;

  const pipelines = new ComputePipelineCache(capability.device, SHADER_SOURCES);
  await Promise.all([
    pipelines.get({
      constants: { ELEMENT_COUNT: 1, WORKGROUP_SIZE: 64 },
      entryPoint: 'main',
      shaderId: 'empty',
    }),
    pipelines.get({
      constants: { WORKGROUP_SIZE: 64 },
      entryPoint: 'main',
      shaderId: 'gyroid-unrolled',
    }),
    pipelines.get({
      constants: { WORKGROUP_SIZE: 64 },
      entryPoint: 'main',
      shaderId: 'reduce',
    }),
    pipelines.get({
      constants: { WORKGROUP_SIZE: 64 },
      entryPoint: 'main',
      shaderId: 'saxpy',
    }),
  ]);
  context = {
    device: capability.device,
    diagnostics,
    limits: capability,
    pipelines,
  };
  return context;
};

const probe = async (): Promise<unknown> => {
  const candidate = await getContext();
  if ('status' in candidate) return candidate;
  return {
    diagnostics: candidate.diagnostics,
    report: candidate.limits.report,
    shaderIds: Object.keys(SHADER_SOURCES).sort(),
    status: 'available',
  };
};

const run = async (request: WebGpuSpikeRequest): Promise<unknown> => {
  switch (request.command.kind) {
    case 'probe':
      return probe();
    case 'run-p0': {
      const candidate = await getContext();
      if ('status' in candidate) return candidate;
      const overhead = await runOverheadProbe({
        device: candidate.device,
        pipelines: candidate.pipelines,
        report: candidate.limits.report,
      });
      const gyroid = await runGyroidThroughputProbe({
        device: candidate.device,
        pipelines: candidate.pipelines,
        report: candidate.limits.report,
      });
      return {
        adapter: candidate.limits.report.adapter,
        decision: overhead.decision === 'go' && gyroid.decision === 'go' ? 'go' : 'no-go',
        gyroid,
        limits: candidate.limits.report.limits,
        overhead,
        status: 'available',
      };
    }
    case 'run-p1': {
      const candidate = await getContext();
      if ('status' in candidate) return candidate;
      return runVdbTransportProbe({
        device: candidate.device,
        pipelines: candidate.pipelines,
        report: candidate.limits.report,
      });
    }
    case 'run-p2': {
      const candidate = await getContext();
      if ('status' in candidate) return candidate;
      return runTapeGpuProbe({
        device: candidate.device,
        pipelines: candidate.pipelines,
        report: candidate.limits.report,
      });
    }
  }
};

scope.addEventListener('message', (event) => {
  if (!isRequest(event.data)) return;
  const request = event.data;
  void run(request).then(
    (result) => scope.postMessage({ id: request.id, result }),
    (error: unknown) =>
      scope.postMessage({
        error: error instanceof Error ? error.message : String(error),
        id: request.id,
      }),
  );
});
