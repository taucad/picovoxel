/** Acquire pinned archive inputs without installing or mutating the npm toolchain. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnet, nuget, adapter, execution, destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length || !['serial', 'threaded'].includes(execution))
  throw new Error(
    'Usage: prepare-archive.mjs <dotnet executable> <NuGet cache> <adapter directory> <serial|threaded> <new directory>',
  );
const out = resolve(destination);
mkdirSync(out);
const pins = JSON.parse(readFileSync(join(here, 'inputs.json')));
const dependencies = JSON.parse(readFileSync(join(here, 'archive-sources.json')));
const repositories = {
  PicoGK: 'leap71/PicoGK',
  ShapeKernel: 'leap71/LEAP71_ShapeKernel',
  HelixHeatX: 'leap71/LEAP71_HelixHeatX',
};
const sources = { picovoxel: resolve(here, '..') };
for (const [name, repository] of Object.entries(repositories)) {
  const root = join(out, name);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', [
    '-C',
    root,
    'fetch',
    '--quiet',
    '--depth=1',
    `https://github.com/${repository}.git`,
    pins.sources[name].commit,
  ]);
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  sources[name] = root;
}
const files = { adapter: resolve(adapter), shim: resolve(here, '../shim') };
for (const [name, pin] of Object.entries(dependencies)) {
  const response = await fetch(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== pin.sha256) throw new Error(`Source digest mismatch: ${name}`);
  const path = join(out, `${name}.tar.gz`);
  writeFileSync(path, bytes, { flag: 'wx' });
  files[name] = path;
}
const nativeRid = `${{ darwin: 'osx', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`;
if (!/^(osx|linux)-(x64|arm64)$/.test(nativeRid)) throw new Error('Archive producer requires macOS or Linux');
execFileSync(
  dotnet,
  [
    'restore',
    join(here, 'compiler-inputs.csproj'),
    '--packages',
    resolve(nuget),
    `-p:BaseIntermediateOutputPath=${out}/restore/`,
  ],
  { cwd: here, stdio: 'inherit' },
);
execFileSync(
  dotnet,
  [
    'restore',
    join(here, 'toolchain.csproj'),
    '--packages',
    resolve(nuget),
    `-p:WasmEnableThreads=${execution === 'threaded'}`,
    `-p:BaseIntermediateOutputPath=${out}/runtime-restore/`,
  ],
  { cwd: here, stdio: 'inherit' },
);
const config = {
  purpose: 'inputs',
  comparator: 'picovoxel-browser',
  nativeRid,
  execution,
  dotnet: realpathSync(dotnet),
  nuget: resolve(nuget),
  sources,
  files,
  flags: [
    '-O3',
    '-msimd128',
    '-ffp-contract=off',
    '-fwasm-exceptions',
    '-sWASM_LEGACY_EXCEPTIONS=0',
    ...(execution === 'threaded' ? ['-pthread'] : []),
  ],
};
writeFileSync(join(out, 'configuration.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
console.log(join(out, 'configuration.json'));
