/**
 * Gate one subject's browser outputs against the native reference, per engine.
 *
 * `compare.mjs` judges one engine's captures against the native fixture, one named mode at a time.
 * The floor is three engines, so this runs it per engine and writes the one `parity-<subject>.json`
 * the invariant reporter reads. An absent directory fails rather than being dropped: a browser that
 * did not run must not read as one that agreed.
 *
 * Each engine names its modes, because a run with a serial and a threaded app of each kind has four
 * to judge, and the report records which it judged.
 *
 * Usage: node dotnet/gate-parity.mjs <gyroid|heatx> <native captures> <evidence directory>
 *          <engine>=<mode>:<captures>,<mode>:<captures>... ...
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareParity } from './tests/parity/compare.mjs';

const [subject, nativeArg, evidenceArg, ...engineArgs] = process.argv.slice(2);
if (!engineArgs.length || !evidenceArg)
  throw new Error(
    'Usage: gate-parity.mjs <gyroid|heatx> <native captures> <evidence directory> <engine>=<mode>:<captures>... ...',
  );
const native = resolve(nativeArg);
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });

const engines = engineArgs.map((argument) => {
  const [engine, modeList = ''] = argument.split('=');
  const modes = Object.fromEntries(
    modeList
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(':');
        const [mode, directory] = [entry.slice(0, separator), entry.slice(separator + 1)];
        if (separator === -1 || !mode || !directory || mode === 'native')
          throw new Error(`Expected <mode>:<captures> with a mode that is not \`native\`, not ${entry}`);
        return [mode, resolve(directory)];
      }),
  );
  if (!engine || !Object.keys(modes).length)
    throw new Error(`Expected <engine>=<mode>:<captures>,<mode>:<captures>..., not ${argument}`);
  return { engine, modes };
});

const results = engines.map(({ engine, modes }) => {
  const missing = [['native', native], ...Object.entries(modes)].filter(
    ([, directory]) => !existsSync(directory),
  );
  if (missing.length)
    return { engine, passed: false, reason: `No captures for ${missing.map(([mode]) => mode).join(', ')}` };
  try {
    return { engine, ...compareParity(subject, { native, ...modes }) };
  } catch (failure) {
    // A malformed capture is this engine's failure, reported as one rather than ending the gate
    // before the engines after it are judged.
    return { engine, passed: false, reason: `Captures rejected: ${failure.message}` };
  }
});

const report = {
  subject,
  // The charter's browser floor; a run that names fewer engines is reported as covering fewer.
  engines: results.map((result) => result.engine),
  passed: results.every((result) => result.passed),
  results,
};
const path = join(evidence, `parity-${subject}.json`);
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(`${subject}: ${report.passed ? 'passed' : 'FAILED'} on ${report.engines.join(', ')} -> ${path}`);
if (!report.passed) process.exitCode = 1;
