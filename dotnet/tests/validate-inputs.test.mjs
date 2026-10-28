import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture, inventory, sourceIdentity, verify } from '../validate-inputs.mjs';

/** Isolate each test's source tree and remove it even when an assertion fails. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'picogk-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/engine.cpp'), 'original\n');
  git('add', 'src');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  return { root, git, pin: { commit: git('rev-parse', 'HEAD'), paths: ['src'] } };
}

test('pinned source bytes remain valid across unrelated build-script commits', (t) => {
  const { root, git, pin } = fixture(t);
  const before = sourceIdentity(root, pin);
  writeFileSync(join(root, 'README.md'), 'unrelated\n');
  git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'other');
  assert.deepEqual(sourceIdentity(root, pin), before);
});

test('changed bytes fail even when Git assumes the source is unchanged', (t) => {
  const { root, git, pin } = fixture(t);
  git('update-index', '--assume-unchanged', 'src/engine.cpp');
  writeFileSync(join(root, 'src/engine.cpp'), 'modified\n');
  assert.throws(() => sourceIdentity(root, pin), /Dirty source src\/engine.cpp/);
});

test('additional and missing source files fail admission', (t) => {
  const { root, pin } = fixture(t);
  writeFileSync(join(root, 'src/extra.cpp'), 'extra');
  assert.throws(() => sourceIdentity(root, pin), /Untracked source inputs/);
  rmSync(join(root, 'src/extra.cpp'));
  rmSync(join(root, 'src/engine.cpp'));
  assert.throws(() => sourceIdentity(root, pin), /ENOENT/);
});

test('binary mutation, file addition and comparator changes invalidate receipts', (t) => {
  const { root } = fixture(t);
  const path = join(root, 'src');
  const original = { comparator: 'picovoxel-browser', files: inventory(path) };
  verify(original, structuredClone(original));
  writeFileSync(join(path, 'engine.cpp'), 'changed\n');
  assert.throws(
    () => verify({ ...original, files: inventory(path) }, original),
    /Build input receipt.*files\/engine.cpp/,
  );
  assert.throws(() => verify({ ...original, comparator: 'leap-shipped' }, original), /Build input receipt/);
  writeFileSync(join(path, 'new.a'), 'archive');
  assert.throws(() => verify({ ...original, files: inventory(path) }, original), /Build input receipt/);
});

test('symlinks and empty trees cannot conceal input bytes', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'empty'));
  assert.throws(() => inventory(join(root, 'empty')), /Empty input/);
  symlinkSync(join(root, 'src/engine.cpp'), join(root, 'empty/link'));
  assert.throws(() => inventory(join(root, 'empty')), /Input symlink/);
});

test('comparator, RID, execution mode and binary inputs are required', () => {
  assert.throws(() => capture({ purpose: 'inputs' }), /explicit comparator/);
  assert.throws(() => capture({ purpose: 'inputs', comparator: 'leap-shipped' }), /explicit native RID/);
  assert.throws(
    () => capture({ purpose: 'inputs', comparator: 'leap-shipped', nativeRid: 'osx-arm64' }),
    /Execution/,
  );
  assert.throws(
    () =>
      capture({ purpose: 'inputs', comparator: 'leap-shipped', nativeRid: 'osx-arm64', execution: 'serial' }),
    /binary/,
  );
});

test('SDK internal file links are hashed, but external links remain rejected', (t) => {
  const { root } = fixture(t);
  const src = join(root, 'src');
  symlinkSync('engine.cpp', join(src, 'internal'));
  const before = inventory(src, true);
  assert.equal(before.internal.sha256, before['engine.cpp']);
  writeFileSync(join(src, 'engine.cpp'), 'changed');
  assert.notDeepEqual(inventory(src, true), before);
  writeFileSync(join(root, 'outside'), 'outside');
  symlinkSync('../outside', join(src, 'external'));
  assert.throws(() => inventory(src, true), /Input symlink/);
});

test('an archive labeled with the workload package version fails actual compiler admission', async (t) => {
  const { artifactIdentity, digest } = await import('../validate-inputs.mjs');
  const { root } = fixture(t);
  const path = join(root, 'engine.a');
  const metadata = join(root, 'engine.json');
  const inputs = join(root, 'inputs.json');
  writeFileSync(path, 'archive');
  const sources = { engine: { commit: 'pinned', files: { 'engine.cpp': digest('source') } } };
  const receipt = JSON.stringify({
    toolchain: { sdk: '11.0.100-rc.3.26522.148', runtime: '11.0.0-rc.3.26522.148', emscripten: '6.0.3' },
    execution: 'serial',
    sources,
    files: {},
    flags: [],
  });
  writeFileSync(inputs, receipt);
  const correct = {
    schemaVersion: 1,
    execution: 'serial',
    emscripten: '6.0.3',
    emscriptenRevision: '6ea9c28c38cdd40c1032fa04400c9d16230ee180',
    runtime: '11.0.0-rc.3.26522.148',
    sha256: digest('archive'),
    inputsSha256: digest(receipt),
  };
  writeFileSync(metadata, JSON.stringify({ ...correct, emscripten: '6.0.2' }));
  assert.throws(
    () => artifactIdentity({ path, metadata, inputs }, 'serial', sources, {}, []),
    /Artifact emcc: expected 6.0.3, found 6.0.2/,
  );
  writeFileSync(metadata, JSON.stringify(correct));
  assert.equal(
    artifactIdentity({ path, metadata, inputs }, 'serial', sources, {}, []).sha256,
    correct.sha256,
  );
  assert.throws(
    () => artifactIdentity({ path, metadata, inputs }, 'threaded', sources, {}, []),
    /Artifact execution/,
  );
  assert.throws(
    () => artifactIdentity({ path, metadata, inputs }, 'serial', sources, { overlay: 'different' }, []),
    /Artifact staged inputs/,
  );
  assert.throws(
    () => artifactIdentity({ path, metadata, inputs }, 'serial', sources, {}, ['-ffast-math']),
    /Artifact build flags/,
  );
  writeFileSync(path, 'corrupt');
  assert.throws(
    () => artifactIdentity({ path, metadata, inputs }, 'serial', sources, {}, []),
    /Artifact bytes/,
  );
});

test('browser linking cannot omit archive provenance', () => {
  assert.throws(
    () => capture({ purpose: 'link', comparator: 'picovoxel-browser' }),
    /producer-attested archives/,
  );
});

test('runtime pack admission follows SDK precedence and admits restored threaded packs', async (t) => {
  const { resolveRuntimePack } = await import('../validate-inputs.mjs');
  const { root } = fixture(t);
  const sdk = join(root, 'sdk-pack');
  const nuget = join(root, 'nuget-pack');
  assert.throws(() => resolveRuntimePack(sdk, nuget), /ENOENT/);
  mkdirSync(nuget);
  assert.equal(resolveRuntimePack(sdk, nuget), realpathSync(nuget));
  mkdirSync(sdk);
  assert.equal(resolveRuntimePack(sdk, nuget), realpathSync(sdk));
});

test('Emscripten isolated Python cannot add bytecode to compiler inputs', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'module.py'), 'value = 42\n');
  writeFileSync(join(root, 'entry.py'), 'import module; assert module.value == 42\n');
  const before = inventory(root);
  const wrapper = new URL('../python-no-bytecode.sh', import.meta.url);
  execFileSync('sh', [fileURLToPath(wrapper), '-E', join(root, 'entry.py')]);
  assert.deepEqual(inventory(root), before);
});
