import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { deriveRelease, RELEASE_FILES } from '../../scripts/ci-release.mjs';
import {
  RELEASE_GATE,
  validateRequestedVersion,
  versionFromPlans,
  withoutNonHumanAuthors,
  withTitleFirst,
} from '../../scripts/prepare-release.mjs';

const byText = (left, right) => left.localeCompare(right);
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const SHA = 'a'.repeat(40);
const manifestAt = (version) => ({
  name: 'picovoxel',
  version,
  files: ['dist', 'README.md'],
  exports: { '.': './dist/index.js' },
  peerDependencies: { three: '>=0.160' },
  devDependencies: { nx: '23.1.1' },
});
const stable = {
  event: 'push',
  ref: 'refs/heads/main',
  sha: SHA,
  packageVersion: '0.1.0',
  subject: 'chore(release): picovoxel v0.1.0',
  changedFiles: ['.nx/version-plans/picovoxel-first-release.md', 'CHANGELOG.md', 'package.json'],
  changelog: '# Changelog\n\n## 0.1.0 (2026-09-28)\n',
  deletedFiles: ['.nx/version-plans/picovoxel-first-release.md'],
  baseManifest: manifestAt('0.0.0'),
  manifest: manifestAt('0.1.0'),
  headRef: 'release/next',
  headRepository: 'taucad/picovoxel',
  repository: 'taucad/picovoxel',
};
const releasePullRequest = { ...stable, event: 'pull_request', ref: 'refs/pull/14/merge' };

