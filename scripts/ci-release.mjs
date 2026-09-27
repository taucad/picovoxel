#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SHA = /^[0-9a-f]{40}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_SUBJECT = /^chore\(release\): picovoxel v(.+?)(?: \(#\d+\))?$/u;
/** The only branch a release pull request may come from: the bot's. */
export const RELEASE_BRANCH = 'release/next';
/**
 * Files a release rewrites. A release commit changes these and deletes the
 * Version Plans it consumes; every other path is unexpected. Bumping the
 * version leaves `pnpm-lock.yaml` byte-identical, so it never needs to change.
 */
export const RELEASE_FILES = new Set(['CHANGELOG.md', 'package.json']);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isVersionPlan = (file) => file.startsWith('.nx/version-plans/') && file.endsWith('.md');

const semverParts = (version) => SEMVER.exec(version)?.slice(1).map(Number);

const isNewer = (next, previous) => {
  const [a, b] = [semverParts(next), semverParts(previous)];
  if (!a || !b) return false;
  const index = a.findIndex((part, position) => part !== b[position]);
  return index !== -1 && a[index] > b[index];
};

/**
 * The manifest may change in exactly one field: `version`, moved forward to the
 * released version. Anything else (a dependency, an export, a script) would
 * ship without the review and Version Plan a change to the package needs.
 */
const validateManifest = ({ baseManifest, manifest, packageVersion }) => {
  assert(
    baseManifest && manifest,
    'release validation needs package.json before and after the release commit',
  );
  const { version: before, ...baseRest } = baseManifest;
  const { version: after, ...rest } = manifest;
  assert(after === packageVersion, `package.json version ${after} does not match ${packageVersion}`);
  assert(isNewer(after, before), `release version ${after} must be newer than ${before}`);
  const changed = [...new Set([...Object.keys(baseRest), ...Object.keys(rest)])].filter(
    (key) => !isDeepStrictEqual(baseRest[key], rest[key]),
  );
  assert(
    changed.length === 0,
    `release commit may change only the package.json version; it changes ${changed.join(', ')}`,
  );
};

const validateRelease = ({
  baseManifest,
  changedFiles,
  changelog,
  deletedFiles,
  manifest,
  packageVersion,
  subject,
}) => {
  const match = RELEASE_SUBJECT.exec(subject);
  assert(match, `release source is not an exact release commit: ${subject}`);
  assert(match[1] === packageVersion, `release subject ${match[1]} does not match ${packageVersion}`);
  assert(SEMVER.test(packageVersion), `release version is not stable SemVer: ${packageVersion}`);
  for (const file of RELEASE_FILES) {
    assert(changedFiles.includes(file), `release commit must change ${file}`);
  }
  const plans = changedFiles.filter(isVersionPlan);
  assert(plans.length > 0, 'release commit must consume a Version Plan');
  const kept = plans.filter((file) => !deletedFiles.includes(file));
  assert(kept.length === 0, `release commit may only delete Version Plans; it keeps ${kept.join(', ')}`);
  const unexpected = changedFiles.filter((file) => !RELEASE_FILES.has(file) && !isVersionPlan(file));
  assert(unexpected.length === 0, `release commit has unexpected files: ${unexpected.join(', ')}`);
  validateManifest({ baseManifest, manifest, packageVersion });
  assert(
    changelog
      .split(/\r?\n/u)
      .some((line) => line === `## ${packageVersion}` || line.startsWith(`## ${packageVersion} (`)),
    `CHANGELOG.md has no ${packageVersion} section`,
  );
};

/**
 * Classify one CI run: what evidence it owes, and whether it may publish.
 *
 * Publication has exactly one source, a `push` of an exact release commit to
 * `refs/heads/main`. A `workflow_dispatch` is evidence only, from any ref: it
 * never publishes and never derives `release`, even from main and even when the
 * head commit is a release commit.
 */
export const deriveRelease = ({
  event,
  ref,
  sha,
  packageVersion,
  subject = '',
  changedFiles = [],
  deletedFiles = [],
  changelog = '',
  baseManifest,
  manifest,
  headRef = '',
  headRepository = '',
  repository = '',
}) => {
  assert(SHA.test(sha), 'sha must be 40 lowercase hexadecimal characters');
  assert(SEMVER.test(packageVersion), `package version is not stable SemVer: ${packageVersion}`);
  const release = RELEASE_SUBJECT.test(subject);
  const evidence = { baseManifest, changedFiles, changelog, deletedFiles, manifest, packageVersion, subject };

  if (event === 'pull_request') {
    if (release) {
      assert(
        headRef === RELEASE_BRANCH && repository !== '' && headRepository === repository,
        `a release pull request must come from ${RELEASE_BRANCH} in ${repository}, not ${headRepository}:${headRef}`,
      );
      validateRelease(evidence);
    }
    return {
      kind: release ? 'release-pull-request' : 'pull-request',
      npmPublish: false,
      version: packageVersion,
    };
  }

  if (event === 'workflow_dispatch') return { kind: 'dispatch', npmPublish: false, version: packageVersion };

  assert(event === 'push', `unsupported event: ${event}`);
  assert(ref === 'refs/heads/main', `publication source must be protected main: ${ref}`);
  if (!release) {
    assert(!subject.startsWith('chore(release): picovoxel v'), `malformed release subject: ${subject}`);
    return { kind: 'main', npmPublish: false, version: packageVersion };
  }
  validateRelease(evidence);
  return {
    kind: 'release',
    npmPublish: true,
    releaseTag: `v${packageVersion}`,
    version: packageVersion,
  };
};

const parseArgs = (argv) =>
  Object.fromEntries(
    argv.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), argv[index + 1] ?? '']] : [])),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const lines = (path) => (path ? readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean) : []);
    const json = (path) => (path ? JSON.parse(readFileSync(path, 'utf8')) : undefined);
    const result = deriveRelease({
      event: args['event'],
      ref: args['ref'],
      sha: args['sha'],
      packageVersion: args['package-version'],
      subject: args['subject'],
      changedFiles: lines(args['changed-files-file']),
      deletedFiles: lines(args['deleted-files-file']),
      changelog: readFileSync('CHANGELOG.md', 'utf8'),
      baseManifest: json(args['base-package-json-file']),
      manifest: json(args['package-json-file']),
      headRef: args['head-ref'],
      headRepository: args['head-repository'],
      repository: args['repository'],
    });
    const output = Object.entries(result)
      .map(
        ([key, value]) => `${key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)}=${value}`,
      )
      .join('\n');
    process.stdout.write(`${output}\n`);
    if (process.env['GITHUB_OUTPUT']) {
      appendFileSync(process.env['GITHUB_OUTPUT'], `${output}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
