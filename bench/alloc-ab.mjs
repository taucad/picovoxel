// SK-0.1 — allocator A/B delta table (dlmalloc vs mimalloc).
//
// bench/run.mjs measures whatever pico{,-multi}.{mjs,wasm} pair sits in src/, so
// the two allocator sides cannot be sampled inside one process. The ABAB protocol
// is therefore: swap artifacts, run, swap back, run — then pair the resulting
// files here. Blocks alternate so thermal drift lands on both sides equally.
//
// Pairing is by sample INDEX within a phase, which is what makes the CI a paired
// statistic: repeat i of A and repeat i of B ran in adjacent blocks under the same
// machine conditions. Ratio CI comes from stats.mjs's log-ratio bootstrap; a CI
// that straddles 1.0 means the fixture showed no allocator effect worth claiming.
//
// Usage: node bench/alloc-ab.mjs <aFiles> <bFiles>   (comma-separated, block order)
//   e.g. node bench/alloc-ab.mjs run-a1.json,run-a2.json run-b1.json,run-b2.json

import { readFileSync } from 'node:fs';
import { summarizePairedSamples } from './stats.mjs';

const [aArg, bArg] = process.argv.slice(2);
if (!aArg || !bArg) {
  console.error('usage: node bench/alloc-ab.mjs <aFiles,...> <bFiles,...>');
  process.exit(1);
}

const load = (arg) => arg.split(',').map((f) => JSON.parse(readFileSync(f.trim(), 'utf8')));
const [aRuns, bRuns] = [load(aArg), load(bArg)];

// Samples for one phase, concatenated across that side's blocks in run order.
const samplesFor = (runs, id, phase) =>
  runs.flatMap((run) => run.results[id]?.phases[phase]?.samplesMs ?? []);

const rows = [];
const skipped = [];
for (const [id, entry] of Object.entries(aRuns[0].results)) {
  for (const phase of Object.keys(entry.phases)) {
    const slowMs = samplesFor(aRuns, id, phase);
    const fastMs = samplesFor(bRuns, id, phase);
    if (slowMs.length === 0 || slowMs.length !== fastMs.length) {
      skipped.push(`${id}/${phase} (A=${slowMs.length} B=${fastMs.length} samples)`);
      continue;
    }
    // slow/fast is naming only — a ratio below 1.0 is a mimalloc regression and
    // is reported as such rather than reordered to look like a win.
    const paired = summarizePairedSamples({ slowMs, fastMs });
    rows.push({
      id,
      phase,
      aMedian: paired.slow.median,
      bMedian: paired.fast.median,
      ratio: paired.medianRatio,
      ciLow: paired.ci95.low,
      ciHigh: paired.ci95.high,
      deltaPct: (paired.fast.median / paired.slow.median - 1) * 100,
      significant: paired.ci95.low > 1 || paired.ci95.high < 1,
    });
  }
}

const f = (n, d = 3) => n.toFixed(d);
console.log(
  '| metric | phase | dlmalloc median (ms) | mimalloc median (ms) | Δ% | speedup (A/B) | 95% CI | verdict |',
);
console.log('| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |');
for (const r of rows) {
  const verdict = !r.significant ? 'no effect' : r.ratio > 1 ? 'faster' : '**REGRESSION**';
  console.log(
    `| ${r.id} | ${r.phase} | ${f(r.aMedian)} | ${f(r.bMedian)} | ${r.deltaPct > 0 ? '+' : ''}${f(r.deltaPct, 1)}% ` +
      `| ${f(r.ratio, 3)}× | ${f(r.ciLow, 3)}–${f(r.ciHigh, 3)} | ${verdict} |`,
  );
}

const regressions = rows.filter((r) => r.significant && r.ratio < 1);
const wins = rows.filter((r) => r.significant && r.ratio > 1);
console.log(
  `\n${rows.length} phases compared: ${wins.length} faster, ${regressions.length} regressions, ` +
    `${rows.length - wins.length - regressions.length} no measurable effect.`,
);
for (const r of regressions)
  console.log(`REGRESSION ${r.id}/${r.phase}: ${f(r.ratio, 3)}× (${f(r.deltaPct, 1)}%)`);
if (skipped.length > 0)
  console.log(`\nskipped (sample-count mismatch):\n${skipped.map((s) => `  ${s}`).join('\n')}`);
