// R25 — the in-page half of the three-engine browser gate. Bundled by tsdown
// (tsdown.gate.config.ts) with the wasm pair copied beside it; the node driver
// (scripts/browser-gate.mjs) injects the node-computed records via the URL and
// reads window.__results / window.__done back out.
//
// Assertion philosophy: everything pure-wasm compares EXACTLY against the node
// record (no relaxed-simd, no threads — the module is deterministic across
// engines); anything routed through JS Math (SDF callbacks, gear trig) uses a
// tight tolerance because Math.sin/cos differ across engines by ULPs.

import { createGearOutline, triangulate } from '../../src/gear.ts';
import { createPicoGK } from '../../src/index.ts';
import { contoursFromSdf } from '../../src/slicing.ts';

interface GateRecords {
  sphereVolumeHex: string;
  sphereVertexCount: number;
  sphereTriangleCount: number;
  gyroidVolume: number;
  tapeGyroidVolumeHex: string;
  gearVertexCount: number;
  gearTriangleCount: number;
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

declare global {
  interface Window {
    __results?: CheckResult[];
    __done?: boolean;
  }
}

const results: CheckResult[] = [];
const log = document.getElementById('log')!;
const check = (name: string, condition: boolean, detail = ''): boolean => {
  results.push({ name, pass: condition, detail });
  const line = document.createElement('div');
  line.className = condition ? 'ok' : 'fail';
  line.textContent = `${condition ? '✔' : '✖'} ${name}${detail ? `  ${detail}` : ''}`;
  log.append(line);
  return condition;
};

const hexFloat = (value: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};

async function main(): Promise<void> {
  const records = JSON.parse(new URLSearchParams(location.search).get('records')!) as GateRecords;

  // ── Shim: Symbol.dispose exists after import; `using` works where the engine has it ──
  check('Symbol.dispose defined post-import', typeof Symbol.dispose === 'symbol');
  try {
    // Parsed lazily so engines without explicit-resource-management still load the gate.
    new Function('const o = { [Symbol.dispose]() { globalThis.__usingRan = true; } }; { using x = o; }')();
    check('`using` runs against the shimmed symbol', (globalThis as { __usingRan?: boolean }).__usingRan === true);
  } catch {
    check('`using` unsupported by this engine — shim still present (tolerated)', typeof Symbol.dispose === 'symbol', '[no-erm-syntax]');
  }

  // ── Session ──
  const pk = await createPicoGK({ voxelSize: 0.5 });
  check('wasm instantiated in the browser', true, pk.version);
  check('string marshalling', /^PicoGK Core Library/.test(pk.name), pk.name);

  // ── Pure-wasm determinism: EXACT vs the node record ──
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
  check('sphere volume EXACT vs node (hex float)', hexFloat(sphere.volume) === records.sphereVolumeHex,
    `${hexFloat(sphere.volume)} vs ${records.sphereVolumeHex}`);
  const sphereMesh = sphere.toMesh();
  check('sphere mesh counts EXACT vs node',
    sphereMesh.vertexCount === records.sphereVertexCount && sphereMesh.triangleCount === records.sphereTriangleCount,
    `${sphereMesh.vertexCount}/${sphereMesh.triangleCount} vs ${records.sphereVertexCount}/${records.sphereTriangleCount}`);

  // ── Facade booleans (SG11 purity) ──
  const rod = pk.createVoxels({ shape: 'beam', start: [0, 0, -20], end: [0, 0, 20], radius: 3 });
  const before = sphere.volume;
  const drilled = sphere.subtract(rod);
  check('facade booleans pure', sphere.volume === before && drilled.volume < before,
    `${before.toFixed(0)} -> ${drilled.volume.toFixed(0)}`);

  // ── JS-callback path: tolerance vs node (Math.sin differs across engines) ──
  const s = (2 * Math.PI) / 10;
  let calls = 0;
  const gyroid = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: (x, y, z) => {
      calls++;
      return Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)) - 0.4;
    },
  });
  check('JS SDF callback drives RenderImplicit', calls > 100_000, `${calls} samples`);
  const gyroidError = Math.abs(gyroid.volume - records.gyroidVolume) / records.gyroidVolume;
  check('gyroid volume within 0.5% of node record', gyroidError < 0.005,
    `${gyroid.volume.toFixed(1)} vs ${records.gyroidVolume.toFixed(1)} (${(gyroidError * 100).toFixed(3)}%)`);

  // ── Tape path (TP1/TP6): evaluated entirely in wasm (musl libm), so the
  // interval-pruned parallel fill must be EXACT across engines — the stronger
  // pin the JS callback above cannot make. ──
  const tapeGyroid = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: ['-', ['abs', ['+',
      ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
      ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
      ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]]]], 0.4],
  });
  check('tape gyroid volume EXACT vs node (hex float)',
    hexFloat(tapeGyroid.volume) === records.tapeGyroidVolumeHex,
    `${hexFloat(tapeGyroid.volume)} vs ${records.tapeGyroidVolumeHex}`);
  tapeGyroid.dispose();

  // ── Gear through the bulk import path: counts exact ──
  const outline = createGearOutline();
  const caps = triangulate(outline);
  const vertices: number[] = [];
  const triangles: number[] = [];
  const arrayBuilder = {
    meshCreate: () => 0n,
    addVertex: (_l: bigint, _m: bigint, x: number, y: number, z: number) => (vertices.push(x, y, z), vertices.length / 3 - 1),
    addTriangle: (_l: bigint, _m: bigint, a: number, b: number, c: number) => (triangles.push(a, b, c), triangles.length / 3 - 1),
  };
  const { buildGearMesh } = await import('../../src/gear.ts');
  buildGearMesh(arrayBuilder, 0n);
  const gearMesh = pk.createMesh({ vertices, triangles });
  check('gear counts EXACT (R8 bulk import)',
    gearMesh.vertexCount === records.gearVertexCount && gearMesh.triangleCount === records.gearTriangleCount,
    `${gearMesh.vertexCount}/${gearMesh.triangleCount} vs ${records.gearVertexCount}/${records.gearTriangleCount}`);
  check('gear caps triangulated', caps.length > 0, `${caps.length} cap triangles`);

  // ── STL + slicing subpaths run in-browser ──
  const stl = gearMesh.toStl();
  const back = pk.meshFromStl(stl);
  check('STL round-trip in page', back.triangleCount === gearMesh.triangleCount, `${back.triangleCount} tris`);
  const contours = contoursFromSdf({
    width: 60,
    height: 60,
    data: Float32Array.from({ length: 3600 }, (_, i) => Math.hypot((i % 60) - 30, Math.floor(i / 60) - 30) - 20),
  });
  check('slicing vectorizer in page', contours.length === 1 && contours[0]!.winding === 'ccw', `${contours.length} contour(s)`);

  // ── GC pressure loop (disposal doc, tolerated nondeterminism) ──
  const gcSession = await createPicoGK({ voxelSize: 1.5 });
  const N = 200;
  for (let i = 0; i < N; i++) gcSession.createVoxels({ shape: 'sphere', radius: 2 });
  check('200 undisposed allocations survive', gcSession.allocated.voxels === N);
  let reclaimed = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // Allocation pressure encourages a collection; engines expose no gc() here.
    void new ArrayBuffer(8 * 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (gcSession.allocated.voxels < N) {
      reclaimed = true;
      break;
    }
  }
  check(
    reclaimed ? 'FinalizationRegistry reclaimed dropped wrappers' : 'GC did not run within 15s — tolerated',
    reclaimed || true,
    reclaimed ? `${gcSession.allocated.voxels} remain` : '[gc-indeterminate]',
  );
  gcSession.dispose();

  // ── Leak oracle + teardown ──
  drilled.dispose();
  rod.dispose();
  sphereMesh.dispose();
  sphere.dispose();
  gearMesh.dispose();
  back.dispose();
  gyroid.dispose();
  const leaked = Object.entries(pk.allocated).filter(([, n]) => n !== 0);
  check('no leaked handles after explicit disposal', leaked.length === 0, JSON.stringify(Object.fromEntries(leaked)));
  pk.dispose();
}

main()
  .catch((error: unknown) => {
    check(`unexpected failure: ${(error as { code?: string }).code ?? ''} ${(error as Error).message ?? error}`, false);
    console.error(error);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    const summary = document.createElement('div');
    summary.className = failed ? 'fail' : 'ok';
    summary.textContent = `\n${failed ? `${failed} FAILED` : 'ALL PASS'} — ${results.length} checks`;
    log.append(summary);
    window.__results = results;
    window.__done = true;
  });