describe('CI release policy', () => {
  it('publishes one release commit pushed to main', () => {
    assert.deepEqual(deriveRelease(stable), {
      kind: 'release',
      npmPublish: true,
      releaseTag: 'v0.1.0',
      version: '0.1.0',
    });
  });

  it('accepts the squash-merge suffix on the release subject', () => {
    assert.equal(
      deriveRelease({ ...stable, subject: 'chore(release): picovoxel v0.1.0 (#14)' }).kind,
      'release',
    );
  });

  it('validates but never publishes a release pull request', () => {
    assert.deepEqual(deriveRelease({ ...stable, event: 'pull_request', ref: 'refs/pull/14/merge' }), {
      kind: 'release-pull-request',
      npmPublish: false,
      version: '0.1.0',
    });
  });

  it('rejects a malformed release pull request before it can merge', () => {
    assert.throws(
      () =>
        deriveRelease({
          ...stable,
          event: 'pull_request',
          ref: 'refs/pull/14/merge',
          changedFiles: [...stable.changedFiles, 'src/index.ts'],
        }),
      /unexpected files: src\/index\.ts/u,
    );
  });

  it('never publishes an ordinary pull request', () => {
    assert.deepEqual(
      deriveRelease({
        ...stable,
        event: 'pull_request',
        ref: 'refs/pull/13/merge',
        packageVersion: '0.0.0',
        subject: 'ci(release): add the release machinery',
        changedFiles: ['scripts/ci-release.mjs'],
      }),
      { kind: 'pull-request', npmPublish: false, version: '0.0.0' },
    );
  });

  it('does not publish an ordinary main commit', () => {
    assert.deepEqual(
      deriveRelease({ ...stable, subject: 'fix(mesh): ordinary change', changedFiles: ['src/mesh.ts'] }),
      { kind: 'main', npmPublish: false, version: '0.1.0' },
    );
  });

  it('rejects a release commit that leaves a release file unchanged', () => {
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: ['.nx/version-plans/first.md', 'package.json'] }),
      /release commit must change CHANGELOG\.md/u,
    );
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: ['.nx/version-plans/first.md', 'CHANGELOG.md'] }),
      /release commit must change package\.json/u,
    );
  });

  it('rejects a release commit that consumes no Version Plan', () => {
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: ['CHANGELOG.md', 'package.json'] }),
      /must consume a Version Plan/u,
    );
  });

  it('rejects a release commit that carries source, wasm or lockfile changes', () => {
    for (const file of ['src/index.ts', 'src/pico.wasm', '.github/workflows/ci.yml', 'pnpm-lock.yaml']) {
      assert.throws(
        () => deriveRelease({ ...stable, changedFiles: [...stable.changedFiles, file] }),
        new RegExp(`unexpected files: ${file.replaceAll('.', '\\.')}`, 'u'),
      );
    }
  });

  it('rejects a release from anything but main', () => {
    assert.throws(() => deriveRelease({ ...stable, ref: 'refs/heads/release/next' }), /protected main/u);
    assert.throws(() => deriveRelease({ ...stable, ref: 'refs/tags/v0.1.0' }), /protected main/u);
    assert.throws(
      () => deriveRelease({ ...stable, ref: 'refs/heads/topic', subject: 'fix: ordinary change' }),
      /protected main/u,
    );
  });

  it('runs a manual dispatch as evidence only, even for a release commit on main', () => {
    assert.deepEqual(deriveRelease({ ...stable, event: 'workflow_dispatch' }), {
      kind: 'dispatch',
      npmPublish: false,
      version: '0.1.0',
    });
    assert.deepEqual(
      deriveRelease({ ...stable, event: 'workflow_dispatch', ref: 'refs/heads/topic', subject: 'fix: x' }),
      { kind: 'dispatch', npmPublish: false, version: '0.1.0' },
    );
  });

  it('rejects every other event', () => {
    for (const event of ['pull_request_target', 'workflow_run', 'schedule', 'release', undefined]) {
      assert.throws(() => deriveRelease({ ...stable, event }), /unsupported event/u);
    }
  });

  it('rejects a malformed release subject on main', () => {
    assert.throws(
      () => deriveRelease({ ...stable, subject: 'chore(release): picovoxel v' }),
      /malformed release subject/u,
    );
    assert.throws(
      () => deriveRelease({ ...stable, subject: 'chore(release): picovoxel v0.1.0 and more' }),
      /does not match 0\.1\.0/u,
    );
  });

  it('never treats another package subject as a release', () => {
    assert.equal(
      deriveRelease({ ...stable, subject: 'chore(release): nanoraster v0.1.0' }).npmPublish,
      false,
    );
  });

  it('rejects a release subject that disagrees with the package version', () => {
    assert.throws(
      () => deriveRelease({ ...stable, subject: 'chore(release): picovoxel v0.2.0' }),
      /does not match 0\.1\.0/u,
    );
  });

  it('rejects a prerelease or malformed version', () => {
    assert.throws(
      () =>
        deriveRelease({
          ...stable,
          packageVersion: '0.1.0-rc.1',
          subject: 'chore(release): picovoxel v0.1.0-rc.1',
        }),
      /not stable SemVer/u,
    );
    assert.throws(() => deriveRelease({ ...stable, packageVersion: '01.0.0' }), /not stable SemVer/u);
  });

  it('rejects an abbreviated or uppercase commit SHA', () => {
    assert.throws(() => deriveRelease({ ...stable, sha: 'abc1234' }), /40 lowercase/u);
    assert.throws(() => deriveRelease({ ...stable, sha: 'A'.repeat(40) }), /40 lowercase/u);
  });

  it('rejects a release whose changelog has no section for the version', () => {
    assert.throws(() => deriveRelease({ ...stable, changelog: '## 0.0.9\n' }), /no 0\.1\.0 section/u);
    assert.throws(() => deriveRelease({ ...stable, changelog: '## 0.1.00\n' }), /no 0\.1\.0 section/u);
  });
});

