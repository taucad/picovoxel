// SK-0 exit — merge same-allocator bench blocks into one baseline record.
//
// bench/run.mjs writes one file per block. A baseline wants every block's samples
// under one set of statistics (SK-0.1 shipped 20 samples/phase from two blocks),
// so this concatenates samplesMs in block order and recomputes the bootstrap
// summary over the pooled samples — the same summarizeBootstrapMedian the harness
// itself uses, so a merged file is shaped exactly like a single-block one.
//
// Identity is the free correctness check: every block must report the SAME
// identity object per metric. Two blocks of one allocator that disagree on a
// volume hex or an STL hash are a determinism break, and merging them would
// average it away — so that is a hard failure here, not a warning.
//
// Usage: node bench/merge-blocks.mjs <out.json> <block1.json> <block2.json> [...]

import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeBootstrapMedian } from './stats.mjs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: node bench/merge-blocks.mjs <out.json> <block.json>...');
  process.exit(1);
}

const blocks = inputs.map((file) => ({ file, data: JSON.parse(readFileSync(file, 'utf8')) }));
const [first] = blocks;

// The wasm under test must be the same artifact in every block, or the merge is
// comparing two different libraries and calling the result a baseline.
for (const { file, data } of blocks) {
  if (data.fingerprint.wasmSha256 !== first.data.fingerprint.wasmSha256) {
    console.error(`REFUSED: ${file} has wasmSha256 ${data.fingerprint.wasmSha256}, expected ${first.data.fingerprint.wasmSha256}`);
    process.exit(1);
  }
}

const results = {};
for (const [id, entry] of Object.entries(first.data.results)) {
  const identity = JSON.stringify(entry.identity);
  const phases = {};
  for (const phase of Object.keys(entry.phases)) {
    const pooled = blocks.flatMap(({ file, data }) => {
      const samples = data.results[id]?.phases[phase]?.samplesMs;
      if (!samples) {
        console.error(`REFUSED: ${file} is missing ${id}/${phase}`);
        process.exit(1);
      }
      return samples;
    });
    const summary = summarizeBootstrapMedian(pooled);
    phases[phase] = {
      medianMs: +summary.median.toFixed(3),
      minMs: +summary.min.toFixed(3),
      maxMs: +summary.max.toFixed(3),
      madMs: +summary.mad.toFixed(3),
      p95Ms: +summary.p95.toFixed(3),
      ci95LowMs: +summary.ci95.low.toFixed(3),
      ci95HighMs: +summary.ci95.high.toFixed(3),
      samplesMs: summary.samples.map((sample) => +sample.toFixed(3)),
    };
  }
  for (const { file, data } of blocks) {
    const other = JSON.stringify(data.results[id]?.identity);
    if (other !== identity) {
      console.error(`REFUSED: identity drift in ${id} — ${file} reports ${other}, expected ${identity}`);
      process.exit(1);
    }
  }
  results[id] = {
    description: entry.description,
    phases,
    identity: entry.identity,
    loadBefore: blocks.map(({ data }) => data.results[id].loadBefore),
    loadAfter: blocks.map(({ data }) => data.results[id].loadAfter),
  };
}

const fingerprint = {
  ...first.data.fingerprint,
  mergedFrom: inputs,
  blockDates: blocks.map(({ data }) => data.fingerprint.date),
  startLoads: blocks.map(({ data }) => data.fingerprint.startLoad),
};
writeFileSync(out, JSON.stringify({ fingerprint, results }, null, 2) + '\n');

const perPhase = Object.values(results)[0];
console.log(
  `merged ${blocks.length} blocks -> ${out} ` +
    `(${Object.keys(results).length} metrics, ${Object.values(perPhase.phases)[0].samplesMs.length} samples/phase)`,
);
