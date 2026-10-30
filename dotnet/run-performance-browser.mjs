/**
 * Measure one path's cost in one browser engine.
 *
 * Each path is measured on its own rather than as one figure for the browser: an app built ahead of
 * time and an app that compiles in the browser pay different costs, and within the second the
 * lifted tape and the per-voxel callback it replaces are different paths again. A mode is a
 * prepared app and the options the program reads, nothing inferred.
 *
 * Recorded: cold start, the compile, the run, an edit, the bytes fetched and the engine's heap.
 *
 * Usage: node dotnet/run-performance-browser.mjs <app directory> <chromium|firefox|webkit>
 *          <gyroid|heatx> <mode name> <fresh out> [--options <list>] [--playwright <module>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCaptureServer } from './parity/capture-server.mjs';

const engines = ['chromium', 'firefox', 'webkit'];
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
};
const options = flag('options', '');
const playwrightArg = flag('playwright', 'playwright');
const [appArg, engine, subject, mode, outputArg, ...extra] = argv;
if (!outputArg || extra.length || !engines.includes(engine) || !mode)
  throw new Error(
    'Usage: run-performance-browser.mjs <app> <chromium|firefox|webkit> <gyroid|heatx> <mode> <fresh out> [--options <list>] [--playwright <module>]',
  );
const [app, out] = [appArg, outputArg].map((value) => resolve(value));
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides earlier measurements');
mkdirSync(out, { recursive: true });

const captures = join(out, 'captures');
mkdirSync(captures);
const server = await startCaptureServer({ app, captures });
const playwright = await import(
  playwrightArg === 'playwright' ? 'playwright' : pathToFileURL(resolve(playwrightArg)).href
);
const browser = await (playwright[engine] ?? playwright.default[engine]).launch();
const lines = [];
let timings;
let version;
let transfer;
try {
  const page = await browser.newPage();
  page.on('console', (message) => {
    lines.push(message.text());
    console.log(`[${engine} ${mode}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`[${engine} ${mode}] pageerror ${error.message}`));
  const query = new URLSearchParams({ subject, options });
  await page.goto(`http://127.0.0.1:${String(server.port)}/index.html?${query.toString()}`);
  await page.waitForFunction(() => ['done', 'failed'].includes(document.title), undefined, {
    timeout: 3_600_000,
  });
  if ((await page.title()) === 'failed') throw new Error('The app reported failure');
  timings = await page.evaluate(() => globalThis.parityTimings);
  // Served bytes, by the server that served them: an engine's own accounting is not comparable.
  transfer = server.served;
  version = await browser.version();
} finally {
  await browser.close();
  await server.close();
}

const report = {
  engine,
  version,
  subject,
  mode,
  options,
  app,
  /** Milliseconds, except `heapBytes`, which the program reports in bytes. */
  timings,
  transfer,
  console: lines,
};
writeFileSync(join(out, 'performance.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(
  `${engine} ${version} ${subject} ${mode}: boot ${String(Math.round(timings.boot))} ms, run ${String(
    Math.round(timings.run ?? 0),
  )} ms, ${String(transfer.bytes)} bytes in ${String(transfer.requests)} requests`,
);
