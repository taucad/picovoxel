import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SHADERS = [
  'spikes/webgpu/emdawn/hello-compute.wgsl',
  'spikes/webgpu/node-compute/core/src/saxpy.wgsl',
  'spikes/webgpu/shaders/empty.wgsl',
  'spikes/webgpu/shaders/gyroid-unrolled.wgsl',
  'spikes/webgpu/shaders/mul-add-probe.wgsl',
  'spikes/webgpu/shaders/nanovdb-leaf-transform.wgsl',
  'spikes/webgpu/shaders/nanovdb-sample.wgsl',
  'spikes/webgpu/shaders/reduce.wgsl',
  'spikes/webgpu/shaders/saxpy.wgsl',
  'spikes/webgpu/shaders/tape-gyroid-specialized.wgsl',
  'spikes/webgpu/shaders/tape-indirect-args.wgsl',
  'spikes/webgpu/shaders/tape-interpreter-subgroup.wgsl',
  'spikes/webgpu/shaders/tape-interpreter.wgsl',
];

describe('checked-in WebGPU spike shaders', () => {
  for (const name of SHADERS) {
    it(`${name} is static and bounds checked`, async () => {
      const source = await readFile(resolve(name), 'utf8');
      expect(source).toContain('@compute');
      expect(source).toContain('@builtin(global_invocation_id)');
      if (name.endsWith('tape-interpreter-subgroup.wgsl')) {
        expect(source).toContain('if (linearIndex < params.elementCount)');
      } else {
        expect(source).toMatch(/\w+(?:\.x)?\s*>=\s*.+element_?count/i);
      }
      expect(source).not.toContain('new Function');
    });
  }
});
