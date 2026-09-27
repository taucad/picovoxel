import { WebGpuSpikeClient } from './client.ts';

interface RunnerGlobals {
  __done?: boolean;
  __error?: string;
  __result?: unknown;
}

const globals = globalThis as typeof globalThis & RunnerGlobals;
const output = document.querySelector('pre');
const client = new WebGpuSpikeClient();
const mode = new URL(globalThis.location.href).searchParams.get('mode');
const command =
  mode === 'p0'
    ? ({ kind: 'run-p0' } as const)
    : mode === 'p1'
      ? ({ kind: 'run-p1' } as const)
      : mode === 'p2'
        ? ({ kind: 'run-p2' } as const)
        : ({ kind: 'probe' } as const);

const render = (value: unknown): void => {
  if (output !== null) output.textContent = JSON.stringify(value, null, 2);
};

void client.request(command).then(
  (result) => {
    globals.__result = result;
    globals.__done = true;
    render(result);
    client.destroy();
  },
  (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    globals.__error = detail;
    globals.__done = true;
    render({ error: detail });
    client.destroy();
  },
);
