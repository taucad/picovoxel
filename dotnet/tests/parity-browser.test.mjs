import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureName, startCaptureServer } from '../parity/capture-server.mjs';
import { parityCaptureFiles } from './parity/compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('every driver expects one capture set per subject', () => {
  assert.deepEqual(parityCaptureFiles('gyroid'), [
    'capture-0.mesh',
    'capture-0.stl',
    'capture-1.mesh',
    'capture-1.stl',
  ]);
  assert.deepEqual(parityCaptureFiles('heatx').toSorted(), ['HelixHeatX.STL', 'final.mesh']);
  assert.throws(() => parityCaptureFiles('sphere'), /Expected gyroid or heatx/);
});

test('an upload names a bare capture file or nothing', () => {
  assert.equal(captureName('/capture/capture-0.mesh'), 'capture-0.mesh');
  assert.equal(captureName('/capture/HelixHeatX.STL'), 'HelixHeatX.STL');
  for (const pathname of [
    '/capture/',
    '/capture/../escape.mesh',
    '/capture/%2e%2e%2fescape.mesh',
    '/capture/nested/capture-0.mesh',
    '/capture/.hidden',
    '/capture/%ff',
  ])
    assert.equal(captureName(pathname), undefined, pathname);
});

test('the server returns the app isolated and keeps uploaded bytes exact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'picogk-capture-'));
  try {
    const app = join(root, 'app');
    const captures = join(root, 'captures');
    mkdirSync(app);
    mkdirSync(captures);
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>waiting</title>');
    writeFileSync(join(app, 'runtime.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
    const server = await startCaptureServer({ app, captures });
    const origin = `http://127.0.0.1:${String(server.port)}`;
    try {
      // Cross-origin isolation is what the threaded host needs, so the gate must serve it.
      const page = await fetch(`${origin}/index.html`);
      assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
      assert.equal((await fetch(`${origin}/runtime.wasm`)).headers.get('content-type'), 'application/wasm');
      // A directory serves its own index, and nothing above the app is reachable.
      assert.equal((await fetch(`${origin}/`)).status, 200);
      assert.equal((await fetch(`${origin}/../app/index.html`)).status, 404);

      const bytes = Buffer.from([1, 2, 3, 4, 0xff, 0, 0x80]);
      const upload = await fetch(`${origin}/capture/capture-0.mesh`, { method: 'PUT', body: bytes });
      assert.equal(upload.status, 204);
      assert.deepEqual(readFileSync(join(captures, 'capture-0.mesh')), bytes);
      assert.deepEqual(server.uploaded, ['capture-0.mesh']);
      // A traversing name is refused rather than resolved, and writes nothing.
      assert.equal(
        (await fetch(`${origin}/capture/..%2fescape.mesh`, { method: 'PUT', body: bytes })).status,
        400,
      );
      assert.deepEqual(server.uploaded, ['capture-0.mesh']);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the gate fails an engine that did not run and one that regressed with the reference', () => {
  const root = mkdtempSync(join(tmpdir(), 'picogk-gate-'));
  try {
    const directories = {};
    for (const mode of ['native', 'aot', 'dynamic']) {
      const directory = join(root, mode);
      mkdirSync(directory);
      directories[mode] = directory;
      // Structurally valid but empty: identical across targets, and still not the pinned subject.
      for (const capture of [0, 1]) {
        writeFileSync(join(directory, `capture-${capture}.mesh`), Buffer.alloc(8));
        writeFileSync(join(directory, `capture-${capture}.stl`), Buffer.alloc(84));
      }
    }
    const gate = (...engines) => {
      const evidence = mkdtempSync(join(root, 'evidence-'));
      rmSync(evidence, { recursive: true });
      try {
        execFileSync(
          process.execPath,
          [join(here, '../gate-parity.mjs'), 'gyroid', directories.native, evidence, ...engines],
          {
            stdio: 'pipe',
          },
        );
        return { code: 0, report: JSON.parse(readFileSync(join(evidence, 'parity-gyroid.json'), 'utf8')) };
      } catch (failure) {
        return {
          code: failure.status,
          report: JSON.parse(readFileSync(join(evidence, 'parity-gyroid.json'), 'utf8')),
        };
      }
    };

    const shared = gate(`chromium=${directories.aot},${directories.dynamic}`);
    assert.equal(shared.code, 1);
    assert.equal(shared.report.passed, false);
    assert.deepEqual(shared.report.engines, ['chromium']);
    // The targets agree with each other; the historical pin is what refuses the shared regression.
    assert.equal(shared.report.results[0].captures[0].historical.passed, false);
    assert.equal(
      shared.report.results[0].captures[0].comparisons.every(
        (row) => row.mesh.identical && row.stl.identical,
      ),
      true,
    );

    const absent = gate(
      `chromium=${directories.aot},${directories.dynamic}`,
      `webkit=${join(root, 'never-ran')},${directories.dynamic}`,
    );
    assert.equal(absent.code, 1);
    assert.deepEqual(absent.report.engines, ['chromium', 'webkit']);
    assert.match(absent.report.results[1].reason, /No captures for aot/);
    assert.equal(absent.report.results[1].passed, false);

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [join(here, '../gate-parity.mjs'), 'gyroid', directories.native, root, 'chromium'],
          {
            stdio: 'pipe',
          },
        ),
      /Expected <engine>=<AOT captures>,<dynamic captures>/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
