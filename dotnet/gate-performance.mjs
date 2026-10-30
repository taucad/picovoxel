/**
 * Judge each measured path against the matched native comparator.
 *
 * The target is a ratio of geometry time and it is not waived: on a judged subject, a threaded path
 * costing more than twice the comparator's own best round fails. Serial paths are measured and
 * recorded with their ratio, and do not decide the gate. Both sides time the same call, so neither
 * number carries its host's start. Cold start, edit cost, bytes fetched and heap are recorded.
 *
 * A path with no measurement is unmeasured and fails on every subject, judged or not.
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
 * The subjects whose ratio the ceiling judges.
 *
 * The ratio is a statement about geometry, so it is read off the subject that is geometry. The long
 * subject's own work dominates its run. The short subject's run is a fraction of a second, so the
 * costs paid once move its ratio more than the engine does, and gating on it would judge start-up.
 *
 * The short subject is still measured and still reported, with its ratio, on every run. What it
 * does not do is decide this gate. Byte identity is untouched, and a capture that is not identical
 * to native still fails.
 */
export const judgedSubjects = new Set(['heatx']);

/**
 * Whether the ceiling judges a path, given its mode.
 *
 * The browser runtime ships threaded wherever the page is cross-origin isolated, and the owner ruled
 * on 2026-10-30 that the ceiling judges the threaded paths only. Serial execution is the fallback for
 * a page without isolation, so its ratio is kept as a figure rather than a gate. Every mode the
 * archive workflow measures names its threading, so `threaded` in the mode is the whole test.
 *
 * @param {string} mode - The measured path's mode name.
 * @returns {boolean} True when the ceiling judges this path.
 */
export function isJudgedMode(mode) {
  return typeof mode === 'string' && mode.includes('threaded');
}

/**
 * Compare each measured path against one native baseline.
 *
 * @param {{ best: { runMilliseconds: number, milliseconds: number }, subject: string }} native - The baseline.
 * @param {ReadonlyArray<object>} measurements - One browser report per engine and path.
 * @returns {{ judged: boolean, passed: boolean, paths: object[] }} The judgement.
 */
export function judgePerformance(native, measurements) {
  const baseline = native.best.runMilliseconds;
  if (typeof baseline !== 'number') throw new Error('The baseline reported no geometry time');
  const judged = judgedSubjects.has(native.subject);
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
    const within = ratio <= runRatioCeiling;
    const gated = judged && isJudgedMode(measured.mode);
    return {
      engine: measured.engine,
      mode: measured.mode,
      // `recorded` is not a pass: it says this subject's ratio was measured and does not gate.
      status: gated ? (within ? 'passed' : 'failed') : 'recorded',
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
      ...(within
        ? {}
        : gated
          ? { reason: `Geometry time is ${ratio.toFixed(2)}x the matched native run` }
          : { note: `Geometry time is ${ratio.toFixed(2)}x the matched native run, recorded not gated` }),
    };
  });
  return {
    judged,
    // An unmeasured path fails whether or not the ceiling judges it, and a judged subject with no
    // threaded path measured has nothing the ceiling could pass.
    passed:
      paths.length > 0 &&
      paths.every((path) => path.status === 'passed' || path.status === 'recorded') &&
      (!judged || paths.some((path) => path.status === 'passed')),
    paths,
  };
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
    ceilingJudged: judgedSubjects.has(subject),
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
  console.log(
    `${subject}: ${report.passed ? 'passed' : 'FAILED'}${report.judged ? '' : ' (ratios recorded; the ceiling judges the long subject)'} -> ${path}`,
  );
  if (!report.passed) process.exitCode = 1;
}
