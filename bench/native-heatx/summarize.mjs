// Summarize the native PicoGK HeatX sweep against the published table.
//
// The question this answers: how does THIS machine compare to the MacBook Air
// LEAP 71 published their voxel-size/time table on? Every prior wasm-vs-native
// statement in this repo leaned on that published column, which is a different
// machine running a different build — this replaces it with a same-machine,
// same-fixture, same-published-binary denominator.
//
//   node bench/native-heatx/summarize.mjs [results.jsonl]

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBootstrapMedian } from '../stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// LEAP71_HelixHeatX/Documentation/table.png — "on a MacBook Air", the Task
// including previews, screenshots and the STL export (README §"Choosing a
// voxel size"). STL sizes are the published decimal-MB column.
const PUBLISHED = {
  '1': { seconds: 34, stlMB: 94 },
  '0.9': { seconds: 38, stlMB: 122 },
  '0.8': { seconds: 44, stlMB: 166 },
  '0.7': { seconds: 54, stlMB: 227 },
  '0.6': { seconds: 72, stlMB: 328 },
  '0.5': { seconds: 98, stlMB: 502 },
};

// bench/BENCHMARKS.md §R11 (heatx-sweep-2026-07-18-85d283b.json) — picovoxel
// wasm, PRE-acceleration, same fixture ported to TS. Kept here so the native
// column can be read next to the wasm one it was always being compared to.
const WASM_PRE = {
  '1': { single: 61.8, multi: 38.2 },
  '0.9': { single: 81.8, multi: 43.1 },
  '0.8': { single: 103.9, multi: 49.7 },
  '0.7': { single: 151.1, multi: 73.1 },
  '0.6': { single: 262.2, multi: 95.0 },
  '0.5': { single: 420.9, multi: 133.0 },
};

const path =
  process.argv[2] ??
  join(
    HERE,
    '../results/native',
    readdirSync(join(HERE, '../results/native'))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .at(-1) ?? '',
  );

const rows = readFileSync(resolve(path), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const ok = rows.filter((r) => r.ok);
const failed = rows.length - ok.length;

const bySize = new Map();
for (const row of ok) {
  const key = String(row.voxelMM);
  if (!bySize.has(key)) bySize.set(key, []);
  bySize.get(key).push(row);
}

const sizes = [...bySize.keys()].sort((a, b) => Number(b) - Number(a));
const fmt = (n, d = 1) => n.toFixed(d);

console.log(`# Native PicoGK HeatX — this machine vs the published table\n`);
console.log(`records: ${rows.length} (${failed} failed) · source: ${path}`);
const first = ok[0];
if (first) {
  console.log(
    `host: ${first.processorCount} cores · ${first.os} · .NET ${first.runtime} · ` +
      `${first.picoGKLib} (build ${first.picoGKBuild})\n`,
  );
}

console.log(
  '| voxel (mm) | n | native median (s) | 95% CI | min–max | MAD | published (s) | machine ratio | STL (MB) | published STL |',
);
console.log('| ---: | ---: | ---: | :--- | :--- | ---: | ---: | ---: | ---: | ---: |');

const ratios = [];
for (const size of sizes) {
  const runs = bySize.get(size);
  const stat = summarizeBootstrapMedian(runs.map((r) => r.taskSeconds));
  const pub = PUBLISHED[size];
  const stlMB = runs[0].stlBytes / 1e6;
  const ratio = pub ? pub.seconds / stat.median : null;
  if (ratio) ratios.push(ratio);
  console.log(
    `| ${size} | ${runs.length} | **${fmt(stat.median, 2)}** | [${fmt(stat.ci95.low, 2)}, ${fmt(stat.ci95.high, 2)}] ` +
      `| ${fmt(stat.min, 2)}–${fmt(stat.max, 2)} | ${fmt(stat.mad, 2)} ` +
      `| ${pub ? pub.seconds : '—'} | ${ratio ? `**${fmt(ratio, 2)}×**` : '—'} ` +
      `| ${fmt(stlMB, 1)} | ${pub ? pub.stlMB : '—'} |`,
  );
}

const geoMean = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
console.log(
  `\n**Machine calibration factor: ${fmt(geoMean, 2)}×** (geometric mean of per-size ratios; ` +
    `>1 means this machine is faster than the published MacBook Air on the same fixture).`,
);

console.log(`\n## Same fixture, three builds\n`);
console.log('| voxel (mm) | native here (s) | wasm multi pre-accel (s) | wasm single pre-accel (s) | published MBA (s) | wasm-multi ÷ native |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
for (const size of sizes) {
  const stat = summarizeBootstrapMedian(bySize.get(size).map((r) => r.taskSeconds));
  const w = WASM_PRE[size];
  const pub = PUBLISHED[size];
  console.log(
    `| ${size} | ${fmt(stat.median, 2)} | ${w ? w.multi : '—'} | ${w ? w.single : '—'} | ${pub ? pub.seconds : '—'} ` +
      `| ${w ? `${fmt(w.multi / stat.median, 2)}×` : '—'} |`,
  );
}

// Per-run detail, so any outlier is visible rather than smoothed into a median.
console.log(`\n## Per-run task seconds\n`);
console.log('| voxel (mm) | ' + [...Array(Math.max(...[...bySize.values()].map((v) => v.length)))].map((_, i) => `run ${i + 1}`).join(' | ') + ' |');
console.log('| ---: |' + [...Array(Math.max(...[...bySize.values()].map((v) => v.length)))].map(() => ' ---: |').join(''));
for (const size of sizes) {
  const runs = bySize.get(size).sort((a, b) => a.run - b.run);
  console.log(`| ${size} | ${runs.map((r) => fmt(r.taskSeconds, 2)).join(' | ')} |`);
}
