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
      serial: { raw: 6_061_993, gzip: 1_284_327, brotli: 543_004 },
      multi: { raw: 6_127_793, gzip: 1_323_605, brotli: 571_719 },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_323_606, brotli: 571_720 }), [
      'gzip 1323606 > 1323605',
      'brotli 571720 > 571719',
    ]);
  });
});
