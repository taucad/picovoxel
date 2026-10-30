/**
 * Qualify the local package: restore it from a local-only feed, prove the restored payload is the
 * staged payload byte for byte, and build the same sample source for both targets against it.
 *
 * The restore uses a fresh packages folder, so the package itself is always restored rather than
 * reused, and falls back to the machine's existing cache for the dependencies staging already
 * acquired. No source is configured, so a build that reaches a public feed fails here.
 *
 * Usage: node dotnet/test-package.mjs <dotnet> <package output> <fresh work directory>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { digest } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, packageArg, workArg, ...extra] = process.argv.slice(2);
if (!workArg || extra.length)
  throw new Error('Usage: test-package.mjs <dotnet> <package output> <fresh work directory>');
const [dotnet, packaged, work] = [dotnetArg, packageArg, workArg].map((value) => resolve(value));
if (existsSync(work)) throw new Error('Work directory must be fresh; existing evidence is never overwritten');
mkdirSync(work, { recursive: true });

const packedReceipt = JSON.parse(readFileSync(join(packaged, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(packaged, 'payload/manifest.json'), 'utf8'));
const version = manifest.version;
const packages = join(work, 'packages');
writeFileSync(
  join(work, 'nuget.config'),
  `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="picovoxel-local" value="${join(packaged, 'feed')}" />
  </packageSources>
  <fallbackPackageFolders>
    <clear />
    <add key="staged" value="${join(homedir(), '.nuget/packages')}" />
  </fallbackPackageFolders>
</configuration>
`,
);

const sample = join(work, 'sample');
mkdirSync(sample, { recursive: true });
for (const name of ['Program.cs', 'Desktop.csproj', 'Browser.csproj'])
  writeFileSync(join(sample, name), readFileSync(join(here, 'samples/PicoGKSample', name)));
writeFileSync(join(sample, 'nuget.config'), readFileSync(join(work, 'nuget.config')));

const restored = join(packages, 'picovoxel.picogk', version);
const build = (project, extraArguments = []) =>
  execFileSync(
    dotnet,
    [
      'build',
      join(sample, project),
      '-c',
      'Release',
      '-nologo',
      `-p:PicoVoxelPicoGKVersion=${version}`,
      `-p:PicoGKSampleBaseProject=${join(work, 'base/PicoGK.csproj')}`,
      `--packages=${packages}`,
      `--artifacts-path=${join(work, 'artifacts', project.replace(/\.csproj$/u, ''))}`,
      ...extraArguments,
    ],
    { cwd: sample, stdio: 'inherit' },
  );

// One restore of the package alone, so the payload comparison sees it before any build touches it.
execFileSync(
  dotnet,
  [
    'restore',
    join(sample, 'Desktop.csproj'),
    '-nologo',
    `-p:PicoVoxelPicoGKVersion=${version}`,
    `-p:PicoGKSampleBaseProject=${join(work, 'base/PicoGK.csproj')}`,
    `--packages=${packages}`,
  ],
  { cwd: sample, stdio: 'inherit' },
);
if (digest(readFileSync(join(packaged, 'feed', packedReceipt.nupkg))) !== packedReceipt.nupkgSha256)
  throw new Error('The packed candidate changed after packaging');
for (const [path, expected] of Object.entries(manifest.payload)) {
  if (digest(readFileSync(join(restored, path))) !== expected)
    throw new Error(`The restored payload differs from the staged payload: ${path}`);
}
const restoredManifest = readFileSync(join(restored, 'manifest.json'));
if (digest(restoredManifest) !== packedReceipt.manifestSha256)
  throw new Error('The restored manifest is not the staged manifest');
const extraneous = [];
const walk = (current, name) => {
  for (const child of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = name ? `${name}/${child.name}` : child.name;
    if (child.isDirectory()) walk(join(current, child.name), path);
    // NuGet writes its own restore bookkeeping beside the payload; the payload itself is exact.
    else if (
      !(path in manifest.payload) &&
      path !== 'manifest.json' &&
      !/^(\.|[^/]+\.(nupkg|nuspec|sha512))/u.test(path)
    )
      extraneous.push(path);
  }
};
walk(restored, '');
if (extraneous.length)
  throw new Error(`The restored package carries files the manifest does not: ${extraneous.join(', ')}`);

// The composer owns the patch order, and refuses a composition that drops the package's own patch.
const compose = join(restored, 'base/compose.mjs');
execFileSync(
  'node',
  [compose, join(work, 'base'), '--patch', join(restored, 'base/patches/browser-handles.patch')],
  {
    stdio: 'inherit',
  },
);
let refused = '';
try {
  execFileSync(
    'node',
    [compose, join(work, 'base-unpatched'), '--patch', join(here, 'patches/browser-callbacks.patch')],
    {
      stdio: 'pipe',
    },
  );
} catch (error) {
  refused = String(error.stderr);
}
if (!refused.includes("must include this package's own"))
  throw new Error('A composition without the package patch was not refused');

build('Desktop.csproj');
const generated = join(work, 'generated');
build('Browser.csproj', [`-p:CompilerGeneratedFilesOutputPath=${generated}`]);
const registry = readFileSync(
  join(
    generated,
    'PicoVoxel.Sdf.Generator/PicoVoxel.Sdf.Generator.SdfTapeGenerator/PicoVoxel.SdfTapeRegistration.g.cs',
  ),
  'utf8',
);
if (!registry.includes('Register<global::GyroidShell>'))
  throw new Error('The browser target did not register the sample implicit as a tape');
for (const target of ['Desktop', 'Browser']) {
  if (!existsSync(join(work, `artifacts/${target}/bin/${target}/release/PicoGKSample.dll`)))
    throw new Error(`The ${target.toLowerCase()} target produced no assembly`);
}

writeFileSync(
  join(work, 'report.json'),
  `${JSON.stringify(
    {
      status: 'passed',
      package: packedReceipt.package,
      nupkgSha256: packedReceipt.nupkgSha256,
      manifestSha256: digest(restoredManifest),
      payloadFiles: Object.keys(manifest.payload).length + 1,
      references: manifest.references.count,
      base: manifest.base.commit,
      generatorSha256: manifest.generator.sha256,
      engine: Object.fromEntries(
        Object.entries(manifest.engine).map(([execution, value]) => [execution, value.inputsSha256]),
      ),
      registrySha256: digest(Buffer.from(registry)),
    },
    null,
    2,
  )}\n`,
);
console.log('Local package restore and both sample targets passed');
