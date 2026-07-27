// R9 — generator unit tests: the manifest count, viewer exclusion, the upstream
// header typos matched verbatim, array-decay arg names, and byte-stable output.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
// eslint-disable-next-line import/no-relative-packages — dev script under test
import { BULK_FUNCTIONS, generateRawSource } from '../scripts/generate-raw.mjs';
import abi from '../src/abi.json' with { type: 'json' };

const source = generateRawSource(abi);

test('manifest count: 140 core + 17 own-TU bindings, viewer surface excluded', () => {
  assert.equal(abi.functions.filter((f: { viewer: boolean }) => !f.viewer).length, 140);
  // 4 bulk-mesh + 3 tape entries (fresh fill + the two R9 compose variants)
  // + 2 SK-0.3 bulk lattice entries + SK-0.5's Voxels_GetProperties
  // + SK-0.8's Voxels_OffsetTuned + SK-0.4's Voxels_RenderLatticeTubes
  // + SKv2-0 V0.1's Voxels_GetGridHash and Voxels_DensifyInterior
  // + SKv2-0 V0.7's three shared-nothing csg*Copy booleans.
  assert.equal(BULK_FUNCTIONS.length, 17);
  const bound = source.match(/^ {2}'[A-Za-z0-9_]+',$/gm) ?? [];
  assert.equal(bound.length, 157, 'the export list must carry every binding');
  assert.ok(!/Viewer_|Gui_/.test(source), 'viewer exports must never be bound');
});

// SK-0.2 — the whole point of the layer: every binding is a direct wasm export.
// cwrap silently demotes any handle-taking export (143 of 147) to ccall, which
// re-resolves by string key and marshals arguments on every single call.
test('no binding goes through ccall/cwrap', () => {
  // A call, not a mention — the header comment explains why cwrap is gone.
  assert.ok(!/\bc(?:call|wrap)\(/.test(source), 'generated bindings must never route through ccall/cwrap');
  assert.match(source, /const fn = exports\[`_\$\{name}`];/, 'bindings must resolve as module._Name');
});

test('boolean returns keep the i32 -> boolean coercion wasm cannot do', () => {
  // Arity-matched wrappers only — a rest/spread wrapper would allocate per call.
  assert.match(source, /Voxels_bIsEmpty: \(fn\) => \(a0, a1\) => !!fn\(a0, a1\),/);
  const wrappers = source.match(/^ {2}[A-Za-z0-9_]+: \(fn\) => /gm) ?? [];
  assert.equal(wrappers.length, 20, 'every boolean-returning export needs the !! wrap, and nothing else does');
  assert.ok(!/=> !!fn\(\.\.\./.test(source), 'boolean wrappers must not spread');
});

test('upstream typos are matched, not fixed', () => {
  assert.match(source, /MetaData_RemoveValue\(/, 'capital-D MetaData_RemoveValue must bind by its real name');
  assert.ok(!source.includes('Metadata_RemoveValue('), 'a "fixed" lowercase name would fail to bind at runtime');
  // ScalarField_RemoveValue's handle arg is typed PKVECTORFIELD in the header —
  // all handles are uint64_t, so it still types as a handle here.
  assert.match(source, /ScalarField_RemoveValue\(hInstance: PicoHandle, hThis: PicoHandle/);
});

test('char[255] params decay to pointer numbers with their real names', () => {
  assert.match(source, /Library_GetName\(psz: number\): void/);
});

test('callback params cross as fn-table numbers', () => {
  assert.match(source, /Voxels_RenderImplicit\(hInstance: PicoHandle, hThis: PicoHandle, poBBox: number, pfnSDF: number\): void/);
});

test('handles are branded; counters stay plain bigint', () => {
  assert.match(source, /Library_hCreateInstance\(fVoxelSizeMM: number\): PicoHandle/);
  assert.match(source, /Library_nTotalMemUsage\(hThis: PicoHandle\): bigint/);
});

test('regeneration is byte-stable against the checked-in file', async () => {
  const onDisk = await readFile(new URL('../src/raw.generated.ts', import.meta.url), 'utf8');
  assert.equal(onDisk, source, 'src/raw.generated.ts drifted from its generator — re-run scripts/generate-raw.mjs');
});

test('a wrong core count halts generation loudly', () => {
  const truncated = { functions: abi.functions.slice(0, 50) };
  assert.throws(() => generateRawSource(truncated), /expected 140 core exports/);
});
