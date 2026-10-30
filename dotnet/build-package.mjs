/**
 * Bind the qualified browser inputs into one local package.
 *
 * The browser host has so far consumed seven separately staged directories, each correct only by
 * hand. This driver verifies them against the pins and the archive receipts once, stages them as an
 * immutable payload under a single manifest, and packs that payload for a local feed. Nothing here
 * is published: the package exists so a consumer restores one identity instead of composing seven.
 *
 * Usage: node dotnet/build-package.mjs <dotnet> <NuGet cache> <PicoGK source> <serial archive>
 *                                      <threaded archive> <generator assembly> <patched Roslyn> <fresh output>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, sourceIdentity, toolchainIdentity } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, nugetArg, sourceArg, serialArg, threadedArg, generatorArg, roslynArg, outputArg, ...extra] =
  process.argv.slice(2);
if (!outputArg || extra.length)
  throw new Error(
    'Usage: build-package.mjs <dotnet> <NuGet cache> <PicoGK source> <serial archive> <threaded archive> <generator assembly> <patched Roslyn> <fresh output>',
  );
const [dotnet, nuget, source, generator, roslyn, out] = [
  dotnetArg,
  nugetArg,
  sourceArg,
  generatorArg,
  roslynArg,
  outputArg,
].map((value) => resolve(value));
const archives = { serial: resolve(serialArg), threaded: resolve(threadedArg) };
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides a stale payload');
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const hostRid = `${process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const sdk = execFileSync(dotnet, ['--version'], { encoding: 'utf8' }).trim();
if (sdk !== pins.sdk) throw new Error(`Wrong SDK: ${sdk}`);

/** The engine archive members, named as the host links them. */
const names = ['float-trig.o', 'libblosc.a', 'libopenvdb.a', 'libtbb.a', 'libz.a', 'picogk.26.2.a'];
/**
 * The receipt fields a serial and a threaded archive must agree on. The pair is two builds of one
 * program; `execution`, `flags` and `toolchain` are the only fields a threaded build may change.
 */
const paired = [
  'schemaVersion',
  'comparator',
  'nativeRid',
  'driverSha256',
  'globalJsonSha256',
  'projectSha256',
  'pinsSha256',
  'sources',
  'files',
];
const receipts = {};
for (const [execution, root] of Object.entries(archives)) {
  const bytes = readFileSync(join(root, 'inputs.json'));
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (receipt.execution !== execution) throw new Error(`Archive is not ${execution}: ${root}`);
  const inputsSha256 = digest(bytes);
  for (const name of names) {
    const metadata = JSON.parse(readFileSync(join(root, `${name}.metadata.json`), 'utf8'));
    if (metadata.execution !== execution) throw new Error(`Archive member is not ${execution}: ${name}`);
    if (metadata.emscripten !== pins.emscripten || metadata.emscriptenRevision !== pins.emscriptenRevision)
      throw new Error(`Archive member was built by another compiler: ${name}`);
    if (metadata.runtime !== pins.runtime) throw new Error(`Archive member targets another runtime: ${name}`);
    if (metadata.inputsSha256 !== inputsSha256)
      throw new Error(`Archive member belongs to another receipt: ${name}`);
    if (digest(readFileSync(join(root, 'native', name))) !== metadata.sha256)
      throw new Error(`Archive bytes changed: ${name}`);
  }
  // The host resolves the same workload this archive was built by, so compare before packaging it.
  const actual = toolchainIdentity(dotnet, nuget, hostRid, execution);
  if (digest(Buffer.from(JSON.stringify(actual))) !== digest(Buffer.from(JSON.stringify(receipt.toolchain))))
    throw new Error(`The ${execution} archive toolchain differs from this install.`);
  receipts[execution] = { receipt, inputsSha256, toolchain: actual };
}
for (const field of paired) {
  const [a, b] = [receipts.serial.receipt[field], receipts.threaded.receipt[field]];
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`The archive pair was built from different source: ${field}.`);
}

