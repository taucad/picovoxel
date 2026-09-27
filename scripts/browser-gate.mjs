// R25 — the three-engine browser gate (quality-infra doc, Finding 3).
//
// A plain node script, not a second test framework: build the gate bundle, compute
// the node-side records from the SAME wasm (pure-wasm numbers must be EXACT across
// engines — the module is deterministic without relaxed-simd/threads), serve the
// repo over a throwaway static server, and drive chromium + WEBKIT (the Safari
// claim) + firefox through the page. Console errors fail the run; the tolerated
// [gc-indeterminate] marker is the one designed exception (disposal doc).
//
// Also the ignore-comment audit lives here: any `v8 ignore` without a ` -- reason`
// justification fails the gate.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 0. Ignore-comment audit ──
const offenders = [];
for (const entry of readdirSync(join(HERE, 'src'))) {
  if (!entry.endsWith('.ts')) continue;
  const source = readFileSync(join(HERE, 'src', entry), 'utf8');
  for (const match of source.matchAll(/v8 ignore[^\n]*/g)) {
    if (!match[0].includes('--')) offenders.push(`${entry}: ${match[0]}`);
  }
}
if (offenders.length > 0) {
  console.error('UNJUSTIFIED coverage ignores (need a `-- reason`):\n  ' + offenders.join('\n  '));
  process.exit(1);
}

// ── 1. Build the gate bundle from dist/ (npm run build, or the CI candidate) ──
if (!existsSync(join(HERE, 'dist/index.js'))) {
  console.error('dist/ is missing: run `npm run build` (CI extracts the candidate tarball there)');
  process.exit(1);
}
console.log('building gate bundle…');
execFileSync('./node_modules/.bin/tsdown', ['--config', 'tsdown.gate.config.ts'], { cwd: HERE, stdio: 'inherit' });

// ── 2. Node-side records from the same package build ──
console.log('computing node records…');
const { createPico } = await import('picovoxel');
const { createGearOutline, triangulate, buildGearMesh } = await import('../examples/pico/gear.ts');

const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};

const pk = await createPico({ voxelSize: 0.5 });
const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
const sphereMesh = sphere.toMesh();
const s = (2 * Math.PI) / 10;
const gyroid = pk.createVoxels({
  shape: 'implicit',
  boundsMin: [-12, -12, -12],
  boundsMax: [12, 12, 12],
  sdf: (x, y, z) =>
    Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)) - 0.4,
});
const vertices = [];
const triangles = [];
buildGearMesh(
  {
    meshCreate: () => 0n,
    addVertex: (_l, _m, x, y, z) => (vertices.push(x, y, z), vertices.length / 3 - 1),
    addTriangle: (_l, _m, a, b, c) => (triangles.push(a, b, c), triangles.length / 3 - 1),
  },
  0n,
);
void createGearOutline;
void triangulate;
const gearMesh = pk.createMesh({ vertices, triangles });

// Tape path (TP1/TP6): evaluated entirely in wasm (musl libm), so unlike the
// JS-callback gyroid this volume must be EXACT across engines.
const tapeGyroid = pk.createVoxels({
  shape: 'implicit',
  boundsMin: [-12, -12, -12],
  boundsMax: [12, 12, 12],
  sdf: ['-', ['abs', ['+',
    ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
    ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
    ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]]]], 0.4],
});

const records = {
  sphereVolumeHex: hexFloat(sphere.volume),
  sphereVertexCount: sphereMesh.vertexCount,
  sphereTriangleCount: sphereMesh.triangleCount,
  gyroidVolume: gyroid.volume,
  tapeGyroidVolumeHex: hexFloat(tapeGyroid.volume),
  gearVertexCount: gearMesh.vertexCount,
  gearTriangleCount: gearMesh.triangleCount,
};
pk.dispose();
console.log('records:', records);

// ── 3. Throwaway static server ──
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = createServer((request, response) => {
  const path = join(HERE, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!path.startsWith(HERE) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/test/browser/index.html?records=${encodeURIComponent(JSON.stringify(records))}`;

// ── 4. Drive the engines (all three, or the comma-separated BROWSER subset) ──
const ENGINES = { chromium, webkit, firefox };
const selected = (process.env.BROWSER ?? Object.keys(ENGINES).join(',')).split(',');
const unknown = selected.filter((name) => !(name in ENGINES));
if (unknown.length > 0) {
  console.error(`unknown BROWSER engine(s): ${unknown.join(', ')}`);
  process.exit(1);
}
let failed = false;
for (const [name, engine] of selected.map((name) => [name, ENGINES[name]])) {
  console.log(`\n=== ${name} ===`);
  const browser = await engine.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(url);
  await page.waitForFunction(() => window.__done === true, undefined, { timeout: 120_000 });
  const results = await page.evaluate(() => window.__results);
  await browser.close();

  for (const result of results) {
    console.log(`  ${result.pass ? '✔' : '✖'} ${result.name}${result.detail ? `  ${result.detail}` : ''}`);
    if (!result.pass) failed = true;
  }
  if (consoleErrors.length > 0) {
    console.error(`  ✖ console errors:\n    ${consoleErrors.join('\n    ')}`);
    failed = true;
  }
  console.log(`  ${name}: ${results.filter((r) => r.pass).length}/${results.length} checks`);
}

server.close();
if (failed) {
  console.error('\nBROWSER GATE FAILED');
  process.exit(1);
}
console.log(`\nBROWSER GATE: ${selected.join(', ')} PASS`);
