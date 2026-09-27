// SK-0.6 mesh-extraction scaling probe. Runs the M10 gyroid (@0.25 mm) in both
// variants in one process and times ONLY the toMesh() phase, plus the M12-class
// check on a denser gyroid if BENCH_DENSE=1. The harness contract follows
// bench/run.mjs: quiet-machine refusal, identity capture, JSON out.
//
// Usage: node bench/mesh-scaling-ab.mjs <label>
//   BENCH_MESH_REPEATS=N   timed repeats per variant (default 12, 2 warmups discarded)
// The caller swaps src/pico*.{wasm,mjs} artifacts between runs (tape-prune-ab
// pattern); <label> names the artifact side in the output file.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { execSync } from 'node:child_process';

const label = process.argv[2];
if (!label) {
  console.error('usage: node bench/mesh-scaling-ab.mjs <label>');
  process.exit(1);
}
const REPEATS = Number(process.env.BENCH_MESH_REPEATS ?? 12);
const WARMUP = 2;

const lowPower = execSync('pmset -g | grep lowpowermode', { encoding: 'utf8' });
if (!lowPower.includes(' 0')) {
  console.error('REFUSED: lowpowermode active');
  process.exit(1);
}

const now = () => performance.now();
const s = (2 * Math.PI) / 10;
const gyroidExpression = [
  '-',
  [
    'abs',
    [
      '+',
      ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
      ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
      ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]],
    ],
  ],
  0.4,
];

const out = { label, repeats: REPEATS, load: loadavg(), variants: {} };

for (const [variant, importer] of [
  ['single', () => import('../src/index.ts')],
  ['multi', () => import('../src/multi.ts')],
]) {
  const { createPico } = await importer();
  const session = await createPico({ voxelSize: 0.25 });
  const gyroid = session.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: gyroidExpression,
  });
  const samples = [];
  let identity = null;
  for (let i = 0; i < WARMUP + REPEATS; i++) {
    const t = now();
    const mesh = gyroid.toMesh();
    const ms = now() - t;
    if (i >= WARMUP) samples.push(ms);
    const stl = mesh.toStl();
    const sha = createHash('sha256').update(stl).digest('hex').slice(0, 16);
    const id = `${mesh.triangleCount}:${sha}`;
    if (identity === null) identity = id;
    else if (identity !== id) {
      console.error(`IDENTITY DRIFT ${variant} repeat ${i}: ${identity} vs ${id}`);
      process.exit(1);
    }
    mesh.dispose();
  }
  const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
  const sorted = [...samples].sort((a, b) => a - b);
  out.variants[variant] = {
    threads,
    identity,
    samples,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
  session.dispose();
}

const file = `bench/results/webgpu-v2/sk-0.6-mesh-${label}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      file,
      single: out.variants.single.median,
      multi: out.variants.multi.median,
      threads: out.variants.multi.threads,
      identity: out.variants.multi.identity,
    },
    null,
    1,
  ),
);
