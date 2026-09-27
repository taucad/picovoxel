import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseAffectingPaths } from '../../scripts/plan-check.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const nxJson = JSON.parse(readFileSync(join(root, 'nx.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ignorePatterns = nxJson.release.versionPlans.ignorePatternsForPlanCheck;

const affected = (changedFiles, headManifest = manifest) =>
  releaseAffectingPaths({
    changedFiles,
    baseManifest: manifest,
    headManifest,
    ignorePatterns,
    packageFiles: headManifest.files,
  });

describe('Version Plan requirement', () => {
  it('needs no plan for a grouped devDependency update', () => {
    const bumped = {
      ...manifest,
      devDependencies: { ...manifest.devDependencies, vitest: '9.9.9' },
      packageManager: 'pnpm@99.0.0',
    };
    assert.deepEqual(affected(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], bumped), []);
  });

  it('needs a plan when a shipped manifest field changes', () => {
    for (const change of [
      { dependencies: { leftpad: '1.0.0' } },
      { peerDependencies: { three: '>=0.170' } },
      { exports: { '.': './dist/index.js' } },
      { engines: { node: '>=24' } },
      { files: [...manifest.files, 'extra'] },
    ]) {
      assert.deepEqual(affected(['package.json'], { ...manifest, ...change }), ['package.json']);
    }
  });

  it('needs no plan for CI, tests, tooling or docs outside the tarball', () => {
    assert.deepEqual(
      affected([
        '.github/workflows/ci.yml',
        '.github/actions/setup/action.yml',
        'tests/ci/plan-check.test.mjs',
        'test/mesh.test.ts',
        'scripts/ci-release.mjs',
        'scripts/plan-check.mjs',
        'eslint.config.mjs',
        'tools/eslint-plugin/index.js',
        '.vale/styles/Tau/NoEmojiBody.yml',
        'MAINTAINER.md',
        'CONTRIBUTING.md',
        'docs/lanes.md',
        'bench/BENCHMARKS.md',
        '.nx/version-plans/next.md',
      ]),
      [],
    );
  });

  it('needs a plan for the sources dist/ is built from and for shipped documents', () => {
    const shipped = [
      'src/mesh.ts',
      'src/pico.cpp',
      'patches/openvdb/0001.patch',
      'scripts/build-pico-module.sh',
      'scripts/fetch-deps.sh',
      'tsdown.config.ts',
      'README.md',
      'compatibility.md',
      'MIGRATING-FROM-CSHARP.md',
      'NOTICE',
      'license',
    ];
    assert.deepEqual(affected(shipped), shipped);
    assert.deepEqual(affected(['pnpm-lock.yaml', 'src/mesh.ts']), ['src/mesh.ts']);
  });

  it('decides from the git range and defers to nx only when a plan is needed', () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'picovoxel-plan-check-')));
    const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: 'pipe' });
    try {
      git('init', '--quiet', '--initial-branch=main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      mkdirSync(join(work, 'scripts'));
      writeFileSync(join(work, 'scripts/plan-check.mjs'), readFileSync(join(root, 'scripts/plan-check.mjs')));
      writeFileSync(join(work, 'nx.json'), JSON.stringify(nxJson));
      writeFileSync(join(work, 'package.json'), JSON.stringify(manifest));
      git('add', '--all');
      git('commit', '--quiet', '-m', 'base');
      const bumped = { ...manifest, devDependencies: { ...manifest.devDependencies, vitest: '9.9.9' } };
      writeFileSync(join(work, 'package.json'), JSON.stringify(bumped));
      writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      git('add', '--all');
      git('commit', '--quiet', '-m', 'bump');
      const output = execFileSync(
        process.execPath,
        ['scripts/plan-check.mjs', '--base', 'HEAD~1', '--head', 'HEAD'],
        {
          cwd: work,
          encoding: 'utf8',
        },
      );
      assert.equal(output, 'No change reaches the published package, so no Version Plan is required.\n');
      assert.throws(
        () =>
          execFileSync(process.execPath, ['scripts/plan-check.mjs', '--base', 'HEAD~1'], {
            cwd: work,
            stdio: 'pipe',
          }),
        (error) => error.status === 1 && /usage: plan-check\.mjs/u.test(String(error.stderr)),
      );
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
  });
});
