#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

/**
 * Manifest fields that never reach a consumer's install: the tooling this
 * repository builds and checks itself with. Every other field ships in the
 * tarball's package.json (dependencies, peerDependencies, exports, engines).
 */
const DEVELOPMENT_FIELDS = new Set(['devDependencies', 'packageManager', 'scripts']);

/**
 * Scripts that are not development-only although `scripts` is: the lifecycle
 * hooks npm runs when a consumer installs the package (the prepare and pack
 * hooks run for a git install), and `build`, the recipe for `dist/`.
 */
const SHIPPED_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepack',
  'postpack',
  'build',
];

const changedKeys = (before = {}, after = {}) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !isDeepStrictEqual(before[key], after[key]),
  );

const manifestNeedsPlan = (before, after) =>
  changedKeys(before, after).some(
    (key) =>
      !DEVELOPMENT_FIELDS.has(key) ||
      (key === 'scripts' &&
        changedKeys(before.scripts, after.scripts).some((name) => SHIPPED_SCRIPTS.includes(name))),
  );

/**
 * Decide whether a change needs a Version Plan.
 *
 * One is needed when the change can reach what `npm install picovoxel` gets:
 * a shipped manifest field, a shipped document, or any source the package is
 * built from. It is not needed when every changed path is one of these:
 * - development-only `package.json` fields (a grouped devDependency update),
 *   except the install hooks and `build` script;
 * - Markdown outside the package's `files` set;
 * - a path `nx.json` exempts from the plan check (tests, CI, the lockfile,
 *   repository tooling).
 *
 * Returns the paths that need a plan; an empty list means none is required.
 */
export const releaseAffectingPaths = ({
  changedFiles,
  baseManifest,
  headManifest,
  ignorePatterns,
  packageFiles,
}) =>
  changedFiles.filter((file) => {
    if (file === 'package.json') {
      return manifestNeedsPlan(baseManifest, headManifest);
    }
    if (file.endsWith('.md') && !packageFiles.includes(file)) return false;
    return !ignorePatterns.some((pattern) => matchesGlob(file, pattern));
  });

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } });
    if (!values.base || !values.head) throw new Error('usage: plan-check.mjs --base <ref> --head <ref>');
    const base = git('merge-base', values.base, values.head).trim();
    // As nx does: a move lists its source too, so moving a file out of src/ counts.
    const changedFiles = git('diff', '--name-only', '--no-renames', base, values.head)
      .split('\n')
      .filter(Boolean);
    const headManifest = JSON.parse(git('show', `${values.head}:package.json`));
    const affected = releaseAffectingPaths({
      changedFiles,
      baseManifest: JSON.parse(git('show', `${base}:package.json`)),
      headManifest,
      ignorePatterns: JSON.parse(readFileSync('nx.json', 'utf8')).release.versionPlans
        .ignorePatternsForPlanCheck,
      packageFiles: headManifest.files,
    });
    if (affected.length === 0) {
      process.stdout.write('No change reaches the published package, so no Version Plan is required.\n');
    } else {
      process.stdout.write(`Changes that reach the published package: ${affected.join(', ')}\n`);
      execFileSync('pnpm', ['nx', 'release', 'plan:check', `--base=${base}`, `--head=${values.head}`], {
        stdio: 'inherit',
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