describe('release commit contents', () => {
  it('accepts a manifest whose only change is the version, moved forward', () => {
    assert.equal(deriveRelease(stable).npmPublish, true);
    assert.equal(deriveRelease(releasePullRequest).kind, 'release-pull-request');
  });

  it('rejects any other manifest change, in a push or a pull request', () => {
    const changes = {
      dependencies: { ...manifestAt('0.1.0'), dependencies: { leftpad: '1.0.0' } },
      exports: { ...manifestAt('0.1.0'), exports: { '.': './dist/other.js' } },
      peerDependencies: { ...manifestAt('0.1.0'), peerDependencies: { three: '*' } },
      devDependencies: { ...manifestAt('0.1.0'), devDependencies: { nx: '23.1.2' } },
      bin: { ...manifestAt('0.1.0'), bin: { picovoxel: './dist/cli.js' } },
    };
    for (const [field, manifest] of Object.entries(changes)) {
      for (const evidence of [stable, releasePullRequest]) {
        assert.throws(
          () => deriveRelease({ ...evidence, manifest }),
          new RegExp(`may change only the package.json version; it changes ${field}$`, 'u'),
        );
      }
    }
  });

  it('rejects a manifest version that disagrees with the release or does not move forward', () => {
    assert.throws(
      () => deriveRelease({ ...stable, manifest: manifestAt('0.2.0') }),
      /version 0\.2\.0 does not match 0\.1\.0/u,
    );
    for (const previous of ['0.1.0', '0.2.0', '1.0.0']) {
      assert.throws(
        () => deriveRelease({ ...stable, baseManifest: manifestAt(previous) }),
        new RegExp(`0\\.1\\.0 must be newer than ${previous.replaceAll('.', '\\.')}`, 'u'),
      );
    }
    assert.equal(deriveRelease({ ...stable, baseManifest: manifestAt('0.0.9') }).kind, 'release');
  });

  it('refuses to validate a release without both manifests', () => {
    for (const missing of [{ baseManifest: undefined }, { manifest: undefined }]) {
      assert.throws(() => deriveRelease({ ...stable, ...missing }), /needs package\.json before and after/u);
    }
  });

  it('accepts only deleted Version Plans', () => {
    assert.throws(
      () => deriveRelease({ ...stable, deletedFiles: [] }),
      /may only delete Version Plans; it keeps \.nx\/version-plans\/picovoxel-first-release\.md/u,
    );
    assert.throws(
      () =>
        deriveRelease({
          ...stable,
          changedFiles: [...stable.changedFiles, '.nx/version-plans/added.md'],
        }),
      /it keeps \.nx\/version-plans\/added\.md/u,
    );
  });

  it('accepts a release pull request only from release/next in this repository', () => {
    assert.throws(
      () => deriveRelease({ ...releasePullRequest, headRef: 'topic' }),
      /must come from release\/next in taucad\/picovoxel, not taucad\/picovoxel:topic/u,
    );
    assert.throws(
      () => deriveRelease({ ...releasePullRequest, headRepository: 'attacker/picovoxel' }),
      /not attacker\/picovoxel:release\/next/u,
    );
    assert.throws(
      () => deriveRelease({ ...releasePullRequest, repository: '', headRepository: '' }),
      /must come from release\/next/u,
    );
    assert.equal(
      deriveRelease({ ...releasePullRequest, headRef: 'topic', subject: 'fix(mesh): ordinary change' }).kind,
      'pull-request',
    );
  });
});

describe('release pull request staging', () => {
  const workflow = read('.github/workflows/release-pr.yml');

  /** The `allowed` guard the release job greps its staged file list against. */
  const allowed = (() => {
    const declaration = /^\s*allowed='([^']+)'$/mu.exec(workflow);
    assert(declaration, 'release-pr.yml must declare the allowed staged-file pattern');
    return new RegExp(declaration[1], 'u');
  })();

  /** The paths the job stages explicitly, from its single `git add` invocation. */
  const staged = (() => {
    const commands = [...workflow.matchAll(/^\s*git add (.+)$/gmu)];
    assert.equal(commands.length, 1, 'release-pr.yml must stage the release files in one command');
    return commands[0][1].trim().split(/\s+/u);
  })();

  it('admits and stages every file a release rewrites', () => {
    // The two guards are one contract: what ci.yml demands of a release commit
    // is exactly what the bot is allowed to stage into one.
    for (const file of RELEASE_FILES) {
      assert(allowed.test(file), `release-pr.yml rejects the required release file ${file}`);
      assert(staged.includes(file), `release-pr.yml never stages the required release file ${file}`);
    }
    assert.deepEqual([...staged].sort(byText), [...RELEASE_FILES].sort(byText));
    assert(allowed.test('.nx/version-plans/picovoxel-first-release.md'), 'a consumed plan is allowed');
  });

  it('refuses everything else, the lockfile and the built wasm included', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'src/pico.wasm',
      'dist/index.js',
      'README.md',
      'package.json.bak',
    ]) {
      assert(!allowed.test(file), `${file} must never enter a release commit`);
    }
  });

  it('commits with the exact subject the release policy publishes', () => {
    const subject = /commit --quiet -m "(chore\(release\): picovoxel v)\$version"/u.exec(workflow);
    assert(subject, 'release-pr.yml must commit the exact release subject');
    const derived = deriveRelease({ ...stable, subject: `${subject[1]}0.1.0` });
    assert.equal(derived.kind, 'release');
    assert(workflow.includes("TITLE: 'chore(release): picovoxel v${{ steps.commit.outputs.version }}'"));
  });
});

