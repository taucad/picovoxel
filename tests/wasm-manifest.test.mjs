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
      serial: { raw: 6_358_505, gzip: Math.ceil(1_348_765 * 1.005), brotli: Math.ceil(581_546 * 1.005) },
      multi: { raw: 6_409_397, gzip: Math.ceil(1_402_125 * 1.005), brotli: Math.ceil(612_776 * 1.005) },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_409_137, brotli: 615_841 }), [
      'gzip 1409137 > 1409136',
      'brotli 615841 > 615840',
    ]);
  });
});
