import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    runner: 'spikes/webgpu/runner.ts',
    worker: 'spikes/webgpu/worker.ts',
  },
  outDir: 'spikes/webgpu/dist',
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: false,
  exports: false,
  loader: {
    '.wgsl': 'text',
  },
});
