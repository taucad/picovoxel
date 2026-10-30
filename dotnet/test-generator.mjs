/** Qualify the signed-distance tape generator's lifting decision and the arithmetic it rebuilds. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, outputArg, ...extra] = process.argv.slice(2);
if (!dotnetArg || !outputArg || extra.length)
  throw new Error('Usage: node dotnet/test-generator.mjs <dotnet> <fresh output>');
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
  join(here, 'generator/PicoVoxel.Sdf.Generator/PicoVoxel.Sdf.Generator.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'generator'),
  '-p:IncludeBuildOutput=true',
  `-p:BaseIntermediateOutputPath=${join(output, 'generator-obj')}/`,
]);
run([
  'build',
  join(here, 'tests/sdf-generator/SdfGeneratorTests.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'tests'),
  `-p:BaseIntermediateOutputPath=${join(output, 'tests-obj')}/`,
  `-p:PicoVoxelGeneratorPath=${join(output, 'generator/PicoVoxel.Sdf.Generator.dll')}`,
]);
// Each case compiles author source with the generator and compares the lifted tape against the author's
// own method bit for bit, so a wasm build is not needed to settle the lifting decision.
run([join(output, 'tests/SdfGeneratorTests.dll')]);
