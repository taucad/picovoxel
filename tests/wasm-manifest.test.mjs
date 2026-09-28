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
      serial: { raw: 6_071_228, gzip: 1_283_336, brotli: 543_655 },
      multi: { raw: 6_136_964, gzip: 1_326_542, brotli: 572_688 },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_326_543, brotli: 572_689 }), [
      'gzip 1326543 > 1326542',
      'brotli 572689 > 572688',
    ]);
  });
});
