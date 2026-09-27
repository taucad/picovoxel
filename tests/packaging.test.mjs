import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PACKAGE_FILES, validatePackageFiles } from '../scripts/package-files.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('npm package file contract', () => {
  it('accepts exactly the public package files', () => {
    assert.deepEqual(validatePackageFiles([...PACKAGE_FILES].reverse()), PACKAGE_FILES);
  });

  it('rejects missing, extra and source files', () => {
    assert.throws(() => validatePackageFiles(PACKAGE_FILES.filter((file) => file !== 'dist/pico-multi.wasm')), /missing=\[dist\/pico-multi\.wasm\]/u);
    assert.throws(() => validatePackageFiles([...PACKAGE_FILES, 'dist/accidental.txt']), /extra=\[dist\/accidental\.txt\]/u);
    assert.throws(() => validatePackageFiles([...PACKAGE_FILES, 'src/voxels.ts']), /forbidden=\[src\/voxels\.ts\]/u);
    assert.throws(() => validatePackageFiles([...PACKAGE_FILES, 'dist/index.js.map']), /forbidden=\[dist\/index\.js\.map\]/u);
  });

  it('agrees with package.json#files and every export target', () => {
    for (const entry of manifest.files) {
      assert.ok(PACKAGE_FILES.some((file) => file === entry || file.startsWith(`${entry}/`)), `files lists ${entry}`);
    }
    const targets = Object.values(manifest.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)));
    for (const target of targets) {
      assert.ok(PACKAGE_FILES.includes(target.replace(/^\.\//u, '')), `export target ${target} ships`);
    }
  });

  it('keeps the CommonJS diagnostic ahead of default on every runtime entry', () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target === 'string') continue;
      assert.deepEqual(Object.keys(target), ['types', 'import', 'require', 'default'], subpath);
      assert.equal(target.require, './dist/cjs-error.cjs', subpath);
      assert.equal(target.default, target.import, subpath);
    }
  });
});
