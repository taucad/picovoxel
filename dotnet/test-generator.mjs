/** Qualify the signed-distance tape generator and the parallel callback path, neither of which needs a wasm build. */
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
// The parallel callback path: the purity proof and the column prefetch, against the serial loop's own
// values and failures. Like the generator, it needs no wasm build.
run([
  'build',
  join(here, 'tests/sdf-parallel/SdfParallelTests.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'parallel'),
  `-p:BaseIntermediateOutputPath=${join(output, 'parallel-obj')}/`,
]);
run([join(output, 'parallel/SdfParallelTests.dll')]);
// The IL lift: every corpus field reaches its expected outcome, and each lifted tape equals the
// author's own method over a dense grid, bit for bit. The browser's float trigonometry is the
// double function rounded once (dotnet/float-trig.c), so the harness is run with that preloaded
// where the platform allows it; without it, float sin/cos samples could differ from the host's
// and the harness says so rather than comparing the wrong thing.
run([
  'build',
  join(here, 'tests/sdf-il-tape/SdfIlTapeTests.csproj'),
  '-c',
  'Release',
  '-o',
  join(output, 'il-tape'),
  `-p:BaseIntermediateOutputPath=${join(output, 'il-tape-obj')}/`,
]);
const trig = join(output, process.platform === 'darwin' ? 'float-trig.dylib' : 'float-trig.so');
execFileSync(
  'clang',
  ['-O2', '-shared', '-fPIC', '-fno-builtin', join(here, 'float-trig.c'), '-o', trig, '-lm'],
  {
    cwd: here,
    stdio: 'inherit',
  },
);
execFileSync(dotnet, [join(output, 'il-tape/SdfIlTapeTests.dll')], {
  cwd: here,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(process.platform === 'darwin' ? { DYLD_INSERT_LIBRARIES: trig } : { LD_PRELOAD: trig }),
  },
});
