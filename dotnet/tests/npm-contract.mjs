/**
 * I4: prove this program's own diff moves no part of PicoVoxel's npm contract.
 *
 * The contract is the published bytes: the byte-locked fixtures and the surface manifest
 * (`AGENTS.md`). A release legitimately changes them on the default branch, so the comparison is
 * against the merge base, not the branch tip: what matters is whether these commits touch them.
 * A missing merge base is a failure, never a pass — a shallow checkout cannot prove this.
 *
 * Usage: node dotnet/tests/npm-contract.mjs <checkout> <base ref> <report.json>
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The paths whose bytes are the published product contract. */
export const contractPaths = ['test/fixtures', 'test/surface-manifest.json'];

/**
 * The contract paths a range of commits touches.
 *
 * @param {string} checkout - The repository to inspect.
 * @param {string} base - The branch the program merges into.
 * @returns {{ base: string, mergeBase: string, touched: string[] }} The comparison.
 */
export const npmContractDiff = (checkout, base) => {
  const git = (...args) =>
    execFileSync('git', ['-C', resolve(checkout), ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  let mergeBase;
  try {
    mergeBase = git('merge-base', base, 'HEAD');
  } catch {
    throw new Error(`No merge base between ${base} and HEAD; a shallow checkout cannot prove I4`);
  }
  if (!/^[a-f\d]{40}$/u.test(mergeBase)) throw new Error('Merge base is not a full commit hash');
  const touched = git('diff', '--name-only', mergeBase, 'HEAD', '--', ...contractPaths)
    .split('\n')
    .filter(Boolean);
  return { base, mergeBase, touched };
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [checkout, base, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error('Usage: npm-contract.mjs <checkout> <base ref> <report.json>');
  const result = npmContractDiff(checkout, base);
  writeFileSync(output, `${JSON.stringify({ ...result, paths: contractPaths }, null, 2)}\n`, { flag: 'wx' });
  if (result.touched.length) {
    console.error(`The npm contract moved: ${result.touched.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`The npm contract is unchanged since ${result.mergeBase}`);
  }
}
