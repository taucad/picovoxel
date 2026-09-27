import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedPhases = ['p0', 'p1', 'p2'].filter((phase) => process.argv.includes(`--run-${phase}`));
if (requestedPhases.length > 1) {
  throw new Error('Choose exactly one of --run-p0, --run-p1, or --run-p2');
}
const RUN_PHASE = requestedPhases[0];
const IS_GATE = RUN_PHASE !== undefined;
const ALLOW_LOADED = process.argv.includes('--allow-loaded');
const SUMMARY = process.argv.includes('--summary');
const outputIndex = process.argv.indexOf('--output');
const outputRelative = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
if (outputIndex !== -1 && (outputRelative === undefined || outputRelative.startsWith('-'))) {
  throw new Error('--output requires a repository-relative JSON path');
}
const cores = cpus().length;
const quietLoadCeiling = cores / 2;
const startLoad = loadavg()[0];
if (IS_GATE && !ALLOW_LOADED && startLoad > quietLoadCeiling) {
  console.error(
    `REFUSED: 1-min loadavg ${startLoad.toFixed(2)} > cores/2 (${quietLoadCeiling.toFixed(2)}). ` +
      'Use --allow-loaded only for exploratory runs, never committed gate evidence.',
  );
  process.exit(1);
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wgsl': 'text/plain; charset=utf-8',
};

execFileSync('./node_modules/.bin/tsdown', ['--config', 'tsdown.webgpu.config.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (RUN_PHASE === 'p0') {
  execFileSync('bash', ['scripts/build-webgpu-cpu-probe.sh'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
if ((RUN_PHASE === 'p1' || RUN_PHASE === 'p2') && process.env.WEBGPU_SKIP_CPP_BUILD !== '1') {
  execFileSync('bash', ['scripts/build-webgpu-picovoxel-spike.sh'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

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
const mode = RUN_PHASE === undefined ? '' : `?mode=${RUN_PHASE}`;
const url = `http://127.0.0.1:${address.port}/spikes/webgpu/index.html${mode}`;

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.WEBGPU_HEADED !== '1',
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      return;
    }
    if (message.text().startsWith('[picovoxel:spike]')) {
      console.log(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__done === true, undefined, {
    timeout: RUN_PHASE === 'p1' || RUN_PHASE === 'p2' ? 1_800_000 : 120_000,
  });
  const outcome = await page.evaluate(() => ({
    error: globalThis.__error,
    result: globalThis.__result,
  }));
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (outcome.error !== undefined) throw new Error(outcome.error);
  const endLoad = loadavg()[0];
  const evidence = {
    environment: {
      baselineEligible: IS_GATE && !ALLOW_LOADED,
      browser: `Google Chrome ${browser.version()}`,
      cores,
      cpu: cpus()[0]?.model ?? 'unknown',
      date: new Date().toISOString(),
      endLoad,
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim(),
      node: process.version,
      os: `${platform()} ${release()}`,
      ramGiB: Math.round(totalmem() / 2 ** 30),
      startLoad,
    },
    mode: RUN_PHASE ?? 'probe',
    result: outcome.result,
  };
  if (outputRelative !== undefined) {
    const outputRoot = resolve(ROOT, 'bench/results/webgpu');
    const outputPath = resolve(ROOT, outputRelative);
    if (!outputPath.startsWith(`${outputRoot}/`) || !outputPath.endsWith('.json')) {
      throw new Error('--output must name a JSON file under bench/results/webgpu/');
    }
    if (!evidence.environment.baselineEligible) {
      throw new Error('Refusing to write non-baseline-eligible WebGPU gate evidence');
    }
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const displayed =
    SUMMARY && RUN_PHASE === 'p0'
      ? {
          environment: evidence.environment,
          result: {
            decision: outcome.result?.decision,
            gyroid: outcome.result?.gyroid?.gate,
            overhead: outcome.result?.overhead?.gates,
          },
        }
      : SUMMARY && IS_GATE
        ? {
            environment: evidence.environment,
            result: {
              decision: outcome.result?.decision,
              gates: outcome.result?.gates,
              status: outcome.result?.status,
            },
          }
        : evidence;
  console.log(JSON.stringify(displayed, null, 2));
  if (outcome.result?.status !== 'available') process.exitCode = 2;
} finally {
  await browser?.close();
  server.close();
}
