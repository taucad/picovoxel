/** Build pristine and portability-patched desktop consumers against the shipped LEAP binary. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, inventory, sourceIdentity } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [sourceArg, outputArg, dotnetArg, rid, ...extra] = process.argv.slice(2);
if (!sourceArg || !outputArg || !dotnetArg || rid !== 'osx-arm64' || extra.length)
  throw new Error('Usage: node dotnet/test-desktop.mjs <PicoGK source> <fresh output> <dotnet> osx-arm64');
const source = resolve(sourceArg);
const output = resolve(outputArg);
const dotnet = resolve(dotnetArg);
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const identity = sourceIdentity(source, pins.sources.PicoGK);
const version = execFileSync(dotnet, ['--version'], { cwd: here, encoding: 'utf8' }).trim();
if (version !== pins.sdk) throw new Error(`Wrong SDK: ${version}`);
if (existsSync(output)) throw new Error('Output must be fresh; existing evidence is never overwritten');
mkdirSync(output, { recursive: true });
const native = join(source, 'native', rid, 'picogk.26.2.dylib');
const manifest = {
  comparator: 'leap-shipped',
  nativeRid: rid,
  sdk: version,
  source: identity.commit,
  nativeFiles: inventory(dirname(native)),
  compiler: execFileSync('clang++', ['--version'], { encoding: 'utf8' }).trim(),
  bridgeHeaders: inventory(join(here, '../vendor/PicoGKRuntime/API')),
  fixtures: inventory(join(here, 'tests/desktop')),
  patches: {},
};
const patches = ['browser-handles.patch', 'browser-callbacks.patch'];
for (const name of patches) manifest.patches[name] = digest(readFileSync(join(here, 'patches', name)));
manifest.callbackBridge = digest(readFileSync(join(here, 'native/callbacks.cpp')));
manifest.managedCallbacks = digest(readFileSync(join(here, 'managed/BrowserCallbacks.cs')));
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const nativeCopy = join(output, 'native');
mkdirSync(nativeCopy);
for (const name of readdirSync(dirname(native)))
  copyFileSync(join(dirname(native), name), join(nativeCopy, name));
const bridge = join(nativeCopy, 'picogk-dotnet.dylib');
execFileSync(
  'clang++',
  [
    '-std=c++17',
    '-dynamiclib',
    '-fPIC',
    '-DPICOGK_BUILD_LIBRARY',
    '-I',
    join(here, '../vendor/PicoGKRuntime/API'),
    join(here, 'native/callbacks.cpp'),
    join(nativeCopy, 'picogk.26.2.dylib'),
    '-o',
    bridge,
  ],
  { stdio: 'inherit' },
);
for (const variant of ['baseline', 'candidate', 'browser-interop']) {
  const project = join(output, variant);
  const staged = join(project, 'library/source');
  mkdirSync(staged, { recursive: true });
  for (const path of Object.keys(identity.files)) {
    if (!path.endsWith('.cs') && !path.startsWith('assets/')) continue;
    mkdirSync(dirname(join(staged, path)), { recursive: true });
    copyFileSync(join(source, path), join(staged, path));
  }
  if (variant !== 'baseline') {
    for (const name of patches)
      execFileSync('patch', ['-p1', '--fuzz=0', '-i', join(here, 'patches', name)], {
        cwd: staged,
        stdio: 'inherit',
      });
    copyFileSync(join(here, 'managed/BrowserCallbacks.cs'), join(staged, 'BrowserCallbacks.cs'));
  }
  copyFileSync(join(here, 'tests/desktop/Library.csproj'), join(project, 'library/Library.csproj'));
  copyFileSync(join(here, 'tests/desktop/Consumer.csproj'), join(project, 'Consumer.csproj'));
  copyFileSync(join(here, 'tests/desktop/Program.cs'), join(project, 'Program.cs'));
  execFileSync(
    dotnet,
    [
      'build',
      join(project, 'Consumer.csproj'),
      '-c',
      'Release',
      `-p:RuntimeIdentifier=${rid}`,
      '-p:SelfContained=false',
      '-nologo',
      ...(variant === 'browser-interop' ? ['-p:DefineConstants=PICOGK_BROWSER'] : []),
    ],
    { cwd: here, stdio: 'inherit' },
  );
  execFileSync(
    dotnet,
    [
      join(project, `bin/Release/net11.0/${rid}/Consumer.dll`),
      variant === 'browser-interop' ? bridge : native,
      join(project, 'result'),
    ],
    { cwd: here, stdio: 'inherit' },
  );
}
for (const name of ['result.json', 'public-api.txt', 'mesh.bin', 'sphere.stl']) {
  const before = readFileSync(join(output, 'baseline/result', name));
  const after = readFileSync(join(output, 'candidate/result', name));
  if (!before.equals(after)) throw new Error(`Desktop compatibility mismatch: ${name}`);
}
for (const name of ['mesh.bin', 'sphere.stl']) {
  if (
    !readFileSync(join(output, 'baseline/result', name)).equals(
      readFileSync(join(output, 'browser-interop/result', name)),
    )
  )
    throw new Error(`Context bridge geometry mismatch: ${name}`);
}
const callbackStatus = JSON.parse(readFileSync(join(output, 'browser-interop/result/callback-status.json')));
if (
  !callbackStatus.nested ||
  callbackStatus.errorsContained !== 4 ||
  !callbackStatus.recovered ||
  callbackStatus.concurrentCalls !== 8
)
  throw new Error('Incomplete callback witness');
writeFileSync(
  join(output, 'comparison.json'),
  `${JSON.stringify({ status: 'passed', compared: ['result.json', 'public-api.txt', 'mesh.bin', 'sphere.stl'], manifestSha256: digest(readFileSync(join(output, 'manifest.json'))) }, null, 2)}\n`,
);
console.log('Desktop before/after compatibility passed');
