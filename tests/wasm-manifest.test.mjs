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
      serial: { raw: 6_324_876, gzip: Math.ceil(1_337_380 * 1.005), brotli: Math.ceil(572_487 * 1.005) },
      multi: { raw: 6_374_429, gzip: Math.ceil(1_388_669 * 1.005), brotli: Math.ceil(605_530 * 1.005) },
    });
    assert.deepEqual(overCeilings('multi', { raw: 1, gzip: 1_395_614, brotli: 608_559 }), [
      'gzip 1395614 > 1395613',
      'brotli 608559 > 608558',
    ]);
  });
});
