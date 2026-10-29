/**
 * Judge each measured path against the matched native comparator.
 *
 * The target is a ratio of geometry time and it is not waived: a path whose run costs more than
 * 2 times the comparator's own best round fails. Both sides time the same call, the fixture's own
 * `Run`, so neither number carries its host's start. Cold start, the cost of an edit, the bytes a
 * page fetched and the engine's heap are recorded beside the verdict rather than gated.
 *
 * A path with no measurement is unmeasured and fails: an absent number is not a passing one.
 *
 * Usage: node dotnet/gate-performance.mjs <gyroid|heatx> <native performance.json>
 *          <evidence directory> <performance.json> ...
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The ruled ceiling on a browser path's geometry time, as a multiple of the matched native run.
 *
 * 2, not the 1.3 measured against first. Against native pinned to one core, every substantial
 * geometry stage costs the browser 1.22x to 1.33x, so the rest of the first ceiling's distance was
 * native's own parallelism rather than anything in this path. With threads the best engine reaches
 * 1.50x of four-core native, and wasm's own execution penalty is what remains. The ceiling admits
 * that penalty and nothing more: a path over it still fails, and an unmeasured path still fails.
 */
export const runRatioCeiling = 2;

/**
 * Compare each measured path against one native baseline.
 *
 * @param {{ best: { runMilliseconds: number, milliseconds: number }, subject: string }} native - The baseline.
 * @param {ReadonlyArray<object>} measurements - One browser report per engine and path.
 * @returns {{ passed: boolean, paths: object[] }} The judgement.
 */
export function judgePerformance(native, measurements) {
  const baseline = native.best.runMilliseconds;
  if (typeof baseline !== 'number') throw new Error('The baseline reported no geometry time');
  const paths = measurements.map((measured) => {
    const run = measured.timings?.run;
    if (typeof run !== 'number')
      return {
        engine: measured.engine,
        mode: measured.mode,
        status: 'unmeasured',
        reason: 'The run reported no geometry time',
      };
    const ratio = run / baseline;
    return {
      engine: measured.engine,
      mode: measured.mode,
      status: ratio <= runRatioCeiling ? 'passed' : 'failed',
      run,
      ratio: Number(ratio.toFixed(3)),
      // Recorded, not gated: R31 names these as figures to keep, with no ruled ceiling.
      recorded: {
        coldStartMilliseconds: measured.timings?.boot,
        stageMilliseconds: measured.timings?.stage,
        compileMilliseconds: measured.timings?.compile,
        editCompileMilliseconds: measured.timings?.editCompile,
        editRunMilliseconds: measured.timings?.editRun,
        transferBytes: measured.transfer?.bytes,
        transferRequests: measured.transfer?.requests,
        heapBytes: measured.timings?.heapBytes,
      },
      ...(ratio <= runRatioCeiling
        ? {}
        : { reason: `Geometry time is ${ratio.toFixed(2)}x the matched native run` }),
    };
  });
  return { passed: paths.length > 0 && paths.every((path) => path.status === 'passed'), paths };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [subject, nativeArg, evidenceArg, ...reports] = process.argv.slice(2);
  if (!reports.length || !evidenceArg)
    throw new Error(
      'Usage: gate-performance.mjs <gyroid|heatx> <native performance.json> <evidence directory> <performance.json> ...',
    );
  const native = JSON.parse(readFileSync(resolve(nativeArg), 'utf8'));
  if (native.subject !== subject) throw new Error(`The baseline measures ${native.subject}, not ${subject}`);
  const measurements = reports.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
  const evidence = resolve(evidenceArg);
  if (!existsSync(evidence)) mkdirSync(evidence, { recursive: true });
  const judged = judgePerformance(native, measurements);
  const report = {
    subject,
    ceiling: runRatioCeiling,
    native: {
      host: native.host,
      runMilliseconds: native.best.runMilliseconds,
      processMilliseconds: native.best.milliseconds,
    },
    ...judged,
  };
  const path = join(evidence, `performance-${subject}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  for (const row of report.paths)
    console.log(`${row.engine} ${row.mode}: ${row.status}${row.ratio ? ` at ${String(row.ratio)}x` : ''}`);
  console.log(`${subject}: ${report.passed ? 'passed' : 'FAILED'} -> ${path}`);
  if (!report.passed) process.exitCode = 1;
}
