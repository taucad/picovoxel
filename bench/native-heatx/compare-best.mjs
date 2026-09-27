// Seven-arm comparison for the best-case native campaign (2026-08-09):
// the three recorded arms (published / pristine-ourbuild / patched) plus the
// four arms this campaign added — mimalloc and tbbproxy (allocator alone, on
// the pristine dylib via DYLD_INSERT_LIBRARIES), u5 (patched + the
// tube-complex RenderLattice proposal, upstream/picogkruntime-tubecomplex-
// lattice.patch), and best (u5 + mimalloc).
//
// Effect axes, each a single-variable comparison:
//   pristine -> mimalloc / tbbproxy   allocator alone
//   patched  -> u5                    the U5 algorithm alone
//   u5       -> best                  allocator stacked on U5
//   patched / published -> best       the ceiling
//
//   node bench/native-heatx/compare-best.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBootstrapMedian } from '../stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../results/native');
const ARMS = ['published', 'pristine-ourbuild', 'patched', 'mimalloc', 'tbbproxy', 'u5', 'best'];
const SIZES = ['1', '0.9', '0.8', '0.7', '0.6', '0.5'];
// Per-size predictions of the u5 arm's wall time from a constant
// accelerated-share model, recorded before the sweep ran.
const PREDICTED_U5 = { 1: 7.03, 0.9: 7.8, 0.8: 8.9, 0.7: 10.6, 0.6: 13.6, 0.5: 18.7 };

const load = (label) => {
  const file = readdirSync(DIR)
    .filter((f) => f.startsWith(`native-heatx-${label}-`) && f.endsWith('.jsonl'))
    .sort()
    .at(-1);
  if (!file) return null;
  const rows = readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.ok);
  const bySize = new Map();
  for (const r of rows) {
    const k = String(r.voxelMM);
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(r);
  }
  return { file, rows, bySize };
};

// hostBusyPercentBefore in the 2026-08-09 u5 sweep contains wait-transcript
// lines before the real reading (run-sweep.sh bug, since fixed); the true
// pre-run value is always the LAST line of the field.
const busyOf = (r) => Number(String(r.hostBusyPercentBefore).trim().split('\n').at(-1));

const data = new Map(ARMS.map((a) => /** @type {const} */ ([a, load(a)])).filter(([, d]) => d));
const stat = (arm, size) => {
  const runs = data.get(arm)?.bySize.get(size);
  return runs ? summarizeBootstrapMedian(runs.map((r) => r.taskSeconds)) : null;
};
const f = (n, d = 2) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(d));
const geo = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

console.log('# Best-case native campaign — seven arms\n');
for (const [a, d] of data) {
  console.log(
    `- **${a}** — ${d.rows.length} runs · \`${d.file}\` · stamp \`${[...new Set(d.rows.map((r) => r.picoGKBuild))].join(' ; ')}\``,
  );
}

console.log('\n## Medians (taskSeconds, n=5 per cell)\n');
console.log('| voxel | ' + ARMS.join(' | ') + ' |');
console.log('| ---: |' + ARMS.map(() => ' ---: |').join(''));
for (const s of SIZES) {
  console.log(`| ${s} | ` + ARMS.map((a) => f(stat(a, s)?.median)).join(' | ') + ' |');
}

const pairs = [
  ['mimalloc alone', 'pristine-ourbuild', 'mimalloc'],
  ['tbbproxy alone', 'pristine-ourbuild', 'tbbproxy'],
  ['U5 alone', 'patched', 'u5'],
  ['alloc on U5', 'u5', 'best'],
  ['best vs patched', 'patched', 'best'],
  ['best vs published', 'published', 'best'],
];
console.log('\n## Effect ratios (baseline ÷ arm; >1 = arm faster)\n');
console.log('| voxel | ' + pairs.map(([n]) => n).join(' | ') + ' |');
console.log('| ---: |' + pairs.map(() => ' ---: |').join(''));
const acc = new Map(pairs.map(([n]) => [n, []]));
for (const s of SIZES) {
  const cells = pairs.map(([n, base, arm]) => {
    const b = stat(base, s),
      a = stat(arm, s);
    if (!b || !a) return '—';
    const r = b.median / a.median;
    acc.get(n).push(r);
    const sep = a.ci95.high < b.ci95.low ? '✓' : b.ci95.high < a.ci95.low ? '✗slower' : '·';
    return `${f(r)}×${sep}`;
  });
  console.log(`| ${s} | ` + cells.join(' | ') + ' |');
}
console.log(
  '| **geo** | ' +
    pairs.map(([n]) => (acc.get(n).length ? `**${f(geo(acc.get(n)))}×**` : '—')).join(' | ') +
    ' |',
);
console.log('\n(✓ = 95% CIs separated, · = overlapping, ✗ = separated the wrong way)');

console.log('\n## u5 vs pre-registered predictions\n');
console.log('| voxel | predicted u5 (s) | measured u5 (s) | error | measured speedup | predicted speedup |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
for (const s of SIZES) {
  const m = stat('u5', s)?.median,
    p = PREDICTED_U5[Number(s)],
    pat = stat('patched', s)?.median;
  if (!m || !pat) continue;
  console.log(`| ${s} | ${f(p)} | ${f(m)} | ${f((m / p - 1) * 100, 1)}% | ${f(pat / m)}× | ${f(pat / p)}× |`);
}

console.log('\n## STL byte identity (byte COUNT per arm per size; content gates live in compare-stl.mjs)\n');
for (const s of SIZES) {
  const groups = new Map();
  for (const a of ARMS) {
    const rows = data.get(a)?.bySize.get(s);
    if (!rows) continue;
    const set = new Set(rows.map((r) => r.stlBytes));
    const key = [...set].join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(set.size === 1 ? a : `${a}(NONUNIFORM!)`);
  }
  console.log(`${s}mm: ` + [...groups.entries()].map(([k, arms]) => `[${arms.join(',')}]=${k}`).join('  '));
}

console.log('\n## Host load + provenance per new arm\n');
for (const a of ARMS.slice(3)) {
  const d = data.get(a);
  if (!d) continue;
  const busy = d.rows.map(busyOf).sort((x, y) => x - y);
  const allocs = new Set(d.rows.map((r) => `${r.allocator}|${r.dyldInsert}`));
  console.log(
    `${a}: busy median ${f(busy[Math.floor(busy.length / 2)], 1)}%, range ${f(busy[0], 1)}–${f(busy.at(-1), 1)}%, alloc=${[...allocs].join(' ; ')}`,
  );
}
