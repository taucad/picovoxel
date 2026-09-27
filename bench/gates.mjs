// The verdicts behind the performance gates: the one wall-clock pull request
// benchmark (bench/gated.mjs, the `benchmark` job in ci.yml; close-out D32,
// create-repo §5.2) and the monthly drift canary (bench/check-drift.mjs,
// bench.yml). Pure functions of recorded results, so they are unit-tested
// (test/gates.test.mjs) and measured by the coverage gate; the timing runs stay
// in the drivers.

import { compareG0 } from './g0-compare.mjs';
import { summarizeSamples } from './stats.mjs';

/** Keys the one pull request comment the `benchmark` job keeps up to date. */
export const MARKER = '<!-- picovoxel-benchmark -->';

/** NanoRaster's gate (`compare-benchmark.mjs:6`), and the floor under every calibrated threshold. */
export const THRESHOLD_FLOOR = 0.1;

/**
 * The hardware a threshold or a drift baseline is valid for: platform,
 * architecture and core count. Wall time on a 2-vCPU private runner is roughly
 * twice that on the 4-vCPU public one, while the CPU model inside one hosted
 * class changes from run to run; ABAB pairing on one runner absorbs the model.
 * @param {{ platform: string, arch?: string, cores: number }} host
 */
export const hardwareClass = ({ platform, arch, cores }) => `${platform}-${arch ?? 'unknown'}-${cores}cpu`;

/** The calibrated threshold for an A/A spread: max(10%, 2 × spread) (close-out D32). */
export const thresholdFor = (aaSpread) => Math.max(THRESHOLD_FLOOR, 2 * aaSpread);

/**
 * Threshold per hardware class. A class with no entry is report-only: the
 * timing verdict is printed but never fails, while a G0 tuple change always
 * fails. An entry is added only from an A/A run on that class (a manual
 * `workflow_dispatch` of ci.yml runs the benchmark with main against itself),
 * with its origin beside it. The public flip (G7) moves CI to 4-vCPU runners,
 * a new class that needs its own A/A run.
 * @type {Record<string, { threshold: number }>}
 */
export const CALIBRATION = {};

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const percent = (ratio) => `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`;

/**
 * The verdict and pull request comment for one `bench/gated.mjs` result.
 * - No comparable main benchmark (absent, or renamed): the benchmark is admitted
 *   as new and nothing fails.
 * - Otherwise the G0 tuples must match (fail-closed: a geometry change is
 *   admitted only by renaming the benchmark), then the median change is judged
 *   against the class threshold, or reported only when the class is uncalibrated.
 * - An A/A result (main against itself) reports the spread that calibrates the
 *   class; only a tuple mismatch fails it, since that is nondeterminism.
 * @param {{ name: string, class: string, aa?: boolean, head: { samplesMs: number[], fingerprint: object, sha?: string },
 *   base: null | { name: string, samplesMs: number[], fingerprint: object, sha?: string }, baseReason?: string }} result
 * @param {Record<string, { threshold: number }>} [calibration]
 */
export function compareGated(result, calibration = CALIBRATION) {
  const head = summarizeSamples(result.head.samplesMs);
  const header = `${MARKER}\n### Benchmark\n\n`;
  const footer = `\n\nMedian of ${head.samples.length} per tree after one warm-up, interleaved on one \`${result.class}\` runner.`;
  if (!result.base || result.base.name !== result.name) {
    const reason = result.base
      ? `renamed from \`${result.base.name}\``
      : (result.baseReason ?? 'main has no gated benchmark');
    return {
      failed: false,
      markdown: `${header}New benchmark admitted: \`${result.name}\` (${reason}), ${seconds(head.median)} median.${footer}`,
    };
  }
  const base = summarizeSamples(result.base.samplesMs);
  const differing = compareG0(result.head.fingerprint, result.base.fingerprint);
  if (differing.length > 0) {
    return {
      failed: true,
      markdown:
        `${header}The G0 tuple of \`${result.name}\` changed on ${differing.map((field) => `\`${field}\``).join(', ')}` +
        `${result.aa ? ' between two runs of one tree: the benchmark is nondeterministic.' : '. Rename the benchmark only when the geometry change is intentional.'}`,
    };
  }
  const change = (head.median - base.median) / base.median;
  const threshold = calibration[result.class]?.threshold;
  const limit = result.aa
    ? `A/A: spread ${percent(Math.abs(change))} calibrates \`${result.class}\` at ${percent(thresholdFor(Math.abs(change)))}`
    : threshold === undefined
      ? `report-only: \`${result.class}\` has no A/A calibration`
      : `+${(threshold * 100).toFixed(1)}%`;
  const cell = (stats) => `${seconds(stats.median)} (MAD ${seconds(stats.mad)})`;
  return {
    failed: !result.aa && threshold !== undefined && change > threshold,
    markdown:
      `${header}| Benchmark | main${result.base.sha ? ` \`${result.base.sha.slice(0, 7)}\`` : ''} | ${result.aa ? 'main again' : 'PR'} | Change | Limit |\n` +
      '| --- | ---: | ---: | ---: | --- |\n' +
      `| \`${result.name}\` | ${cell(base)} | ${cell(head)} | ${percent(change)} | ${limit} |\n\n` +
      `G0 tuple identical on both trees.${footer}`,
  };
}

/**
 * The newest committed `bench/run.mjs` record measured on the same hardware
 * class as the fresh one, or undefined: comparing a 2-vCPU runner with the
 * 12-core workstation baseline reports hardware, not drift. Records from
 * before `arch` was recorded match on platform and cores alone.
 * @param {{ file: string, fingerprint: { os: string, arch?: string, cores: number } }[]} committed sorted oldest first
 * @param {{ os: string, arch?: string, cores: number }} fresh
 */
export function selectBaseline(committed, fresh) {
  const platform = (os) => os.split(' ')[0];
  return committed.findLast(
    ({ fingerprint }) =>
      platform(fingerprint.os) === platform(fresh.os) &&
      fingerprint.cores === fresh.cores &&
      (fingerprint.arch === undefined || fingerprint.arch === fresh.arch),
  );
}

/**
 * Phases of the fresh record slower than `ratio` × the baseline median.
 * Sub-millisecond baseline phases are timer noise and are skipped, as are
 * metrics the baseline lacks (a renamed metric is new, never a drift).
 */
export function findDrifts(baseline, latest, ratio = 2) {
  const drifts = [];
  for (const [id, entry] of Object.entries(latest.results)) {
    const base = baseline.results[id];
    if (!base) continue;
    for (const [phase, sample] of Object.entries(entry.phases)) {
      const baseMedian = base.phases[phase]?.medianMs;
      if (!baseMedian || baseMedian < 0.5) continue;
      const drift = sample.medianMs / baseMedian;
      if (drift > ratio)
        drifts.push(`${id}/${phase}: ${baseMedian}ms -> ${sample.medianMs}ms (${drift.toFixed(1)}x)`);
    }
  }
  return drifts;
}
