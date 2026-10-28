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
