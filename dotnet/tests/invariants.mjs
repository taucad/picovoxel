/**
 * Report I1 to I5 from the evidence a CI run actually produced.
 *
 * R35 is the reason this exists: a check that did not run must never read as a pass. Each
 * invariant here is `passed`, `failed` or `unproven`, and anything but `passed` for all five is a
 * failure. Nothing is re-derived — the jobs that prove each invariant write their own evidence, and
 * this driver only reads it, so a missing report is reported as missing rather than assumed.
 *
 * Expected evidence, by file name, under one directory:
 *   parity-<subject>.json     I1  one `compareParity` report per subject; gyroid is required
 *   author-sources.json       I2  the staged author sources, against their pinned commits
 *   archive-<execution>.json  I3  each archive receipt, both executions required
 *   npm-contract.json         I4  `npm-contract.mjs`
 *   desktop-neutrality.json   I5  the darwin desktop suite's own result
 *
 * Usage: node dotnet/tests/invariants.mjs <evidence directory> <report.json>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** What each invariant claims, in the charter's words. */
export const statements = {
  I1: 'Same engine sources mean the same bytes, for the gyroid sphere on every run and HeatX on a schedule.',
  I2: 'Author code is never edited for the web; only the PicoGK library and the host change.',
  I3: "The archive's Emscripten equals the target workload's pin, and the build checks it before linking.",
  I4: "PicoVoxel's npm contract does not change for this program.",
  I5: 'Desktop behaviour is unchanged for existing PicoGK users.',
};

const unproven = (reason) => ({ status: 'unproven', reason });

/**
 * Judge the five invariants from one evidence directory.
 *
 * @param {string} directory - The collected evidence.
 * @returns {{ passed: boolean, invariants: Record<string, object> }} The judgement.
 */
export const judgeInvariants = (directory) => {
  const root = resolve(directory);
  const pins = JSON.parse(readFileSync(join(here, '../inputs.json'), 'utf8'));
  const read = (name) => {
    const path = join(root, name);
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes), evidence: name };
  };
  const names = existsSync(root) ? readdirSync(root).sort() : [];

  const parity = names
    .filter((name) => /^parity-[a-z]+\.json$/u.test(name))
    .map((name) => ({ subject: name.slice('parity-'.length, -'.json'.length), ...read(name) }));
  const i1 = (() => {
    if (!parity.some((row) => row.subject === 'gyroid'))
      return unproven('No gyroid parity report; the per-run subject is required');
    const failed = parity.filter((row) => row.value?.passed !== true).map((row) => row.subject);
    return {
      status: failed.length ? 'failed' : 'passed',
      subjects: parity.map((row) => ({
        subject: row.subject,
        passed: row.value?.passed === true,
        sha256: row.sha256,
      })),
      ...(failed.length ? { reason: `Parity failed: ${failed.join(', ')}` } : {}),
    };
  })();

  const sources = read('author-sources.json');
  const i2 = !sources
    ? unproven('No author-source report')
    : {
        status: sources.value.unmodified === true ? 'passed' : 'failed',
        subjects: sources.value.subjects,
        sha256: sources.sha256,
        ...(sources.value.unmodified === true ? {} : { reason: 'Staged author source differs from its pin' }),
      };

  const archives = Object.fromEntries(
    ['serial', 'threaded'].map((execution) => [execution, read(`archive-${execution}.json`)]),
  );
  const i3 = (() => {
    const missing = Object.entries(archives)
      .filter(([, row]) => !row)
      .map(([execution]) => execution);
    if (missing.length) return unproven(`No archive receipt: ${missing.join(', ')}`);
    const wrong = Object.entries(archives).filter(
      ([, row]) =>
        row.value.toolchain?.emscripten !== pins.emscripten ||
        row.value.toolchain?.emscriptenRevision !== pins.emscriptenRevision,
    );
    return {
      status: wrong.length ? 'failed' : 'passed',
      expected: { emscripten: pins.emscripten, revision: pins.emscriptenRevision },
      executions: Object.fromEntries(
        Object.entries(archives).map(([execution, row]) => [
          execution,
          {
            emscripten: row.value.toolchain?.emscripten,
            revision: row.value.toolchain?.emscriptenRevision,
            sha256: row.sha256,
          },
        ]),
      ),
      ...(wrong.length
        ? { reason: `Archive built by another compiler: ${wrong.map(([name]) => name).join(', ')}` }
        : {}),
    };
  })();

  const contract = read('npm-contract.json');
  const i4 = !contract
    ? unproven('No npm-contract report')
    : {
        status:
          Array.isArray(contract.value.touched) && contract.value.touched.length === 0 ? 'passed' : 'failed',
        mergeBase: contract.value.mergeBase,
        touched: contract.value.touched,
        sha256: contract.sha256,
        ...(contract.value.touched?.length
          ? { reason: `Contract paths moved: ${contract.value.touched.join(', ')}` }
          : {}),
      };

  const desktop = read('desktop-neutrality.json');
  const i5 = !desktop
    ? unproven('No desktop-neutrality report')
    : {
        status: desktop.value.status === 'passed' ? 'passed' : 'failed',
        host: desktop.value.host,
        suite: desktop.value.suite,
        sha256: desktop.sha256,
        ...(desktop.value.status === 'passed' ? {} : { reason: 'The desktop suite did not pass' }),
      };

  const invariants = { I1: i1, I2: i2, I3: i3, I4: i4, I5: i5 };
  for (const [name, row] of Object.entries(invariants)) row.statement = statements[name];
  return { passed: Object.values(invariants).every((row) => row.status === 'passed'), invariants };
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [directory, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error('Usage: invariants.mjs <evidence directory> <report.json>');
  const result = judgeInvariants(directory);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  for (const [name, row] of Object.entries(result.invariants))
    console.log(`${name} ${row.status}${row.reason ? `: ${row.reason}` : ''}`);
  if (!result.passed) process.exitCode = 1;
}
