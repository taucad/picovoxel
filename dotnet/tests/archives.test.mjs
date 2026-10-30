import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, inventory } from '../validate-inputs.mjs';
import { verifyArchives } from '../verify-archives.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'picogk-archives-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pins = JSON.parse(readFileSync(new URL('../inputs.json', import.meta.url)));
  const directories = ['a', 'b'].map((name) => join(root, name));
  for (const path of directories) {
    mkdirSync(join(path, 'native'), { recursive: true });
    const receipt = {
      execution: 'serial',
      toolchain: pins,
      sources: { engine: { commit: 'same' } },
      files: {},
      flags: ['-O3'],
    };
    const inputs = JSON.stringify(receipt);
    writeFileSync(join(path, 'inputs.json'), inputs);
    writeFileSync(join(path, 'staged-source.json'), JSON.stringify({ source: digest('source') }));
    for (const name of [
      'float-trig.o',
      'libblosc.a',
      'libopenvdb.a',
      'libtbb.a',
      'libz.a',
      'picogk.26.2.a',
    ]) {
      writeFileSync(join(path, 'native', name), name);
      writeFileSync(
        join(path, `${name}.metadata.json`),
        JSON.stringify({
          schemaVersion: 1,
          execution: 'serial',
          emscripten: pins.emscripten,
          emscriptenRevision: pins.emscriptenRevision,
          runtime: pins.runtime,
          sha256: digest(name),
          inputsSha256: digest(inputs),
        }),
      );
    }
    writeFileSync(join(path, 'outputs.json'), JSON.stringify(inventory(join(path, 'native'))));
  }
  return directories;
}

test('clean-build comparison verifies actual bytes and full output set', (t) => {
  const paths = fixture(t);
  assert.equal(Object.keys(verifyArchives(...paths)).length, 6);
  writeFileSync(join(paths[1], 'native/libtbb.a'), 'changed');
  assert.throws(() => verifyArchives(...paths), /bytes changed/);
});

test('a missing archive and a falsely relabeled threaded artifact are rejected', (t) => {
  const paths = fixture(t);
  const metadata = join(paths[1], 'libtbb.a.metadata.json');
  const original = readFileSync(metadata);
  writeFileSync(metadata, JSON.stringify({ ...JSON.parse(original), execution: 'threaded' }));
  assert.throws(() => verifyArchives(...paths), /execution/);
  writeFileSync(metadata, original);
  rmSync(join(paths[1], 'native/libtbb.a'));
  assert.throws(() => verifyArchives(...paths), /output set/);
});

test('matching archives from different staged source do not prove reproducibility', (t) => {
  const paths = fixture(t);
  writeFileSync(join(paths[1], 'staged-source.json'), JSON.stringify({ source: digest('changed') }));
  assert.throws(() => verifyArchives(...paths), /staged-source/);
});
