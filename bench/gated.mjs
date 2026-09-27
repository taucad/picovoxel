// The one wall-clock pull request gate (close-out D32; create-repo §5.2): HelixHeatX
// at 1.0 mm on the pthread entry in the viewer lane, end to end, over one warm
// runtime (Tau's steady state since createPicoRuntime).
//
// Each tree gets its own child process holding one warm runtime, so the two
// wasm heaps never share a process. The parent drives them in turn: one
// discarded warm-up each (it also records the G0 tuple, outside the timing),
// then ITERATIONS measured iterations interleaved pair by pair (ABAB), so
// runner drift lands on both trees alike. bench/gates.mjs judges the medians.
//
// A tree is a checkout root with its CI-built src/pico-multi.* and its
// candidate's dist/ (the example imports the package by name). This file, the
// PR's copy, drives both trees; main's benchmark name is read from main's copy,
// and a different or missing name admits the PR's benchmark as new.
//
// Usage
//   node bench/gated.mjs --head <tree> [--base <tree>] [--aa] [--out result.json]
//   --aa     run the head tree against itself (the A/A calibration run)
//   node bench/gated.mjs --compare result.json comment.md
//            judge a result (bench/gates.mjs); exit 1 when the gate fails
//   BENCH_GATED_ITERATIONS=N  measured iterations per tree (default 15)
//   BENCH_GATED_SIZE=S        voxel size in mm (default 1.0; local smoke runs only)

import { execFileSync, fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hexFloat } from './g0-compare.mjs';
import { compareGated, hardwareClass } from './gates.mjs';
import { stlIdentity } from './stl-multiset.mjs';

/** The gated benchmark's identity: rename it on any semantic change to the body below. */
export const NAME = 'heatx-multi-fast-1.0mm-e2e-v2';

const ITERATIONS = Number(process.env.BENCH_GATED_ITERATIONS ?? 15);
const VOXEL_SIZE = Number(process.env.BENCH_GATED_SIZE ?? 1.0);
const self = fileURLToPath(import.meta.url);

/** Child: one warm runtime over `tree`; each message runs one iteration. */
async function child(tree) {
  const load = (path) => import(pathToFileURL(join(tree, path)).href);
  const { createPicoRuntime } = await load('src/multi.ts');
  const { task } = await load('examples/helixheatx/run.ts');
  const runtime = await createPicoRuntime();
  process.on('message', async ({ fingerprint }) => {
    const started = performance.now();
    const session = await runtime.createPico({ voxelSize: VOXEL_SIZE, lane: 'fast' });
    const { voxels } = task(session);
    const mesh = voxels.toMesh();
    void mesh.vertices.length;
    void mesh.triangles.length;
    const built = performance.now();
    let tuple;
    if (fingerprint) {
      const grid = voxels.gridHash();
      const stl = stlIdentity(mesh.toStl(mesh.lane === 'fast' ? { acceptLane: 'fast' } : undefined));
      tuple = {
        gridHash: grid.hash,
        activeVoxels: grid.activeVoxels,
        insideTiles: grid.insideTiles,
        insideOffVoxels: grid.insideOffVoxels,
        volumeHex: hexFloat(voxels.volume),
        triangles: mesh.triangleCount,
        vertices: mesh.vertexCount,
        multiset: stl.multiset,
        nonFiniteRecords: stl.nonFiniteRecords,
        threads: (session.module.PThread?.runningWorkers.length ?? 0) + 1,
      };
    }
    const disposing = performance.now();
    session.dispose();
    const ms = built - started + (performance.now() - disposing);
    process.send({ ms, fingerprint: tuple });
  });
  process.on('disconnect', () => {
    runtime.dispose();
    process.exit(0);
  });
  process.send({ ready: true });
}

/** Starts a child over `tree` and returns a function running one iteration. */
async function spawnTree(tree) {
  const worker = fork(self, ['--child', tree], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const next = () =>
    new Promise((resolveMessage, reject) => {
      const onExit = (code) => reject(new Error(`benchmark child for ${tree} exited with ${code}`));
      worker.once('exit', onExit);
      worker.once('message', (message) => {
        worker.off('exit', onExit);
        resolveMessage(message);
      });
    });
  await next();
  return {
    run: (fingerprint = false) => {
      const reply = next();
      worker.send({ fingerprint });
      return reply;
    },
    stop: () => worker.disconnect(),
  };
}

/**
 * The benchmark name a tree declares, or undefined when it has none. Read as
 * text: importing a copy would run main's module, and importing this file from
 * itself would deadlock on its own top-level await.
 */
function nameOf(tree) {
  const path = join(tree, 'bench/gated.mjs');
  return existsSync(path)
    ? /^export const NAME = '([^']+)';$/mu.exec(readFileSync(path, 'utf8'))?.[1]
    : undefined;
}

/** The commit a tree is checked out at, when it is a checkout. */
const commitOf = (tree) => {
  try {
    return execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

async function parent(argv) {
  const option = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const aa = argv.includes('--aa');
  const head = resolve(option('--head') ?? '.');
  const base = aa ? head : option('--base') && resolve(option('--base'));
  const result = {
    name: NAME,
    class: hardwareClass({ platform: process.platform, arch: process.arch, cores: availableParallelism() }),
    aa,
    voxelSize: VOXEL_SIZE,
    iterations: ITERATIONS,
    loadBefore: loadavg()[0],
    head: { sha: commitOf(head), samplesMs: [], fingerprint: undefined },
    base: null,
  };
  const baseName = base && nameOf(base);
  if (!base) result.baseReason = 'no main tree was available to compare';
  else if (baseName === undefined) result.baseReason = 'main has no gated benchmark';
  else result.base = { name: baseName, sha: commitOf(base), samplesMs: [], fingerprint: undefined };
  const comparable = result.base?.name === NAME;

  const trees = [{ record: result.head, runner: await spawnTree(head) }];
  if (comparable) trees.push({ record: result.base, runner: await spawnTree(base) });
  for (const { record, runner } of trees) {
    const warm = await runner.run(true);
    record.fingerprint = warm.fingerprint;
    record.warmUpMs = warm.ms;
    console.error(
      `warm-up ${record === result.head ? 'head' : 'base'}: ${(warm.ms / 1000).toFixed(2)} s, ${warm.fingerprint.threads} threads`,
    );
  }
  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    const line = [];
    for (const { record, runner } of trees) {
      const { ms } = await runner.run();
      record.samplesMs.push(+ms.toFixed(3));
      line.push(`${record === result.head ? 'head' : 'base'} ${(ms / 1000).toFixed(2)} s`);
    }
    console.error(`iteration ${iteration}/${ITERATIONS}: ${line.join(', ')}`);
  }
  for (const { runner } of trees) runner.stop();
  result.loadAfter = loadavg()[0];
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const out = option('--out');
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === self;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child') await child(argv[1]);
  else if (argv[0] === '--compare') {
    const { failed, markdown } = compareGated(JSON.parse(readFileSync(argv[1], 'utf8')));
    writeFileSync(argv[2], `${markdown}\n`);
    process.stdout.write(`${markdown}\n`);
    if (failed) process.exitCode = 1;
  } else await parent(argv);
}
