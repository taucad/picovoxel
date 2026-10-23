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
      serial: { raw: 6_276_985, gzip: 1_317_752, brotli: 561_795 },
      multi: { raw: 6_335_092, gzip: 1_362_040, brotli: 592_908 },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_362_041, brotli: 592_909 }), [
      'gzip 1362041 > 1362040',
      'brotli 592909 > 592908',
    ]);
  });
});
