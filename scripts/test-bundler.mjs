#!/usr/bin/env node
// Bundler and browser proof for the frozen candidate (close-out T3.5). Installs
// the packed tarball with the pinned Vite into an empty npm project, builds a
// two-page consumer app with `vite build`, and drives the built pages in
// Chromium, Firefox and WebKit (or the comma-separated BROWSER subset):
// - `serial.html` runs the README's Vite form of `picovoxel` (`?url` +
//   `locateFile`) on a page served without isolation headers;
// - `multi.html` runs the Vite form of `picovoxel/multi` from
//   docs/threads-and-isolation.md (`mainScriptUrlOrBlob` + `instantiateWasm`
//   with one compiled module) on a page served with COOP/COEP, so it is
//   cross-origin isolated and its pthread pool must engage.
// Both pages run one probe, and Node runs the same probe on both entries of the
// installed package: every pure-wasm result (volumes as hex floats, mesh
// counts, the SHA-256 of an STL) must equal the Node serial record exactly.
// Nothing is rebuilt and no repository file reaches the app.
//
// Usage: node scripts/test-bundler.mjs <candidate-directory>

import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const candidate = resolve(process.argv[2] ?? 'candidate');
const { packages } = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
const root = packages.find(({ name }) => name === 'picovoxel');
if (!root) throw new Error('candidate manifest has no picovoxel package');

const ENGINES = { chromium, firefox, webkit };
const selected = (process.env.BROWSER ?? Object.keys(ENGINES).join(',')).split(',');
const unknown = selected.filter((name) => !(name in ENGINES));
if (unknown.length > 0) throw new Error(`unknown BROWSER engine(s): ${unknown.join(', ')}`);

const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const vite = devDependencies.vite;
if (!/^\d+\.\d+\.\d+$/u.test(vite ?? ''))
  throw new Error('package.json must pin an exact vite devDependency');

// One probe for Node and both pages. The tape gyroid is evaluated entirely in
// wasm (musl libm), so its volume and mesh bytes are engine-independent; the
// pthreads build writes each voxel from one thread, so they are also
// build-independent.
const probe = String.raw`
const s = (2 * Math.PI) / 10;
const tape = ['-', ['abs', ['+',
  ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
  ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
  ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]],
]], 0.4];

const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};

const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export async function probe(pico) {
  const sphere = pico.createVoxels({ shape: 'sphere', radius: 10 });
  const sphereMesh = sphere.toMesh();
  const gyroid = pico.createVoxels({ shape: 'implicit', boundsMin: [-12, -12, -12], boundsMax: [12, 12, 12], sdf: tape });
  const gyroidMesh = gyroid.toMesh();
  return {
    sphereVolume: hexFloat(sphere.volume),
    sphereMesh: sphereMesh.vertexCount + '/' + sphereMesh.triangleCount,
    gyroidVolume: hexFloat(gyroid.volume),
    gyroidMesh: gyroidMesh.vertexCount + '/' + gyroidMesh.triangleCount,
    gyroidStl: await sha256(gyroidMesh.toStl()),
  };
}

export async function run(createPico, wasm) {
  const result = { isolated: globalThis.crossOriginIsolated ?? null };
  try {
    const pico = await createPico({ voxelSize: 0.5, wasm });
    try {
      result.records = await probe(pico);
      result.workers = pico.module.PThread?.runningWorkers.length ?? 0;
    } finally {
      pico.dispose();
    }
  } catch (error) {
    result.error = (error?.code ? error.code + ': ' : '') + String(error?.message ?? error);
  }
  return result;
}
`;

// The README's Vite form for the serial entry.
const serialPage = String.raw`
import { createPico } from 'picovoxel';
import wasmUrl from 'picovoxel/wasm?url';
import { run } from './probe.js';

window.__result = await run(createPico, { locateFile: () => wasmUrl });
`;

// The Vite form for the pthreads entry in docs/threads-and-isolation.md.
const multiPage = String.raw`
import { createPico } from 'picovoxel/multi';
import wasmUrl from 'picovoxel/multi/wasm?url';
import workerUrl from 'picovoxel/multi/worker?url';
import { run } from './probe.js';

const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
window.__result = await run(createPico, {
  mainScriptUrlOrBlob: workerUrl,
  instantiateWasm: (imports, receive) => {
    WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
    return {};
  },
});
`;

const html = (name) =>
  `<!doctype html><meta charset="utf-8"><title>${name}</title><script type="module" src="./${name}.js"></script>\n`;

