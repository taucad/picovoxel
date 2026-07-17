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

const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort();
if (files.length < 2) {
  console.log(`drift check: ${files.length} results file(s) — need a baseline plus a fresh run; nothing to compare.`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(join(resultsDir, files[0]), 'utf8'));
const latest = JSON.parse(readFileSync(join(resultsDir, files[files.length - 1]), 'utf8'));

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
  console.log(`drift check: ${files[files.length - 1]} within 2x of ${files[0]} on every phase.`);
  process.exit(0);
}

const body = `Benchmark drift >2x vs the committed baseline (${files[0]}):\n\n` +
  drifts.map((d) => `- ${d}`).join('\n') +
  `\n\nLatest: ${files[files.length - 1]} on ${latest.fingerprint.cpu}. ` +
  'CI numbers are canaries, not certification — reproduce on a quiet machine with `npm run bench`.';
console.error(body);

if (process.argv.includes('--open-issue')) {
  execFileSync('gh', ['issue', 'create', '--title', `bench drift >2x (${drifts.length} phases)`, '--body', body], {
    stdio: 'inherit',
  });
}
process.exit(1);
