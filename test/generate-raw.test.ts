// R9 — generator unit tests: the manifest count, viewer exclusion, the upstream
// header typos matched verbatim, array-decay arg names, and byte-stable output.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
// eslint-disable-next-line import/no-relative-packages — dev script under test
import { BULK_FUNCTIONS, generateRawSource } from '../scripts/generate-raw.mjs';
import abi from '../src/abi.json' with { type: 'json' };

const source = generateRawSource(abi);

test('manifest count: 140 core + 5 own-TU bindings, viewer surface excluded', () => {
  assert.equal(abi.functions.filter((f: { viewer: boolean }) => !f.viewer).length, 140);
  assert.equal(BULK_FUNCTIONS.length, 5);
  const bound = source.match(/^ {2}\['[A-Za-z0-9_]+',/gm) ?? [];
  assert.equal(bound.length, 145, 'signature table must carry every binding');
  assert.ok(!/Viewer_|Gui_/.test(source), 'viewer exports must never be bound');
});

test('upstream typos are matched, not fixed', () => {
  assert.match(source, /MetaData_RemoveValue\(/, 'capital-D MetaData_RemoveValue must bind by its real name');
  assert.ok(!source.includes('Metadata_RemoveValue('), 'a "fixed" lowercase name would fail to bind at runtime');
  // ScalarField_RemoveValue's handle arg is typed PKVECTORFIELD in the header —
  // all handles are uint64_t, so it still types as a handle here.
  assert.match(source, /ScalarField_RemoveValue\(hInstance: PicoGkHandle, hThis: PicoGkHandle/);
});

test('char[255] params decay to pointer numbers with their real names', () => {
  assert.match(source, /Library_GetName\(psz: number\): void/);
});

test('callback params cross as fn-table numbers', () => {
  assert.match(source, /Voxels_RenderImplicit\(hInstance: PicoGkHandle, hThis: PicoGkHandle, poBBox: number, pfnSDF: number\): void/);
});

test('handles are branded; counters stay plain bigint', () => {
  assert.match(source, /Library_hCreateInstance\(fVoxelSizeMM: number\): PicoGkHandle/);
  assert.match(source, /Library_nTotalMemUsage\(hThis: PicoGkHandle\): bigint/);
});

test('regeneration is byte-stable against the checked-in file', async () => {
  const onDisk = await readFile(new URL('../src/raw.generated.ts', import.meta.url), 'utf8');
  assert.equal(onDisk, source, 'src/raw.generated.ts drifted from its generator — re-run scripts/generate-raw.mjs');
});

test('a wrong core count halts generation loudly', () => {
  const truncated = { functions: abi.functions.slice(0, 50) };
  assert.throws(() => generateRawSource(truncated), /expected 140 core exports/);
});