const nodeRecords = String.raw`
import assert from 'node:assert/strict';
import { run } from './probe.js';

const serial = await run((await import('picovoxel')).createPico);
const multi = await run((await import('picovoxel/multi')).createPico);
assert.equal(serial.error, undefined, 'picovoxel failed in Node: ' + serial.error);
assert.equal(multi.error, undefined, 'picovoxel/multi failed in Node: ' + multi.error);
assert.ok(multi.workers > 0, 'picovoxel/multi never engaged its worker pool in Node');
assert.deepEqual(multi.records, serial.records, 'the two entries disagree in Node');
console.log(JSON.stringify(serial.records));
`;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

const directory = mkdtempSync(join(tmpdir(), 'picovoxel-bundler-'));
let server;
try {
  execFileSync('npm', ['init', '--yes'], { cwd: directory, stdio: 'ignore' });
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(candidate, root.filename),
      `vite@${vite}`,
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  const files = {
    'package.json': JSON.stringify({
      ...JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
      type: 'module',
    }),
    'probe.js': probe,
    'serial.js': serialPage,
    'multi.js': multiPage,
    'serial.html': html('serial'),
    'multi.html': html('multi'),
    'records.mjs': nodeRecords,
    // The pthreads glue holds Emscripten's `new Worker(new URL('pico-multi.mjs',
    // import.meta.url))`, which Vite bundles as a worker entry; its top-level
    // await needs ES workers, as docs/threads-and-isolation.md says.
    'vite.config.js': `export default {
  build: { target: 'es2022', rolldownOptions: { input: ['serial.html', 'multi.html'] } },
  worker: { format: 'es' },
};
`,
  };
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);

  const records = JSON.parse(
    execFileSync(process.execPath, ['records.mjs'], { cwd: directory, encoding: 'utf8' }).trim(),
  );
  console.log('Node records (serial = multi):', records);

  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    cwd: directory,
    stdio: 'inherit',
  });

  // The serial page is served without isolation headers, as the README says it
  // needs none; every other response carries COOP/COEP so the multi page and
  // its pthread workers are cross-origin isolated.
  const out = join(directory, 'dist');
  server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const path = join(out, pathname);
    if (!path.startsWith(out + sep) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const headers = { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' };
    if (pathname !== '/serial.html') {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    response.writeHead(200, headers);
    createReadStream(path).pipe(response);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const failures = [];
  for (const name of selected) {
    const browser = await ENGINES[name].launch();
    try {
      for (const page of ['serial', 'multi']) {
        const label = `${name} ${page}`;
        const tab = await browser.newPage();
        // The first page or console error ends the wait: a pool that cannot
        // start (no isolation) never resolves, and would otherwise sit out the timeout.
        const errors = [];
        let fail;
        const failed = new Promise((_, reject) => (fail = reject));
        failed.catch(() => {});
        const record = (text) => {
          errors.push(text);
          fail(new Error('page error'));
        };
        tab.on('pageerror', (error) => record(String(error)));
        tab.on('console', (message) => message.type() === 'error' && record(message.text()));
        let result;
        try {
          await tab.goto(`${origin}/${page}.html`);
          await Promise.race([
            tab.waitForFunction(() => globalThis.__result !== undefined, undefined, { timeout: 180_000 }),
            failed,
          ]);
          result = await tab.evaluate(() => globalThis.__result);
        } catch (error) {
          result = { error: String(error?.message ?? error).split('\n')[0] };
        }
        await tab.close();
        const problems = [];
        if (result.error) problems.push(result.error);
        if (errors.length > 0) problems.push(`console errors: ${errors.join(' | ')}`);
        if (!result.error) {
          if (result.isolated !== (page === 'multi'))
            problems.push(`crossOriginIsolated is ${result.isolated}`);
          if (page === 'multi' && !(result.workers > 0)) problems.push('the pthread pool never engaged');
          for (const [key, value] of Object.entries(records)) {
            if (result.records[key] !== value)
              problems.push(`${key} ${String(result.records[key])} != Node ${String(value)}`);
          }
        }
        if (problems.length > 0) {
          failures.push(`${label}: ${problems.join('; ')}`);
          console.log(`  ✖ ${label}: ${problems.join('; ')}`);
        } else {
          const workers = page === 'multi' ? `, ${result.workers} pthread workers` : '';
          console.log(
            `  ✔ ${label}: hex-float parity with Node on ${Object.keys(records).length} records${workers}`,
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (failures.length > 0) {
    throw new Error(`bundler proof failed:\n  ${failures.join('\n  ')}`);
  }
  console.log(`bundler proof: vite@${vite} build of picovoxel@${root.version}; ${selected.join(', ')} PASS`);
} finally {
  server?.close();
  rmSync(directory, { force: true, recursive: true });
}
