import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CEILINGS, overCeilings } from '../scripts/wasm-manifest.mjs';

describe('wasm byte ceilings', () => {
  for (const variant of ['serial', 'multi']) {
    it(`${variant}: passes at the ceilings and fails one raw byte over`, () => {
      const ceiling = CEILINGS[variant];
      assert.deepEqual(overCeilings(variant, ceiling), []);
      assert.deepEqual(overCeilings(variant, { ...ceiling, raw: ceiling.raw + 1 }), [
        `raw ${ceiling.raw + 1} > ${ceiling.raw}`,
      ]);
    });
  }

  it('keeps 0.5% compressor headroom and none on raw', () => {
    assert.deepEqual(CEILINGS, {
      serial: { raw: 6_287_297, gzip: 1_321_909, brotli: Math.ceil(563_493 * 1.005) },
      multi: { raw: 6_345_288, gzip: Math.ceil(1_379_202 * 1.005), brotli: Math.ceil(594_665 * 1.005) },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_386_100, brotli: 597_640 }), [
      'gzip 1386100 > 1386099',
      'brotli 597640 > 597639',
    ]);
  });
});
