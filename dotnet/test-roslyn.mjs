/** Qualify the pinned browser-only Roslyn checksum adaptation without changing the package cache. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, outputArg, ...extra] = process.argv.slice(2);
if (!dotnetArg || !outputArg || extra.length)
  throw new Error('Usage: node dotnet/test-roslyn.mjs <dotnet> <fresh output>');
const dotnet = resolve(dotnetArg);
const output = resolve(outputArg);
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const version = execFileSync(dotnet, ['--version'], { cwd: here, encoding: 'utf8' }).trim();
if (version !== pins.sdk) throw new Error(`Wrong SDK: ${version}`);
if (existsSync(output)) throw new Error('Output must be fresh');
mkdirSync(output, { recursive: true });
const run = (args) => execFileSync(dotnet, args, { cwd: here, stdio: 'inherit' });
run([
  'build',
  join(here, 'tools/RoslynChecksumPatch/RoslynChecksumPatch.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'patcher'),
  `-p:BaseIntermediateOutputPath=${join(output, 'patcher-obj')}/`,
]);
run([
  'build',
  join(here, 'tests/roslyn-checksum/RoslynChecksumTests.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'tests'),
  `-p:BaseIntermediateOutputPath=${join(output, 'tests-obj')}/`,
]);
const cacheLine = execFileSync(dotnet, ['nuget', 'locals', 'global-packages', '--list'], {
  cwd: here,
  encoding: 'utf8',
}).trim();
if (!cacheLine.startsWith('global-packages: ')) throw new Error('Cannot locate NuGet package cache');
const roslyn = join(
  cacheLine.slice('global-packages: '.length),
  'microsoft.codeanalysis.common/5.9.0/lib/netstandard2.0/Microsoft.CodeAnalysis.dll',
);
run([
  join(output, 'tests/RoslynChecksumTests.dll'),
  dotnet,
  join(output, 'patcher/RoslynChecksumPatch.dll'),
  roslyn,
  join(output, 'results'),
]);