describe('release version validation', () => {
  const planned = { currentVersion: '0.0.0', plannedVersion: '0.1.0', requestedVersion: '0.1.0' };

  it('accepts the stable version the plans produce', () => {
    assert.equal(validateRequestedVersion(planned), '0.1.0');
  });

  it('rejects a requested version the plans did not produce', () => {
    assert.throws(
      () => validateRequestedVersion({ ...planned, requestedVersion: '0.2.0' }),
      /requested 0\.2\.0 does not match Version Plans \(0\.1\.0\)/u,
    );
  });

  it('rejects a version that is not newer than the current one', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersion: '0.1.0',
          plannedVersion: '0.1.0',
          requestedVersion: '0.1.0',
        }),
      /0\.1\.0 must be newer than 0\.1\.0/u,
    );
  });

  it('rejects a prerelease version', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          ...planned,
          plannedVersion: '0.1.0-rc.1',
          requestedVersion: '0.1.0-rc.1',
        }),
      /stable SemVer/u,
    );
  });

  it('rejects an unreadable current, planned or requested version', () => {
    assert.throws(
      () => validateRequestedVersion({ ...planned, currentVersion: 'nightly' }),
      /invalid package version: nightly/u,
    );
    assert.throws(
      () => validateRequestedVersion({ ...planned, plannedVersion: undefined }),
      /invalid Version Plan result/u,
    );
    assert.throws(
      () => validateRequestedVersion({ ...planned, requestedVersion: 'next' }),
      /invalid requested version: next/u,
    );
  });

  it('takes the version from the pending plans, and refuses when none is pending', () => {
    assert.equal(versionFromPlans('0.1.0'), '0.1.0');
    assert.throws(() => versionFromPlans(undefined), /no pending Version Plan affects picovoxel/u);
  });
});

