// R26/R27 — compares the newest bench results against the committed baseline and
// (optionally) opens a GitHub issue on >2x median drift. Never gates a build:
// CI load characteristics make absolute numbers untrustworthy — this is an
// order-of-magnitude canary only (quality doc, Finding 4).
//
// Usage: node bench/check-drift.mjs [--open-issue]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(HERE, 'bench/results');

// Only bench/run.mjs records (`YYYY-MM-DD-<sha>.json`) are comparable; other
// JSON in bench/results (sweeps, native runs) has another schema. The baseline is
// the newest COMMITTED record; the fresh record is the one this run wrote, which
// git does not track yet.
const RECORD = /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.json$/;
const tracked = new Set(
  execFileSync('git', ['ls-files', '--', 'bench/results'], { cwd: HERE, encoding: 'utf8' })
    .split('\n')
    .map((path) => path.slice('bench/results/'.length)),
);
const records = readdirSync(resultsDir).filter((f) => RECORD.test(f)).sort();
const baselineFile = records.filter((f) => tracked.has(f)).at(-1);
const latestFile = records.filter((f) => !tracked.has(f)).at(-1);
if (!baselineFile || !latestFile) {
  console.log(`drift check: need a committed baseline and a fresh run (baseline ${baselineFile}, fresh ${latestFile}); nothing to compare.`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(join(resultsDir, baselineFile), 'utf8'));
const latest = JSON.parse(readFileSync(join(resultsDir, latestFile), 'utf8'));

const drifts = [];
for (const [id, entry] of Object.entries(latest.results)) {
  const base = baseline.results[id];
  if (!base) continue;
  for (const [phase, sample] of Object.entries(entry.phases)) {
    const baseMedian = base.phases[phase]?.medianMs;
    if (!baseMedian || baseMedian < 0.5) continue; // sub-ms phases are noise-dominated
    const ratio = sample.medianMs / baseMedian;
    if (ratio > 2) drifts.push(`${id}/${phase}: ${baseMedian}ms -> ${sample.medianMs}ms (${ratio.toFixed(1)}x)`);
  }
}

if (drifts.length === 0) {
  console.log(`drift check: ${latestFile} within 2x of ${baselineFile} on every phase.`);
  process.exit(0);
}

const body = `Benchmark drift >2x vs the committed baseline (${baselineFile}):\n\n` +
  drifts.map((d) => `- ${d}`).join('\n') +
  `\n\nLatest: ${latestFile} on ${latest.fingerprint.cpu}. ` +
  'CI numbers are canaries, not certification — reproduce on a quiet machine with `pnpm run bench`.';
console.error(body);

if (process.argv.includes('--open-issue')) {
  const title = `bench drift >2x (${drifts.length} phases)`;
  execFileSync('gh', ['issue', 'create', '--label', 'claude', '--title', title, '--body', body], {
    stdio: 'inherit',
  });
}
process.exit(1);