const base = sourceIdentity(source, pins.sources.PicoGK);
const references = receipts.serial.toolchain.inputs.references;
const payload = {};
const stage = (relative, bytes) => {
  const target = join(out, 'payload', relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  payload[relative] = digest(bytes);
};
const stageFile = (relative, from) => stage(relative, readFileSync(from));

/**
 * The managed library's own source selection: the C# the browser and desktop builds compile, the
 * two embedded viewer assets, and the upstream project file, which a consumer's patches expect to
 * find even though `base/PicoGK.csproj` is the project the composed tree builds. The upstream tree
 * also ships desktop native binaries for three platforms, which neither target consumes;
 * `base.commit` and `base.files` below record the whole tree's identity regardless.
 */
const compiled = (path) =>
  path.endsWith('.cs') || path.startsWith('assets/') || path === 'LICENSE' || path === 'PicoGK.csproj';
for (const path of Object.keys(base.files).filter(compiled))
  stageFile(`base/source/${path}`, join(source, path));
stageFile('base/PicoGK.csproj', join(here, 'package/base/PicoGK.csproj'));
stageFile('base/compose.mjs', join(here, 'package/base/compose.mjs'));
stageFile('base/patches/browser-handles.patch', join(here, 'patches/browser-handles.patch'));
stageFile(
  'base/patches/stl-normal-canonicalization.patch',
  join(here, 'patches/stl-normal-canonicalization.patch'),
);
stageFile('base/managed/BrowserCallbacks.cs', join(here, 'managed/BrowserCallbacks.cs'));
stageFile('base/managed/SdfTape.cs', join(here, 'managed/SdfTape.cs'));
stageFile('browser/AuthoringRetention.props', join(here, 'browser/AuthoringRetention.props'));
stageFile('generator/PicoVoxel.Sdf.Generator.dll', generator);
/**
 * The compiler the host compiles author source with. Upstream Roslyn cannot run on this runtime
 * unmodified; `dotnet/tools/RoslynChecksumPatch` adapts it, and the pins record the unpatched
 * inputs those two assemblies were produced from.
 */
const roslynNames = ['Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll'];
for (const name of roslynNames) stageFile(`roslyn/${name}`, join(roslyn, name));
for (const name of ['validate-inputs.mjs', 'global.json', 'toolchain.csproj', 'inputs.json'])
  stageFile(`toolchain/${name}`, join(here, name));
for (const [execution, root] of Object.entries(archives)) {
  stageFile(`engine/${execution}/inputs.json`, join(root, 'inputs.json'));
  for (const name of names) {
    stageFile(`engine/${execution}/native/${name}`, join(root, 'native', name));
    stageFile(`engine/${execution}/${name}.metadata.json`, join(root, `${name}.metadata.json`));
  }
}
stageFile('build/PicoVoxel.PicoGK.props', join(here, 'package/build/PicoVoxel.PicoGK.props'));
stageFile('build/PicoVoxel.PicoGK.targets', join(here, 'package/build/PicoVoxel.PicoGK.targets'));
stageFile('license', join(here, '../license'));
stageFile('NOTICE', join(here, 'package/NOTICE'));
stageFile('README.md', join(here, 'package/README.md'));

const manifest = {
  schemaVersion: 1,
  package: 'PicoVoxel.PicoGK',
  version,
  toolchain: {
    sdk: pins.sdk,
    workload: pins.workload,
    runtime: pins.runtime,
    emscriptenPackage: pins.emscriptenPackage,
    emscriptenCompiler: pins.emscripten,
    emscriptenRevision: pins.emscriptenRevision,
    roslyn: pins.roslyn,
    hostRid,
    identitySha256: digest(Buffer.from(JSON.stringify(receipts.serial.toolchain))),
    threadedIdentitySha256: digest(Buffer.from(JSON.stringify(receipts.threaded.toolchain))),
  },
  compiler: {
    input: pins.compilerFiles,
    patched: Object.fromEntries(roslynNames.map((name) => [name, payload[`roslyn/${name}`]])),
  },
  references: {
    count: Object.keys(references).length,
    assemblies: Object.keys(references).filter((name) => name.endsWith('.dll')).length,
    files: references,
  },
  base: { commit: base.commit, files: base.files },
  engine: Object.fromEntries(
    Object.entries(receipts).map(([execution, { inputsSha256 }]) => [
      execution,
      {
        inputsSha256,
        files: Object.fromEntries(names.map((name) => [name, payload[`engine/${execution}/native/${name}`]])),
      },
    ]),
  ),
  generator: { sha256: payload['generator/PicoVoxel.Sdf.Generator.dll'] },
  payload,
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, 'payload/manifest.json'), bytes);
writeFileSync(join(out, 'manifest.sha256'), `${digest(bytes)}\n`);

mkdirSync(join(out, 'feed'), { recursive: true });
execFileSync(
  dotnet,
  [
    'pack',
    join(here, 'package/PicoVoxel.PicoGK.csproj'),
    '-c',
    'Release',
    '-nologo',
    `-p:PicoVoxelPayload=${join(out, 'payload')}`,
    `-p:PackageVersion=${version}`,
    `-p:PackageOutputPath=${join(out, 'feed')}`,
    `--artifacts-path=${join(out, 'pack')}`,
  ],
  { cwd: here, stdio: 'inherit' },
);
const packed = readdirSync(join(out, 'feed')).filter((name) => name.endsWith('.nupkg'));
if (packed.length !== 1) throw new Error('Packaging produced more than one candidate');
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      package: `PicoVoxel.PicoGK.${version}`,
      nupkg: packed[0],
      nupkgSha256: digest(readFileSync(join(out, 'feed', packed[0]))),
      manifestSha256: digest(bytes),
      payloadFiles: Object.keys(payload).length + 1,
    },
    null,
    2,
  )}\n`,
);
console.log(`Packed PicoVoxel.PicoGK ${version}: ${join(out, 'feed', packed[0])}`);