describe('changelog thank you section', () => {
  const entry = (authors) =>
    [
      '## 0.1.1 (2026-10-01)',
      '',
      '### 🩹 Fixes',
      '',
      '- a fix',
      '',
      '### ❤️ Thank You',
      '',
      ...authors,
      '',
    ].join('\n');
  const published = ['## 0.1.0 (2026-09-28)', '', '### ❤️ Thank You', '', '- Claude Opus 5.5', ''].join('\n');

  it('keeps people and drops assistants and bots', () => {
    const changelog = `${entry(['- Claude Opus 5.5', '- OpenAI Codex', '- Richard Fontein @rifont', '- tau-release-bot[bot]'])}\n${published}`;
    const rendered = withoutNonHumanAuthors(changelog);
    assert.match(rendered, /### ❤️ Thank You\n\n- Richard Fontein @rifont\n/u);
    assert.doesNotMatch(rendered.split('## 0.1.0')[0], /Claude|OpenAI Codex|\[bot\]/u);
  });

  it('leaves published entries untouched', () => {
    const changelog = `${entry(['- Claude Opus 5.5', '- Richard Fontein @rifont'])}\n${published}`;
    assert(withoutNonHumanAuthors(changelog).endsWith(published));
  });

  it('removes the heading when nobody is left to thank', () => {
    const rendered = withoutNonHumanAuthors(entry(['- dependabot[bot]']));
    assert.doesNotMatch(rendered, /Thank You/u);
    assert.match(rendered, /- a fix\n$/u);
  });

  it('leaves a changelog without the section, or already filtered, unchanged', () => {
    const plain = '## 0.1.1 (2026-10-01)\n\n### 🩹 Fixes\n\n- a fix\n';
    assert.equal(withoutNonHumanAuthors(plain), plain);
    const once = withoutNonHumanAuthors(entry(['- Claude Opus 5.5', '- Richard Fontein @rifont']));
    assert.equal(withoutNonHumanAuthors(once), once);
  });
});

describe('changelog title', () => {
  const seed = '# Changelog\n\nRelease entries are generated from Nx Version Plans.\n';
  const first = '## 0.1.0 (2026-09-28)\n\n### 🚀 Features\n\n- First release.\n';
  const second = '## 0.2.0 (2026-10-05)\n\n### 🩹 Fixes\n\n- A fix.\n';

  it('moves the title and preamble nx wrote below the new entry back to the top', () => {
    const released = withTitleFirst(`${first}\n${seed}`);
    assert.equal(released, `${seed}\n${first}`);
    assert.equal(withTitleFirst(`${second}\n${released}`), `${seed}\n${second}\n${first}`);
  });

  it('leaves a changelog whose title is already first, or that has none, unchanged', () => {
    assert.equal(withTitleFirst(`${seed}\n${first}`), `${seed}\n${first}`);
    assert.equal(withTitleFirst(first), first);
  });

  it('agrees with the release policy check for the version section', () => {
    const released = withTitleFirst(`${first}\n${seed}`);
    assert.equal(deriveRelease({ ...stable, changelog: released }).kind, 'release');
  });
});

describe('release preparation gate', () => {
  const nxJson = JSON.parse(read('nx.json'));
  const project = JSON.parse(read('project.json'));
  const packageJson = JSON.parse(read('package.json'));
  const script = read('scripts/prepare-release.mjs');

  it('runs the fast subset: format, lint, typecheck and the package checks', () => {
    // The gate grades a commit whose full CI run has passed, and the release
    // pull request's own CI run is the full pipeline, so it stays fast.
    assert.deepEqual(RELEASE_GATE, ['format', 'lint', 'typecheck', 'pkgcheck']);
    for (const target of RELEASE_GATE) assert(project.targets[target], `project.json must define ${target}`);
  });

  it('runs the gate once, outside nx release versioning, with its findings printed', () => {
    // nx runs a configured pre-version command on every `releaseVersion` call
    // (preparation makes two), pipes its output and reports only stderr.
    assert.equal(nxJson.release.version.preVersionCommand, undefined);
    assert.equal(nxJson.release.version.groupPreVersionCommand, undefined);
    assert.equal(script.match(/RELEASE_GATE\.join/gu)?.length, 1);
    assert.match(script, /'nx', 'run-many', '--projects', PROJECT, '--targets', RELEASE_GATE\.join\(','\)/u);
    assert.match(script, /RELEASE_GATE\.join\(','\)\], \{\n\s+stdio: 'inherit'/u);
  });

  it('keeps Nx release git-inert and version-plan driven', () => {
    assert.deepEqual(nxJson.release.projects, ['picovoxel']);
    assert.equal(nxJson.release.version.specifierSource, 'version-plans');
    assert.equal(nxJson.release.version.adjustSemverBumpsForZeroMajorVersion, false);
    assert.deepEqual(nxJson.release.git, { commit: false, push: false, stageChanges: false, tag: false });
    assert.deepEqual(nxJson.release.releaseTag, { pattern: 'v{version}' });
  });

  it('filters the thanks, restores the title and formats the changelog after generating it', () => {
    assert(script.includes('withTitleFirst(withoutNonHumanAuthors(readFileSync(CHANGELOG_PATH'));
    assert.match(
      script,
      /execFileSync\('pnpm', \['exec', 'oxfmt', '--write', fileURLToPath\(CHANGELOG_PATH\)\]\)/u,
    );
  });

  it('is the release:prepare script, with semver pinned as a direct dependency', () => {
    assert.equal(packageJson.scripts['release:prepare'], 'node scripts/prepare-release.mjs');
    assert.match(packageJson.devDependencies.semver, /^\d+\.\d+\.\d+$/u);
    assert.match(packageJson.devDependencies.nx, /^\d+\.\d+\.\d+$/u);
  });
});
