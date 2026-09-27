import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = resolve(ROOT, 'spikes/webgpu/node-compute');
const NATIVE = resolve(CRATE, 'target/release/picovoxel-webgpu-node-spike-native');
const ADDON = resolve(CRATE, 'dist/picovoxel-webgpu-node-spike.node');

execFileSync('bash', ['scripts/build-node-webgpu-spike.sh'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const nativeResult = JSON.parse(execFileSync(NATIVE, { encoding: 'utf8' }));
const require = createRequire(import.meta.url);
const addon = require(ADDON);
const napiResult = JSON.parse(addon.runSaxpy());

const expected = [12, 24, 36, 48];
for (const [label, result] of [
  ['native', nativeResult],
  ['napi', napiResult],
]) {
  if (!result.acceleratedPathEngaged) {
    throw new Error(`${label}: native WebGPU path did not engage`);
  }
  if (JSON.stringify(result.values) !== JSON.stringify(expected)) {
    throw new Error(`${label}: SAXPY mismatch ${JSON.stringify(result.values)}`);
  }
}
if (nativeResult.adapterName !== napiResult.adapterName || nativeResult.backend !== napiResult.backend) {
  throw new Error('Native binary and Node addon selected different adapters');
}

const softwareProbe = spawnSync(NATIVE, {
  encoding: 'utf8',
  env: {
    ...process.env,
    WGPU_ADAPTER_NAME: 'llvmpipe',
    WGPU_BACKEND: 'vulkan',
  },
});
const softwareResult = softwareProbe.status === 0 ? JSON.parse(softwareProbe.stdout) : undefined;
const softwareAdapterEngaged =
  softwareResult?.backend === 'Vulkan' && softwareResult.adapterName.toLowerCase().includes('llvmpipe');

console.log(
  JSON.stringify(
    {
      environment: {
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
        os: `${platform()} ${release()}`,
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
        wgpu: '30.0.0',
      },
      napi: napiResult,
      native: nativeResult,
      softwareAdapterProbe: softwareAdapterEngaged
        ? {
            available: true,
            result: softwareResult,
          }
        : {
            available: false,
            requested: {
              adapterName: 'llvmpipe',
              backend: 'vulkan',
            },
            reason:
              softwareProbe.status === 0
                ? `requested software adapter was not selected; got ${softwareResult.adapterName} (${softwareResult.backend})`
                : softwareProbe.stderr.trim(),
          },
    },
    null,
    2,
  ),
);
