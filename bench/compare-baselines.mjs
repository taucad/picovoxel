// SK-0 exit — compare two baseline records taken at DIFFERENT times.
//
// Not the same job as bench/alloc-ab.mjs. That one pairs sample i of A with
// sample i of B because the blocks were interleaved minutes apart, which is what
// licenses a paired log-ratio CI. Two baselines taken days apart share no such
// pairing: repeat 3 of July's run and repeat 3 of today's run have nothing in
// common, so pairing them would manufacture precision that the experiment never
// had.
//
// So this reports the ratio of medians with a CONSERVATIVE interval built from
// each side's own independent bootstrap CI:
//
//   ratio = oldMedian / newMedian            (> 1 = the new record is faster)
//   interval = [oldCiLow / newCiHigh, oldCiHigh / newCiLow]
//
// That interval is wider than a paired one would be — it is the worst case over
// both CIs jointly — and a phase is called significant only when it excludes
// 1.0. Wide-but-honest is the right trade for a scorecard: an unpaired
// cross-day comparison also carries machine drift that no CI can see.
//
// Usage: node bench/compare-baselines.mjs <old.json> <new.json> [--all]

import { readFileSync } from 'node:fs';

const [oldFile, newFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showAll = process.argv.includes('--all');
if (!oldFile || !newFile) {
  console.error('usage: node bench/compare-baselines.mjs <old.json> <new.json> [--all]');
  process.exit(1);
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const [before, after] = [read(oldFile), read(newFile)];

const rows = [];
const missing = [];
for (const [id, entry] of Object.entries(before.results)) {
  for (const [phase, o] of Object.entries(entry.phases)) {
    const n = after.results[id]?.phases[phase];
    if (!n) {
      missing.push(`${id}/${phase}`);
      continue;
    }
    const ratio = o.medianMs / n.medianMs;
    const low = o.ci95LowMs / n.ci95HighMs;
    const high = o.ci95HighMs / n.ci95LowMs;
    rows.push({
      id,
      phase,
      oldMs: o.medianMs,
      newMs: n.medianMs,
      ratio,
      low,
      high,
      significant: low > 1 || high < 1,
    });
  }
}

const f = (n, d = 3) => n.toFixed(d);
const shown = showAll ? rows : rows.filter((r) => r.significant);
console.log('| metric | phase | old (ms) | new (ms) | Δ% | speedup | 95% CI (conservative) | verdict |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |');
for (const r of shown.sort((a, b) => b.ratio - a.ratio)) {
  const verdict = !r.significant ? 'no effect' : r.ratio > 1 ? 'faster' : '**REGRESSION**';
  const pct = (r.newMs / r.oldMs - 1) * 100;
  console.log(
    `| ${r.id} | ${r.phase} | ${f(r.oldMs)} | ${f(r.newMs)} | ${pct > 0 ? '+' : ''}${f(pct, 1)}% ` +
      `| ${f(r.ratio)}× | ${f(r.low)}–${f(r.high)} | ${verdict} |`,
  );
}

const wins = rows.filter((r) => r.significant && r.ratio > 1);
const losses = rows.filter((r) => r.significant && r.ratio < 1);
console.log(
  `\n${rows.length} phases compared: ${wins.length} faster, ${losses.length} regressions, ` +
    `${rows.length - wins.length - losses.length} no measurable effect.`,
);
for (const r of losses)
  console.log(`REGRESSION ${r.id}/${r.phase}: ${f(r.ratio)}× (CI ${f(r.low)}–${f(r.high)})`);
if (missing.length > 0)
  console.log(`\nabsent from the new record:\n${missing.map((m) => `  ${m}`).join('\n')}`);
