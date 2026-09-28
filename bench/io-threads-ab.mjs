// Paired A/B harness for io-threads Tier 1 (PV-IO1): the HelixHeatX
// kernel:io-threads.create stage, which is HelixHeatX.ioThreads() — four BasePipe
// collars, each tessellated, built into one mesh and voxelized through
// Voxels_RenderMesh, then unioned.
//
// Usage: node --expose-gc bench/io-threads-ab.mjs <serial|multi> <iterations> <label>=<root> <label>=<root>
//   Each root is a built checkout (its dist/ and examples/): the baseline commit
//   and the candidate. Both load into ONE process as two wasm instances, and the
//   stage runs alternate A B, B A, … so each paired sample shares machine state;
//   the verdict is the median of the per-pair ratios, with the 1-minute load
//   average recorded beside every pair. On a shared machine this is the only
//   honest shape: separate processes minutes apart measure the load, not the change.
//
// Wall time is the metric. Process CPU time (user + system) is recorded beside it:
// for the serial entry it is far less sensitive to other load on the machine, for
// the multi entry it is total work, not latency. The stage leaves its meshes and
// intermediate voxels to the garbage collector, so every stage run is followed by a
// forced collection and a turn of the event loop, letting the finalizers free the
// wasm memory before the next run (without it two instances exhaust wasm32's 4 GiB).
//
// Identity oracle: the canonical grid hash and the hex-float volume must be equal
// across every repeat of a tree and across the two trees, or the run fails.
// Prints one JSON object; it does not touch bench/BENCHMARKS.md.
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, iterationsArg, ...specs] = process.argv.slice(2);
const iterations = Number(iterationsArg);
if (!['serial', 'multi'].includes(entry) || !(iterations > 0) || specs.length !== 2 || !globalThis.gc) {
  console.error(
    'usage: node --expose-gc bench/io-threads-ab.mjs <serial|multi> <iterations> <label>=<root> <label>=<root>',
  );
  process.exit(2);
}

const f64hex = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const trees = [];
for (const spec of specs) {
  const [label, root] = spec.split('=');
  const url = (path) => pathToFileURL(resolve(root, path)).href;
  const { createPico } = await import(url(entry === 'multi' ? 'dist/multi.js' : 'dist/index.js'));
  const { HelixHeatX } = await import(url('examples/helixheatx/helixHeatX.ts'));
  const pk = await createPico({ voxelSize: 1.0 });
  trees.push({ label, pk, heatX: new HelixHeatX(pk), identity: undefined });
}

const runStage = async (tree) => {
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  const voxels = tree.heatX['ioThreads']();
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const identity = `${voxels.gridHash().hash}/${f64hex(voxels.volume)}`;
  voxels.dispose();
  if (tree.identity !== undefined && tree.identity !== identity) {
    throw new Error(`${tree.label}: identity moved between repeats`);
  }
  tree.identity = identity;
  globalThis.gc();
  await new Promise((done) => setImmediate(done));
  return { ms, cpuMs: (cpu.user + cpu.system) / 1000 };
};

for (const tree of trees) await runStage(tree); // warm-up
const pairs = [];
for (let i = 0; i < iterations; i++) {
  const load = loadavg()[0];
  const pair = { i, load };
  for (const tree of i % 2 === 0 ? trees : [...trees].reverse()) {
    const { ms, cpuMs } = await runStage(tree);
    pair[tree.label] = ms;
    pair[`${tree.label}Cpu`] = cpuMs;
  }
  pairs.push(pair);
}
for (const tree of trees) tree.pk.dispose();

const [a, b] = trees;
if (a.identity !== b.identity)
  throw new Error(`identity differs: ${String(a.identity)} vs ${String(b.identity)}`);
const ratios = pairs.map((pair) => pair[a.label] / pair[b.label]);
const loads = pairs.map((pair) => pair.load);
console.log(
  JSON.stringify({
    stage: 'kernel:io-threads.create',
    entry,
    iterations,
    identity: a.identity,
    medianMs: {
      [a.label]: median(pairs.map((pair) => pair[a.label])),
      [b.label]: median(pairs.map((pair) => pair[b.label])),
    },
    medianPairedRatio: median(ratios),
    medianCpuMs: {
      [a.label]: median(pairs.map((pair) => pair[`${a.label}Cpu`])),
      [b.label]: median(pairs.map((pair) => pair[`${b.label}Cpu`])),
    },
    medianPairedCpuRatio: median(pairs.map((pair) => pair[`${a.label}Cpu`] / pair[`${b.label}Cpu`])),
    ratioRange: [Math.min(...ratios), Math.max(...ratios)],
    load1m: { min: Math.min(...loads), median: median(loads), max: Math.max(...loads) },
    pairs,
  }),
);
