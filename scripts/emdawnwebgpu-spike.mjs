import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'spikes/webgpu/emdawn/dist');
const onlyVariant = process.argv.find((argument) => argument.startsWith('--variant='))?.slice(10);
const variantsToRun = onlyVariant === undefined ? ['callback', 'blocking'] : [onlyVariant];
const timeoutMs = Number(process.env.EMDAWN_TIMEOUT_MS ?? 120_000);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

execFileSync('bash', ['scripts/build-emdawnwebgpu-spike.sh'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const path = join(ROOT, pathname);
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  createReadStream(path).pipe(response);
});
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
if (typeof address !== 'object' || address === null) throw new Error('Spike server did not bind');

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
  const variants = {};
  for (const variant of variantsToRun) {
    console.log(`running emdawnwebgpu ${variant}…`);
    const page = await browser.newPage();
    const errors = [];
    const messages = [];
    page.on('console', (message) => {
      messages.push(`${message.type()}: ${message.text()}`);
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${address.port}/spikes/webgpu/emdawn/index.html?variant=${variant}`);
    try {
      await page.waitForFunction(() => globalThis.__done === true, undefined, {
        timeout: timeoutMs,
      });
    } catch (error) {
      const state = await page.evaluate(() => ({
        done: globalThis.__done,
        emdawnDone: globalThis.__emdawnDone,
        error: globalThis.__error,
        result: globalThis.__emdawnResult,
        text: document.body.textContent,
      }));
      throw new Error(`${variant} timed out: ${JSON.stringify(state)}\n${messages.join('\n')}`, { cause: error });
    }
    const result = await page.evaluate(() => ({
      error: globalThis.__error,
      result: globalThis.__result,
    }));
    await page.close();
    if (errors.length > 0) throw new Error(`${variant}: ${errors.join('\n')}`);
    if (result.error !== undefined) throw new Error(`${variant}: ${result.error}`);
    variants[variant] = result.result;
  }

  const sizes = Object.fromEntries(
    ['baseline', 'callback', 'blocking'].map((variant) => {
      const jsPath = join(DIST, `${variant}.mjs`);
      const wasmPath = join(DIST, `${variant}.wasm`);
      return [
        variant,
        {
          js: statSync(jsPath).size,
          jsGzip: gzipSync(readFileSync(jsPath)).length,
          wasm: statSync(wasmPath).size,
          wasmGzip: gzipSync(readFileSync(wasmPath)).length,
        },
      ];
    }),
  );
  console.log(
    JSON.stringify(
      {
        deltas: {
          asyncifyVsCallback: {
            js: sizes.blocking.js - sizes.callback.js,
            wasm: sizes.blocking.wasm - sizes.callback.wasm,
          },
          callbackVsBaseline: {
            js: sizes.callback.js - sizes.baseline.js,
            wasm: sizes.callback.wasm - sizes.baseline.wasm,
          },
        },
        flags: {
          blocking: '--use-port=emdawnwebgpu --closure=1 -sASYNCIFY=1',
          callback: '--use-port=emdawnwebgpu --closure=1',
          legacyUseWebGpu: false,
        },
        sizes,
        variants,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.close();
}
