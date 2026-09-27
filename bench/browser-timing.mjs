// Chromium timings for picovoxel/multi, paired with Node on the same machine.
//
// Serves the repository with the cross-origin isolation headers the pthreads
// build needs (COOP same-origin, COEP require-corp), strips types from the
// example .ts sources as it serves them, and loads bench/browser-timing-cases.mjs
// in headless Chromium through an import map onto dist/. Each round runs every
// case once in a fresh Node process and once in a fresh Chromium page,
// alternating, so both sides see the same machine load; the 1-minute load
// average is recorded beside every run. Build dist/ and the wasm first.
//
// Usage: node bench/browser-timing.mjs [--rounds 3] [--out bench/results/browser/<file>.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const ROUNDS = Number(argValue('--rounds') ?? 3);
const CASES = ['gyroid', 'heatx'];

if (!existsSync(join(HERE, 'dist/pico-multi.wasm'))) {
  console.error('dist/pico-multi.wasm is missing: build the wasm pair, then `pnpm run build`');
  process.exit(1);
}

const IMPORT_MAP = {
  imports: {
    picovoxel: '/dist/index.js',
    'picovoxel/multi': '/dist/multi.js',
    'picovoxel/numerics': '/dist/numerics.js',
    'picovoxel/shapekernel': '/dist/shapekernel.js',
  },
};
const PAGE = `<!doctype html><meta charset="utf-8"><title>picovoxel timing</title>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script type="module">import { runCase } from '/bench/browser-timing-cases.mjs'; globalThis.runCase = runCase; globalThis.ready = true;</script>`;
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/javascript',
  '.wasm': 'application/wasm',
};

const server = createServer((request, response) => {
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (pathname === '/') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }
  const path = join(HERE, pathname);
  if (!path.startsWith(HERE) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, headers).end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
  if (extname(path) === '.ts') response.end(stripTypeScriptTypes(readFileSync(path, 'utf8')));
  else createReadStream(path).pipe(response);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const wasm = readFileSync(join(HERE, 'dist/pico-multi.wasm'));
const git = (...args) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
const record = {
  fingerprint: {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
    node: process.version,
    chromium: browser.version(),
    wasmMultiSha256: createHash('sha256').update(wasm).digest('hex'),
    wasmMultiBytes: wasm.length,
    gitSha: git('rev-parse', '--short', 'HEAD'),
    date: new Date().toISOString(),
  },
  runs: [],
};
const out =
  argValue('--out') ??
  `bench/results/browser/${record.fingerprint.date.slice(0, 10)}-${record.fingerprint.gitSha}.json`;
mkdirSync(dirname(resolve(HERE, out)), { recursive: true });
// Written after every run, so a crash or a stopped run keeps what it measured.
const save = () => writeFileSync(resolve(HERE, out), `${JSON.stringify(record, null, 2)}\n`);

/** One case in a fresh Chromium page; a crashed or stalled page is recorded as an error. */
async function inChromium(name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.ready === true);
    if (!(await page.evaluate(() => globalThis.crossOriginIsolated)))
      throw new Error('page is not cross-origin isolated');
    const load = loadavg()[0];
    const failed = new Promise((_, reject) => {
      page.on('crash', () => reject(new Error('page crashed')));
      setTimeout(() => reject(new Error('no result after 10 minutes')), 600_000).unref();
    });
    const result = await Promise.race([
      page.evaluate((caseName) => globalThis.runCase(caseName), name),
      failed,
    ]);
    if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    return { load, ...result };
  } catch (error) {
    return { name, error: String(error) };
  } finally {
    await context.close().catch(() => {});
  }
}

for (let round = 0; round < ROUNDS; round++) {
  for (const name of CASES) {
    const nodeLoad = loadavg()[0];
    const nodeResult = JSON.parse(
      execFileSync(process.execPath, [join(HERE, 'bench/browser-timing-cases.mjs'), name], {
        cwd: HERE,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .at(-1),
    );
    record.runs.push({ round, host: 'node', load: nodeLoad, ...nodeResult });
    const chromiumResult = await inChromium(name);
    record.runs.push({ round, host: 'chromium', ...chromiumResult });
    save();
    console.log(
      `round ${round + 1} ${name}: node ${JSON.stringify(nodeResult)}\n  chromium ${JSON.stringify(chromiumResult)}`,
    );
  }
}
await browser.close();
server.close();
console.log(`wrote ${out}`);
