// The generated export lists (src/<variant>.exports.ts, build output beside the
// wasm) must match the wasm they describe: createPicoRuntime({ wasmModule })
// pre-flights caller modules against them, so a stale list would refuse the right
// module or admit a wrong one. Regenerate with
// `node scripts/generate-wasm-exports.mjs <variant>` (build-pico-module.sh does it
// after every link).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { generateWasmExportsSource } from '../scripts/generate-wasm-exports.mjs';

for (const variant of ['pico', 'pico-multi']) {
  test(`src/${variant}.exports.ts matches ${variant}.wasm`, () => {
    const src = join(import.meta.dirname, '..', 'src');
    assert.equal(
      readFileSync(join(src, `${variant}.exports.ts`), 'utf8'),
      generateWasmExportsSource(variant, readFileSync(join(src, `${variant}.wasm`))),
      `stale export list — run node scripts/generate-wasm-exports.mjs ${variant}`,
    );
  });
}
