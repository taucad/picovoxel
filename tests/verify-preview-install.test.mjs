import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { verifyPreviewInstall } from '../scripts/verify-preview-install.mjs';

const written = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-preview-'));
  written.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of written.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** The `npm pack --json` output for a pkg.pr.new URL, at the version `versionOf` returns. */
const packed = (url, versionOf) => {
  const name = url.slice('https://pkg.pr.new/'.length, url.lastIndexOf('@'));
  return `${JSON.stringify([{ name, version: versionOf(name) }])}\n`;
};

describe('hosted preview consumer', () => {
  it('should install only roots and verify rewritten sibling previews', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc12';
    const source = temporaryDirectory();
    const root = join(source, '00');
    const native = join(source, '01');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    mkdirSync(native);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'example', optionalDependencies: { 'example-linux': '1.0.0' } })}\n`,
    );
    writeFileSync(join(native, 'package.json'), `${JSON.stringify({ name: 'example-linux' })}\n`);
    writeFileSync(
      metadata,
      `${JSON.stringify({
        packages: [
          { name: 'example', url: `https://pkg.pr.new/example@${sha}` },
          { name: 'example-linux', url: `https://pkg.pr.new/example-linux@${sha}` },
        ],
      })}\n`,
    );

    const calls = [];
    const result = verifyPreviewInstall({
      from: source,
      metadata,
      sha,
      install(command, args, options) {
        calls.push([command, args]);
        if (args[0] === 'pack') return packed(args[1], () => '0.0.0-preview-abc1234');
        if (args[0] !== 'install') return;
        const modules = join(options.cwd, 'node_modules');
        mkdirSync(join(modules, 'example'), { recursive: true });
        mkdirSync(join(modules, 'example-linux'), { recursive: true });
        writeFileSync(
          join(modules, 'example', 'package.json'),
          `${JSON.stringify({ name: 'example', version: '0.0.0-preview-abc1234', optionalDependencies: { 'example-linux': `https://pkg.pr.new/example-linux@${sha}` } })}\n`,
        );
        writeFileSync(
          join(modules, 'example-linux', 'package.json'),
          `${JSON.stringify({ name: 'example-linux', version: '0.0.0-preview-abc1234' })}\n`,
        );
      },
    });

    assert.deepEqual(result, { installed: 2, published: 2, roots: ['example'] });
    assert.deepEqual(calls[1][1], ['install', '--ignore-scripts', `https://pkg.pr.new/example@${sha}`]);
    assert.deepEqual(
      calls.filter(([, args]) => args[0] === 'pack').map(([, args]) => args[1]),
      [`https://pkg.pr.new/example@${sha}`, `https://pkg.pr.new/example-linux@${sha}`],
    );
  });

  // A native package this runner cannot install is invisible to the root
  // install, so only the published-manifest audit catches one left unrewritten.
  it('should reject a published sibling the platform filter hid from the install', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc12';
    const source = temporaryDirectory();
    const root = join(source, '00');
    const native = join(source, '01');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    mkdirSync(native);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'example', optionalDependencies: { 'example-s390x': '1.0.0' } })}\n`,
    );
    writeFileSync(join(native, 'package.json'), `${JSON.stringify({ name: 'example-s390x' })}\n`);
    writeFileSync(
      metadata,
      `${JSON.stringify({
        packages: [
          { name: 'example', url: `https://pkg.pr.new/example@${sha}` },
          { name: 'example-s390x', url: `https://pkg.pr.new/example-s390x@${sha}` },
        ],
      })}\n`,
    );

    assert.throws(
      () =>
        verifyPreviewInstall({
          from: source,
          metadata,
          sha,
          install(command, args, options) {
            if (args[0] === 'pack') {
              return packed(args[1], (name) => (name === 'example' ? '0.0.0-preview-abc1234' : '1.0.0'));
            }
            if (args[0] !== 'install') return;
            const modules = join(options.cwd, 'node_modules');
            mkdirSync(join(modules, 'example'), { recursive: true });
            writeFileSync(
              join(modules, 'example', 'package.json'),
              `${JSON.stringify({ name: 'example', version: '0.0.0-preview-abc1234', optionalDependencies: { 'example-s390x': `https://pkg.pr.new/example-s390x@${sha}` } })}\n`,
            );
          },
        }),
      /example-s390x published 1\.0\.0, expected 0\.0\.0-preview-abc1234/u,
    );
  });

  // picovoxel has no npm placeholder yet, so pkg.pr.new serves the long
  // owner/repo form keyed by the full SHA; the version keeps the short SHA.
  it('should verify a single package served under the long repository URL', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc12';
    const url = `https://pkg.pr.new/taucad/picovoxel/picovoxel@${sha}`;
    const source = temporaryDirectory();
    const metadata = join(source, 'preview.json');
    mkdirSync(join(source, '00'));
    writeFileSync(join(source, '00', 'package.json'), `${JSON.stringify({ name: 'picovoxel' })}\n`);
    writeFileSync(metadata, `${JSON.stringify({ packages: [{ name: 'picovoxel', url }] })}\n`);

    const calls = [];
    const result = verifyPreviewInstall({
      from: source,
      metadata,
      sha,
      install(command, args, options) {
        calls.push(args);
        if (args[0] === 'pack')
          return `${JSON.stringify([{ name: 'picovoxel', version: '0.0.0-preview-abc1234' }])}\n`;
        if (args[0] !== 'install') return;
        mkdirSync(join(options.cwd, 'node_modules', 'picovoxel'), { recursive: true });
        writeFileSync(
          join(options.cwd, 'node_modules', 'picovoxel', 'package.json'),
          `${JSON.stringify({ name: 'picovoxel', version: '0.0.0-preview-abc1234' })}\n`,
        );
      },
    });

    assert.deepEqual(result, { installed: 1, published: 1, roots: ['picovoxel'] });
    assert.deepEqual(calls[1], ['install', '--ignore-scripts', url]);
    assert.deepEqual(calls[2].slice(0, 2), ['pack', url]);
  });

  it('should reject untrusted or stale metadata before invoking npm', () => {
    const source = temporaryDirectory();
    const root = join(source, '00');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'example' }) + '\n');

    for (const url of ['https://example.com/example@abc1234', 'https://pkg.pr.new/example@stale00']) {
      writeFileSync(metadata, JSON.stringify({ packages: [{ name: 'example', url }] }) + '\n');
      let installs = 0;
      assert.throws(
        () =>
          verifyPreviewInstall({
            from: source,
            metadata,
            sha: 'abc1234',
            install: () => {
              installs += 1;
            },
          }),
        /untrusted or stale/u,
      );
      assert.equal(installs, 0);
    }
  });
});
