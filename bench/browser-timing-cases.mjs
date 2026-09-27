// The cases bench/browser-timing.mjs times, shared by both sides: Chromium loads
// this module through an import map, and Node runs it as a child process
// (`node bench/browser-timing-cases.mjs <case>`), so both run the same code on
// the same dist/ build of picovoxel/multi.
//
//   gyroid  the tape gyroid of bench/run.mjs M10 at 0.25 mm: render and mesh,
//           1 warmup and 5 measured repeats, each on a fresh session
//   heatx   the HelixHeatX example at 1.0 mm: construct and mesh, one run
//
// Each case also times the first createPico() of a fresh page or process: the
// cold start (module compile and thread pool start).

import { createPico } from 'picovoxel/multi';
import { task } from '../examples/helixheatx/run.ts';

const now = () => performance.now();
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};

const s = (2 * Math.PI) / 10;
const GYROID = [
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

/** Runs one case and returns its timings (ms) and identity. */
export async function runCase(name) {
  if (name === 'gyroid') {
    const t0 = now();
    const cold = await createPico({ voxelSize: 0.25 });
    const coldStartMs = now() - t0;
    const threads = (cold.module.PThread?.runningWorkers.length ?? 0) + 1;
    cold.dispose();
    const render = [];
    const mesh = [];
    let identity = null;
    for (let repeat = 0; repeat < 6; repeat++) {
      const session = await createPico({ voxelSize: 0.25 });
      const t1 = now();
      const gyroid = session.createVoxels({
        shape: 'implicit',
        boundsMin: [-12, -12, -12],
        boundsMax: [12, 12, 12],
        sdf: GYROID,
      });
      const t2 = now();
      const surface = gyroid.toMesh();
      const t3 = now();
      identity = { volumeHex: hexFloat(gyroid.volume), triangles: surface.triangleCount };
      session.dispose();
      if (repeat === 0) continue; // warmup
      render.push(t2 - t1);
      mesh.push(t3 - t2);
    }
    return {
      name,
      coldStartMs,
      threads,
      renderMs: median(render),
      meshMs: median(mesh),
      render,
      mesh,
      identity,
    };
  }
  if (name === 'heatx') {
    const t0 = now();
    const session = await createPico({ voxelSize: 1.0, memoryWarningBytes: 0 });
    const coldStartMs = now() - t0;
    const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
    const { voxels, constructMs } = task(session);
    const t1 = now();
    const surface = voxels.toMesh();
    const meshMs = now() - t1;
    const identity = { volumeHex: hexFloat(voxels.volume), triangles: surface.triangleCount };
    session.dispose();
    return { name, coldStartMs, threads, constructMs, meshMs, identity };
  }
  throw new Error(`unknown case ${name}`);
}

if (globalThis.process?.argv[1]?.endsWith('browser-timing-cases.mjs')) {
  console.log(JSON.stringify(await runCase(globalThis.process.argv[2])));
}
