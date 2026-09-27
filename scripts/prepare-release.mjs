#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { releaseChangelog, releaseVersion } from 'nx/release/index.js';
import semver from 'semver';

/** The only released project: this repository publishes one package. */
const PROJECT = 'picovoxel';
const PACKAGE_PATH = new URL('../package.json', import.meta.url);
const CHANGELOG_PATH = new URL('../CHANGELOG.md', import.meta.url);
const GIT_OPTIONS = {
  gitCommit: false,
  gitPush: false,
  gitTag: false,
  stageChanges: false,
};

/**
 * The release gate: format, lint, typecheck and the package checks. It grades
 * a commit whose full CI run has passed, so it is the fast subset rather than
 * the whole `quality` fan-in; the release pull request's own CI run is the full
 * pipeline.
 */
export const RELEASE_GATE = ['format', 'lint', 'typecheck', 'pkgcheck'];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const THANK_YOU = '### ❤️ Thank You';
/**
 * Authors that are not people: the `tau-release-bot` that commits the release
 * itself, Dependabot, and the coding assistants whose `Co-Authored-By` trailer
 * nx reads as an author.
 */
const NON_HUMAN_AUTHOR = /^- (?:claude\b|openai codex\b|.*\[bot\])/iu;

/**
 * Drop non-human authors from the newest changelog entry's Thank You list.
 *
 * The commit trailer records who and what produced a change, which is where
 * that provenance belongs. This section credits people, so it follows the
 * usual release-note convention of leaving bots out of the thanks. Published
 * entries are left untouched: they are the record of what shipped.
 */
export const withoutNonHumanAuthors = (changelog) => {
  const lines = changelog.split('\n');
  const nextEntry = lines.findIndex((line, index) => index > 0 && line.startsWith('## '));
  const limit = nextEntry === -1 ? lines.length : nextEntry;
  const heading = lines.findIndex((line, index) => index < limit && line === THANK_YOU);
  if (heading === -1) return changelog;

  let end = heading + 1;
  while (end < limit && lines[end] === '') end += 1;
  const authors = [];
  while (end < limit && lines[end].startsWith('- ')) {
    authors.push(lines[end]);
    end += 1;
  }

  const people = authors.filter((author) => !NON_HUMAN_AUTHOR.test(author));
  if (people.length === authors.length) return changelog;

  // With nobody left to thank the heading goes too, along with the blank line
  // that separated it from the entry above.
  const start = people.length > 0 || lines[heading - 1] !== '' ? heading : heading - 1;
  const kept = people.length > 0 ? [THANK_YOU, '', ...people] : [];
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n');
};

/**
 * Keep the changelog's title and preamble above its entries.
 *
 * nx writes each new entry at the very top of the file, above the `# ` title,
 * which would bury the title under the newest release in the shipped
 * CHANGELOG.md. The title and the text up to the next entry move back to the
 * top; the entries keep their order.
 */
export const withTitleFirst = (changelog) => {
  const lines = changelog.replace(/\n+$/u, '').split('\n');
  const title = lines.findIndex((line) => line.startsWith('# '));
  if (title <= 0) return changelog;
  const next = lines.findIndex((line, index) => index > title && line.startsWith('## '));
  const end = next === -1 ? lines.length : next;
  const trim = (block) => {
    const copy = [...block];
    while (copy.at(-1) === '') copy.pop();
    return copy;
  };
  const preamble = trim(lines.slice(title, end));
  const entries = trim([...lines.slice(0, title), ...lines.slice(end)]);
  return `${[...preamble, '', ...entries].join('\n')}\n`;
};

const packageVersion = () => JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;

/**
 * Run the release gate once, against the committed tree, in this terminal.
 *
 * The gate belongs here rather than in nx's `version.preVersionCommand`: nx
 * runs a pre-version command on every `releaseVersion` call, and preparation
 * makes two (the dry version preview and the real bump), so the second run
 * would grade a tree the first one regenerated. nx also runs that command with
 * `stdio: 'pipe'` and reports only the child's stderr, which drops the findings
 * of every gate that reports on stdout.
 */
const runReleaseGate = () => {
  execFileSync('pnpm', ['nx', 'run-many', '--projects', PROJECT, '--targets', RELEASE_GATE.join(',')], {
    stdio: 'inherit',
  });
};

const assertClean = () => {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert(status.length === 0, 'release preparation requires a clean worktree');
};

/** The version the pending Version Plans dictate, for `--from-plans` runs. */
export const versionFromPlans = (plannedVersion) => {
  assert(Boolean(plannedVersion), `no pending Version Plan affects ${PROJECT}`);
  return plannedVersion;
};

export const validateRequestedVersion = ({ currentVersion, plannedVersion, requestedVersion }) => {
  assert(semver.valid(currentVersion), `invalid package version: ${currentVersion}`);
  assert(semver.valid(plannedVersion), `invalid Version Plan result: ${plannedVersion}`);
  assert(semver.valid(requestedVersion), `invalid requested version: ${requestedVersion}`);
  assert(semver.prerelease(requestedVersion) === null, 'routine releases require stable SemVer');
  assert(
    plannedVersion === requestedVersion,
    `requested ${requestedVersion} does not match Version Plans (${plannedVersion})`,
  );
  assert(
    semver.gt(requestedVersion, currentVersion),
    `${requestedVersion} must be newer than ${currentVersion}`,
  );
  return requestedVersion;
};

const prepare = async ({ dryRun, requestedVersion }) => {
  // Asserted on entry: the gate builds and installs its pinned tools, so the
  // tree is only guaranteed clean before preparation starts. Release-commit
  // purity is enforced by the caller staging only release files, and by the CI
  // release policy.
  if (!dryRun) assertClean();
  runReleaseGate();
  const currentVersion = packageVersion();
  const preview = await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: false,
    dryRun: true,
  });
  const plannedVersion = versionFromPlans(preview.projectsVersionData[PROJECT]?.newVersion);
  const version = requestedVersion ?? plannedVersion;
  validateRequestedVersion({ currentVersion, plannedVersion, requestedVersion: version });

  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: true,
    dryRun: true,
    releaseGraph: preview.releaseGraph,
    version,
  });
  if (dryRun) return version;

  await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: true,
    version,
  });
  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: false,
    releaseGraph: preview.releaseGraph,
    version,
  });
  writeFileSync(CHANGELOG_PATH, withTitleFirst(withoutNonHumanAuthors(readFileSync(CHANGELOG_PATH, 'utf8'))));
  execFileSync('pnpm', ['exec', 'oxfmt', '--write', fileURLToPath(CHANGELOG_PATH)]);
  assert(packageVersion() === version, `release preparation did not leave ${PROJECT} at ${version}`);
  return version;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedVersion = process.argv.slice(2).find((value) => !value.startsWith('-'));
  const dryRun = process.argv.includes('--dry-run');
  const fromPlans = process.argv.includes('--from-plans');

  try {
    assert(
      fromPlans ? !requestedVersion : requestedVersion,
      'usage: pnpm release:prepare -- <version> [--dry-run], or pnpm release:prepare -- --from-plans [--dry-run]',
    );
    const version = await prepare({ dryRun, requestedVersion });
    console.log(`${dryRun ? 'Would prepare' : 'Prepared'} picovoxel v${version}`);
    if (!dryRun) {
      console.log(`Commit generated release files as: chore(release): picovoxel v${version}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
