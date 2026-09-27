// ABI completeness: the four places an export is named must agree, so adding
// one anywhere fails here until every other place follows.
//   - the pinned, patched upstream header (vendor/PicoGKRuntime/API/PicoGK.h,
//     fetched by scripts/fetch-deps.sh; CI ships it with the serial wasm);
//   - src/abi.json, the manifest scripts/parse-abi.mjs derives from that header;
//   - the `PICOGK_API` definitions in this repo's own translation units
//     (src/pico-*.cpp) and BULK_FUNCTIONS, their hand-written binding table;
//   - src/pico-exports.txt, the EXPORTED_FUNCTIONS list the link uses.
// test/oracle-map.test.ts adds the fifth: an oracle-bearing test per own export.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { BULK_FUNCTIONS } from '../scripts/generate-raw.mjs';
import { parseAbi, parseOwnExports } from '../scripts/parse-abi.mjs';
import abi from '../src/abi.json' with { type: 'json' };

const ROOT = join(import.meta.dirname, '..');
const HEADER = join(ROOT, 'vendor', 'PicoGKRuntime', 'API', 'PicoGK.h');

interface AbiFunction {
  name: string;
  viewer?: boolean;
  cwrapReturn: string | null;
  args: { type: string; name: string; cwrap: string | null }[];
}

/** Every `PICOGK_API` this repo defines, with the translation unit it lives in. */
const ownExports = readdirSync(join(ROOT, 'src'))
  .filter((file) => /^pico-[a-z-]+\.cpp$/u.test(file))
  .sort()
  .flatMap((file) =>
    (parseOwnExports(readFileSync(join(ROOT, 'src', file), 'utf8')) as AbiFunction[]).map((fn) => ({
      ...fn,
      file,
    })),
  );

const coreNames = (abi.functions as AbiFunction[]).filter((fn) => !fn.viewer).map((fn) => fn.name);

test('src/abi.json is parse-abi over the pinned header, byte for byte in content', async () => {
  assert.ok(
    existsSync(HEADER),
    `${HEADER} is missing: run scripts/fetch-deps.sh (CI ships it with wasm-serial)`,
  );
  assert.deepEqual(
    await parseAbi(HEADER),
    abi,
    'src/abi.json drifted from the pinned header: node scripts/parse-abi.mjs > src/abi.json',
  );
});

test('BULK_FUNCTIONS binds exactly the own translation units’ exports, signature by signature', () => {
  assert.ok(ownExports.length > 0, 'no PICOGK_API definitions found under src/');
  const bound = new Map((BULK_FUNCTIONS as AbiFunction[]).map((fn) => [fn.name, fn]));
  const defined = new Map(ownExports.map((fn) => [fn.name, fn]));
  assert.equal(defined.size, ownExports.length, 'an own export is defined twice');
  assert.deepEqual(
    [...bound.keys()].sort(),
    [...defined.keys()].sort(),
    'BULK_FUNCTIONS (scripts/generate-raw.mjs) and the PICOGK_API definitions in src/pico-*.cpp differ',
  );
  const bare = (type: string) => type.replace(/\bconst\b/gu, '').replace(/\s+/gu, '');
  for (const [name, source] of defined) {
    const binding = bound.get(name)!;
    const where = `${name} (${source.file})`;
    assert.equal(binding.cwrapReturn, source.cwrapReturn, `${where}: return crosses differently`);
    assert.deepEqual(
      binding.args.map((arg) => [bare(arg.type), arg.cwrap]),
      source.args.map((arg) => [bare(arg.type), arg.cwrap]),
      `${where}: parameter types differ`,
    );
  }
  assert.deepEqual(
    [...defined.keys()].filter((name) => coreNames.includes(name)),
    [],
    'an own export shadows an upstream one',
  );
});

test('src/pico-exports.txt is every core and own export plus _malloc and _free, once each', () => {
  const listed = readFileSync(join(ROOT, 'src', 'pico-exports.txt'), 'utf8')
    .split('\n')
    .filter(Boolean);
  assert.equal(new Set(listed).size, listed.length, 'src/pico-exports.txt names an export twice');
  const expected = [
    '_malloc',
    '_free',
    ...[...coreNames, ...ownExports.map((fn) => fn.name)].map((name) => `_${name}`),
  ];
  assert.deepEqual(
    [...listed].sort(),
    expected.sort(),
    'src/pico-exports.txt must equal the manifest core set + the own translation units + _malloc/_free',
  );
});
