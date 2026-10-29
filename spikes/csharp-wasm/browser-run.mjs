// Serves the AppBundle and runs it in headless Chromium, printing the page's console.
// Usage: node browser-run.mjs <AppBundle> [voxel] [runs] [gyroid|heatx]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PW);
const root = process.argv[2];
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.dat': 'application/octet-stream',
};
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const body = await readFile(path.endsWith('/') ? join(path, 'index.html') : path);
    // Cross-origin isolation, which SharedArrayBuffer (the threaded build) requires.
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const lines = [];
page.on('console', (m) => {
  lines.push(m.text());
  console.log(m.text());
});
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(
  `http://localhost:${port}/index.html?voxel=${process.argv[3] ?? 0.5}&runs=${process.argv[4] ?? 3}&program=${process.argv[5] ?? 'gyroid'}`,
);
await page.waitForFunction(() => ['done', 'failed'].includes(document.title), null, { timeout: 3600000 });
const failed = (await page.title()) === 'failed';
console.log(`browser: ${await browser.version()}`);
await browser.close();
server.close();
const program = process.argv[5] ?? 'gyroid';
const expected =
  program === 'heatx'
    ? ['b9dac944dc434a69']
    : program.startsWith('gyroid')
      ? ['2b43725651c3733a', 'b8aa4cfd3b2b77f9']
      : [];
const missing = expected.filter((digest) => !lines.some((line) => line.includes(digest)));
if (failed || missing.length || !lines.some((line) => line === 'exit 0')) {
  console.error(
    `verification failed: page=${failed ? 'failed' : 'done'}, missing digests=${missing.join(',')}`,
  );
  process.exitCode = 1;
}
