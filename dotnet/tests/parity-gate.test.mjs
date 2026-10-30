import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareParity } from './parity/compare.mjs';

test('identically regressed outputs fail the historical gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'picogk-parity-'));
  try {
    const directories = {};
    for (const mode of ['native', 'aot', 'dynamic']) {
      const directory = join(root, mode);
      mkdirSync(directory);
      directories[mode] = directory;
      // Empty but structurally valid output must not impersonate the pinned subject.
      for (const capture of [0, 1]) {
        writeFileSync(join(directory, `capture-${capture}.mesh`), Buffer.alloc(8));
        writeFileSync(join(directory, `capture-${capture}.stl`), Buffer.alloc(84));
      }
    }
    const result = compareParity('gyroid', directories);
    assert.equal(result.passed, false);
    assert.equal(result.captures[0].historical.passed, false);
    assert.equal(
      result.captures[0].comparisons.every((row) => row.mesh.identical && row.stl.identical),
      true,
    );
    assert.throws(() => compareParity('unrecognized', directories), /Expected gyroid or heatx/);
    rmSync(join(directories.dynamic, 'capture-0.mesh'));
    assert.throws(() => compareParity('gyroid', directories), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every named mode is judged, so a threaded app is not a mode the gate cannot see', () => {
  const root = mkdtempSync(join(tmpdir(), 'picogk-parity-modes-'));
  try {
    const directories = {};
    for (const mode of ['native', 'aot', 'dynamic', 'aot-threaded', 'dynamic-threaded']) {
      const directory = join(root, mode);
      mkdirSync(directory);
      directories[mode] = directory;
      for (const capture of [0, 1]) {
        writeFileSync(join(directory, `capture-${capture}.mesh`), Buffer.alloc(8));
        writeFileSync(join(directory, `capture-${capture}.stl`), Buffer.alloc(84));
      }
    }
    const result = compareParity('gyroid', directories);
    // Named, sorted and all four compared: the report says which modes carried the verdict.
    assert.deepEqual(result.modes, ['aot', 'aot-threaded', 'dynamic', 'dynamic-threaded']);
    assert.deepEqual(
      result.captures[0].comparisons.map((row) => row.mode),
      ['aot', 'aot-threaded', 'dynamic', 'dynamic-threaded'],
    );
    // One mode's bytes differing fails the gate, which is what judging it rather than naming it means.
    // A different header over the same zero triangle count: structurally valid, not the same bytes.
    writeFileSync(
      join(directories['dynamic-threaded'], 'capture-0.stl'),
      Buffer.concat([Buffer.alloc(80, 7), Buffer.alloc(4)]),
    );
    assert.equal(
      compareParity('gyroid', directories).captures[0].comparisons.find(
        (row) => row.mode === 'dynamic-threaded',
      ).stl.identical,
      false,
    );
    assert.throws(
      () => compareParity('gyroid', { native: directories.native }),
      /at least one mode beside the native fixture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
