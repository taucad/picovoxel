/**
 * Gate one subject's browser outputs against the native reference, for every engine that ran.
 *
 * `compare.mjs` judges one engine's AOT and dynamic captures against the native fixture's bytes.
 * The charter's floor is three engines, so this driver runs that comparison once per engine and
 * writes the single `parity-<subject>.json` the invariant reporter reads. It passes only when every
 * named engine passed, and an engine whose directory is absent fails rather than being dropped:
 * R35 again, because a browser that did not run must not read as a browser that agreed.
 *
 * Usage: node dotnet/gate-parity.mjs <gyroid|heatx> <native captures> <evidence directory>
 *          <engine>=<AOT captures>,<dynamic captures> ...
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareParity } from './tests/parity/compare.mjs';

const [subject, nativeArg, evidenceArg, ...engineArgs] = process.argv.slice(2);
if (!engineArgs.length || !evidenceArg)
  throw new Error(
    'Usage: gate-parity.mjs <gyroid|heatx> <native captures> <evidence directory> <engine>=<AOT>,<dynamic> ...',
  );
const native = resolve(nativeArg);
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });

const engines = engineArgs.map((argument) => {
  const [engine, directories = ''] = argument.split('=');
  const [aot, dynamic, ...extra] = directories.split(',').filter(Boolean);
  if (!engine || !dynamic || extra.length)
    throw new Error(`Expected <engine>=<AOT captures>,<dynamic captures>, not ${argument}`);
  return { engine, aot: resolve(aot), dynamic: resolve(dynamic) };
});

const results = engines.map(({ engine, aot, dynamic }) => {
  const missing = [
    ['native', native],
    ['aot', aot],
    ['dynamic', dynamic],
  ].filter(([, directory]) => !existsSync(directory));
  if (missing.length)
    return { engine, passed: false, reason: `No captures for ${missing.map(([mode]) => mode).join(', ')}` };
  try {
    return { engine, ...compareParity(subject, { native, aot, dynamic }) };
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
