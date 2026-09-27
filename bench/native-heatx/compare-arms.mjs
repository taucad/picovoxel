// Three-arm native comparison: published binary vs our pristine build vs our
// patched build.
//
// The control arm is the whole point. Comparing our patched build straight
// against LEAP 71's published dylib would fold two different things into one
// number — our source patches AND our build environment (different toolchain,
// USE_BLOSC=OFF, homebrew TBB/boost rather than the bundled dylibs). Building
// pristine sources with OUR flags isolates that, so:
//
//   published  -> pristine   = build-environment delta (not our work)
//   pristine   -> patched    = our patches, cleanly attributed
//
//   node bench/native-heatx/compare-arms.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBootstrapMedian } from '../stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../results/native');

const ARMS = [
  ['published', 'published binary (PicoGK/native/osx-arm64)'],
  ['pristine-ourbuild', 'pristine sources, our build flags'],
  ['patched', 'picovoxel patches, our build flags'],
];

const PUBLISHED_TABLE = { 1: 34, 0.9: 38, 0.8: 44, 0.7: 54, 0.6: 72, 0.5: 98 };

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

const data = new Map();
for (const [label] of ARMS) {
  const d = load(label);
  if (d) data.set(label, d);
}
if (data.size === 0) throw new Error(`no arm data in ${DIR}`);

const sizes = [...(data.get(ARMS[0][0]) ?? [...data.values()][0]).bySize.keys()].sort(
  (a, b) => Number(b) - Number(a),
);
const stat = (label, size) => {
  const runs = data.get(label)?.bySize.get(size);
  return runs ? summarizeBootstrapMedian(runs.map((r) => r.taskSeconds)) : null;
};
const f = (n, d = 2) => (n === null || n === undefined ? '—' : n.toFixed(d));

console.log('# Native PicoGK HeatX — do our patches help the native build?\n');
for (const [label, desc] of ARMS) {
  const d = data.get(label);
  if (!d) continue;
  const build = d.rows[0].picoGKBuild;
  console.log(`- **${label}** — ${desc} · ${d.rows.length} runs · library build \`${build}\``);
}

console.log('\n## Task seconds by arm (median of 5, 95% CI)\n');
console.log(
  '| voxel (mm) | published | pristine (our build) | patched (our build) | patched vs pristine | patched vs published | STL identical? |',
);
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
const gains = [];
for (const size of sizes) {
  const pub = stat('published', size);
  const pri = stat('pristine-ourbuild', size);
  const pat = stat('patched', size);
  const gain = pri && pat ? pri.median / pat.median : null;
  if (gain) gains.push(gain);
  const stls = new Set(
    ARMS.map(([l]) => data.get(l)?.bySize.get(size)?.[0]?.stlBytes).filter((v) => v !== undefined),
  );
  console.log(
    `| ${size} | ${f(pub?.median)} | ${f(pri?.median)} | ${f(pat?.median)} ` +
      `| ${gain ? `**${f(gain)}×**` : '—'} | ${pub && pat ? `${f(pub.median / pat.median)}×` : '—'} ` +
      `| ${stls.size === 1 ? `yes (${[...stls][0]} B)` : `NO — ${[...stls].join(' / ')}`} |`,
  );
}
if (gains.length) {
  const geo = Math.exp(gains.reduce((s, g) => s + Math.log(g), 0) / gains.length);
  console.log(
    `\n**Patch effect (geometric mean over sizes): ${f(geo)}×** vs the pristine control built with identical flags.`,
  );
}

console.log('\n## Confidence intervals (do the arms actually separate?)\n');
console.log('| voxel (mm) | pristine 95% CI | patched 95% CI | separated? |');
console.log('| ---: | :--- | :--- | :--- |');
for (const size of sizes) {
  const pri = stat('pristine-ourbuild', size);
  const pat = stat('patched', size);
  if (!pri || !pat) continue;
  const sep =
    pat.ci95.high < pri.ci95.low
      ? 'yes — patched faster'
      : pri.ci95.high < pat.ci95.low
        ? 'yes — patched SLOWER'
        : 'no — overlapping';
  console.log(
    `| ${size} | [${f(pri.ci95.low)}, ${f(pri.ci95.high)}] | [${f(pat.ci95.low)}, ${f(pat.ci95.high)}] | ${sep} |`,
  );
}

console.log('\n## Against the published MacBook Air table\n');
console.log('| voxel (mm) | published table (MBA) | best native here | machine + patch ratio |');
console.log('| ---: | ---: | ---: | ---: |');
for (const size of sizes) {
  const best = [stat('published', size), stat('pristine-ourbuild', size), stat('patched', size)]
    .filter(Boolean)
    .reduce((a, b) => (a.median <= b.median ? a : b));
  const mba = PUBLISHED_TABLE[Number(size)];
  console.log(`| ${size} | ${mba ?? '—'} | ${f(best.median)} | ${mba ? `${f(mba / best.median)}×` : '—'} |`);
}
