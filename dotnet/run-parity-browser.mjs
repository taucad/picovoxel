/**
 * Run the parity fixture in one browser engine and collect the exact bytes it wrote.
 *
 * This is the measured side of I1. The app directory is prepared by the adapter that owns the
 * browser host: one directory per mode, `aot` for the fixture compiled into the published bundle
 * and `dynamic` for the same source compiled by the in-browser compiler at run time. This driver
 * knows neither, so a mode is proven by which directory it is pointed at.
 *
 * The fixture writes its captures to the sandboxed file system, which the gate cannot read, so the
 * app uploads each one back over the same origin it was served from. The upload is the contract:
 * `PUT capture/<file name>` with the file's bytes, then `document.title` set to `done` or `failed`.
 * Bytes are never transformed on either side, so a capture that reaches disk is what the engine
 * produced.
 *
 * Usage: node dotnet/run-parity-browser.mjs <app directory> <chromium|firefox|webkit>
 *          <gyroid|heatx> <fresh out> [--playwright <module>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './validate-inputs.mjs';
import { parityCaptureFiles } from './tests/parity/compare.mjs';
import { startCaptureServer } from './parity/capture-server.mjs';

const engines = ['chromium', 'firefox', 'webkit'];
const argv = process.argv.slice(2);
const playwrightIndex = argv.indexOf('--playwright');
const playwrightArg = playwrightIndex === -1 ? 'playwright' : argv[playwrightIndex + 1];
const positional =
  playwrightIndex === -1 ? argv : [...argv.slice(0, playwrightIndex), ...argv.slice(playwrightIndex + 2)];
const [appArg, engine, subject, outputArg, ...extra] = positional;
if (!outputArg || extra.length || !engines.includes(engine) || !playwrightArg)
  throw new Error(
    'Usage: run-parity-browser.mjs <app directory> <chromium|firefox|webkit> <gyroid|heatx> <fresh out> [--playwright <module>]',
  );
const expected = parityCaptureFiles(subject);
const [app, out] = [appArg, outputArg].map((value) => resolve(value));
if (!existsSync(join(app, 'index.html'))) throw new Error('The app directory has no index.html to run');
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides earlier captures');
const captures = join(out, 'captures');
mkdirSync(captures, { recursive: true });
const server = await startCaptureServer({ app, captures });

const playwright = await import(
  playwrightArg === 'playwright' ? 'playwright' : pathToFileURL(resolve(playwrightArg)).href
);
const browser = await (playwright[engine] ?? playwright.default[engine]).launch();
const lines = [];
/** @type {string | undefined} */
let crashed;
let version;
try {
  const page = await browser.newPage();
  page.on('console', (message) => {
    lines.push(message.text());
    console.log(`[${engine}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    crashed ??= error.message;
    console.log(`[${engine}] pageerror ${error.message}`);
  });
  await page.goto(`http://127.0.0.1:${String(server.port)}/index.html?subject=${subject}`);
  // Voxelising and meshing a pinned example in wasm is minutes of work, and HeatX is the long one.
  await page.waitForFunction(() => ['done', 'failed'].includes(document.title), undefined, {
    timeout: 3_600_000,
  });
  const title = await page.title();
  if (title === 'failed') throw new Error(`The app reported failure${crashed ? `: ${crashed}` : ''}`);
  version = await browser.version();
} finally {
  await browser.close();
  await server.close();
}

const written = readdirSync(captures).sort();
for (const name of expected)
  if (!written.includes(name))
    throw new Error(`${engine} wrote no ${name}; the run proves nothing about ${subject}`);
writeFileSync(
  join(out, 'browser.json'),
  `${JSON.stringify(
    {
      engine,
      version,
      subject,
      app,
      uploaded: server.uploaded.length,
      captures: Object.fromEntries(
        written.map((name) => {
          const bytes = readFileSync(join(captures, name));
          return [name, { bytes: bytes.length, sha256: digest(bytes) }];
        }),
      ),
      // Kept because the fixture reports which implicit path dispatched, which no capture shows.
      console: lines,
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
console.log(`${engine} ${version} ${subject} captures: ${captures}`);
