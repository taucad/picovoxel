// The monthly drift canary (bench.yml): compares the fresh bench/run.mjs record
// with the newest COMMITTED record measured on the same hardware class
// (platform, architecture and core count; bench/gates.mjs). Never gates a
// build: CI load makes absolute numbers untrustworthy, so this catches only
// order-of-magnitude regressions (any phase over 2x its baseline median).
//
// A class with no committed baseline has nothing to compare: the check says so
// and passes, and committing the uploaded record under bench/results/ arms it.
// That is the state after any runner change, such as the public flip from 2 to
// 4 vCPU; comparing a runner with the 12-core workstation baselines would
// report the hardware every month, not drift.
//
// Exit 1 = drift; bench.yml then opens or updates one `claude`-labelled issue.
//
// Usage: node bench/check-drift.mjs

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDrifts, selectBaseline } from './gates.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(HERE, 'bench/results');

// Only bench/run.mjs records (`YYYY-MM-DD-<sha>.json`) are comparable; other
// JSON in bench/results (sweeps, native runs) has another schema. The fresh
// record is the one this run wrote, which git does not track yet.
const RECORD = /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.json$/;
const tracked = new Set(
  execFileSync('git', ['ls-files', '--', 'bench/results'], { cwd: HERE, encoding: 'utf8' })
    .split('\n')
    .map((path) => path.slice('bench/results/'.length)),
);
const read = (file) => JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
const records = readdirSync(resultsDir)
  .filter((file) => RECORD.test(file))
  .sort();
const latestFile = records.filter((file) => !tracked.has(file)).at(-1);
if (!latestFile) {
  console.log('drift check: no fresh bench/run.mjs record to compare.');
  process.exit(0);
}
const latest = read(latestFile);
const committed = records
  .filter((file) => tracked.has(file))
  .map((file) => ({ file, fingerprint: read(file).fingerprint }));
const baseline = selectBaseline(committed, latest.fingerprint);
const host = `${latest.fingerprint.cpu} x${latest.fingerprint.cores}, ${latest.fingerprint.os}, ${latest.fingerprint.arch}`;
if (!baseline) {
  console.log(
    `drift check: no committed baseline for this hardware class (${host}); nothing to compare. ` +
      `Commit ${latestFile} from the run's artifact under bench/results/ to arm the canary for it.`,
  );
  process.exit(0);
}

const drifts = findDrifts(read(baseline.file), latest);
if (drifts.length === 0) {
  console.log(`drift check: ${latestFile} within 2x of ${baseline.file} on every phase (${host}).`);
  process.exit(0);
}
console.error(
  `Benchmark drift >2x vs the committed baseline ${baseline.file} (${host}):\n\n` +
    drifts.map((drift) => `- ${drift}`).join('\n') +
    '\n\nCI numbers are canaries, not certification: reproduce on a quiet machine with `pnpm run bench`.',
);
process.exit(1);
