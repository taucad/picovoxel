// WA5 — the module build refuses -Oz before it touches vendor/: at
// SHRINK_LEVEL 2 emscripten links libc_optz, whose pow/log/log2 differ from
// libc's and would move exact-lane output. It refuses -mrelaxed-simd too, the
// one flag that would bring fused multiply-add to wasm.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = new URL('../scripts/build-pico-module.sh', import.meta.url).pathname;
const run = (env) =>
  spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, EMSDK: '/nonexistent', ...env } });

describe('build-pico-module.sh flag guard', () => {
  for (const env of [
    { WASM_FLAGS: '-Oz -msimd128' },
    { WASM_FLAGS: '-O3 -msimd128 -sSHRINK_LEVEL=2' },
    { EH_FLAGS: '-fwasm-exceptions -Oz' },
  ]) {
    it(`refuses ${JSON.stringify(env)}`, () => {
      const { status, stderr } = run(env);
      assert.equal(status, 1);
      assert.match(stderr, /libc_optz.*refusing \(WA5\)/u);
    });
  }

  it('refuses -mrelaxed-simd, whose relaxed_madd may fuse', () => {
    const { status, stderr } = run({ WASM_FLAGS: '-O3 -msimd128 -mrelaxed-simd' });
    assert.equal(status, 1);
    assert.match(stderr, /fused multiply-add/u);
  });

  it('lets the default and -Os flags through to the vendor check', () => {
    for (const env of [{}, { WASM_FLAGS: '-Os -msimd128' }]) {
      const { status, stderr } = run(env);
      assert.equal(status, 1);
      assert.doesNotMatch(stderr, /WA5/u);
      assert.match(stderr, /missing vendor\/ sources/u);
    }
  });
});
