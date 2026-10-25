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
      serial: { raw: 6_287_297, gzip: 1_321_909, brotli: 562_728 },
      multi: { raw: 6_345_288, gzip: 1_364_077, brotli: 594_578 },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_364_078, brotli: 594_579 }), [
      'gzip 1364078 > 1364077',
      'brotli 594579 > 594578',
    ]);
  });
});
