/**
 * Fetch one pinned upstream source tree at the commit `inputs.json` records.
 *
 * `prepare-archive.mjs` needs three of these trees, and the package build needs the managed
 * library's alone; one implementation keeps the two from drifting. The fetch is shallow and by
 * commit, so the remote's branches cannot decide what is built. Identity is proved by the caller:
 * `sourceIdentity` compares the checked-out tree against the pin's recorded Git blobs.
 *
 * Usage: node dotnet/fetch-pinned-source.mjs <PicoGK|ShapeKernel|HelixHeatX> <new directory>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The upstream repository each pinned source name is fetched from. */
export const repositories = {
  PicoGK: 'leap71/PicoGK',
  ShapeKernel: 'leap71/LEAP71_ShapeKernel',
  HelixHeatX: 'leap71/LEAP71_HelixHeatX',
};

/**
 * Check out one pinned tree into a fresh directory.
 *
 * @param {string} name - The pinned source name.
 * @param {string} destination - A directory that does not exist yet.
 * @returns {string} The checked-out directory.
 */
export const fetchPinnedSource = (name, destination) => {
  const repository = repositories[name];
  if (!repository) throw new Error(`Unknown pinned source: ${name}`);
  const root = resolve(destination);
  if (existsSync(root)) throw new Error('Destination must be fresh; a reused tree hides another commit');
  const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
  const { commit } = pins.sources[name];
  if (!/^[a-f\d]{40}$/u.test(commit)) throw new Error(`Pinned commit is not a full hash: ${name}`);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', [
    '-C',
    root,
    'fetch',
    '--quiet',
    '--depth=1',
    `https://github.com/${repository}.git`,
    commit,
  ]);
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  return root;
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [name, destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length)
    throw new Error('Usage: fetch-pinned-source.mjs <PicoGK|ShapeKernel|HelixHeatX> <new directory>');
  console.log(fetchPinnedSource(name, destination));
}
