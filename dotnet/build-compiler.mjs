/**
 * Produce the compiler pair the browser host compiles author source with.
 *
 * Upstream Roslyn 5.9.0 cannot run on this runtime unmodified: one checksum site schedules work on
 * a thread the browser runtime does not have. `tools/RoslynChecksumPatch` adapts that site in
 * `Microsoft.CodeAnalysis.dll` and refuses any assembly but the pinned one; `Microsoft.CodeAnalysis
 * .CSharp.dll` needs no change and is staged as the pinned bytes. Both inputs are verified against
 * `inputs.json` before either is written, so the pair can only come from the pinned compiler.
 *
 * `test-roslyn.mjs` qualifies the adaptation; this driver produces the pair a package build takes.
 *
 * Usage: node dotnet/build-compiler.mjs <dotnet> <NuGet cache> <fresh output>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, nugetArg, outputArg, ...extra] = process.argv.slice(2);
if (!outputArg || extra.length)
  throw new Error('Usage: build-compiler.mjs <dotnet> <NuGet cache> <fresh output>');
const [dotnet, nuget, out] = [dotnetArg, nugetArg, outputArg].map((value) => resolve(value));
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides another compiler');
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const sdk = execFileSync(dotnet, ['--version'], { encoding: 'utf8' }).trim();
if (sdk !== pins.sdk) throw new Error(`Wrong SDK: ${sdk}`);
mkdirSync(out, { recursive: true });

/** The pinned cache path of each input, by the staged name it produces. */
const inputs = {};
for (const [path, expected] of Object.entries(pins.compilerFiles)) {
  const from = join(nuget, path);
  if (digest(readFileSync(from)) !== expected) throw new Error(`Pinned compiler input changed: ${path}`);
  inputs[path.split('/').at(-1)] = from;
}
const common = 'Microsoft.CodeAnalysis.dll';
const csharp = 'Microsoft.CodeAnalysis.CSharp.dll';
if (!inputs[common] || !inputs[csharp]) throw new Error('The pins do not name both compiler assemblies');

const patcher = join(out, 'patcher');
execFileSync(
  dotnet,
  [
    'build',
    join(here, 'tools/RoslynChecksumPatch/RoslynChecksumPatch.csproj'),
    '-c',
    'Release',
    '-o',
    patcher,
    `-p:BaseIntermediateOutputPath=${join(out, 'patcher-obj')}/`,
  ],
  { cwd: here, stdio: 'inherit' },
);
execFileSync(dotnet, [join(patcher, 'RoslynChecksumPatch.dll'), inputs[common], join(out, common)], {
  stdio: 'inherit',
});
// The C# layer is unchanged; staging the pinned bytes keeps the pair one compiler, not two.
copyFileSync(inputs[csharp], join(out, csharp));
console.log(
  `${JSON.stringify(
    {
      roslyn: pins.roslyn,
      patched: Object.fromEntries(
        [common, csharp].map((name) => [name, digest(readFileSync(join(out, name)))]),
      ),
    },
    null,
    2,
  )}`,
);
