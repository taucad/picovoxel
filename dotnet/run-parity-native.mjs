/**
 * Run the parity fixture on the matched native comparator.
 *
 * This is the reference side of I1: the pinned, unchanged author source, compiled against the
 * composed PicoGK library for this host and executed against the native engine
 * `build-native-comparator.mjs` produced, with the shared float trigonometry interposed. The
 * browser's AOT and dynamic outputs are compared against these bytes.
 *
 * The author source is never edited. It is fetched at its pin, verified against the pin's recorded
 * Git blobs, and compiled as it is; the report this driver writes is I2's evidence.
 *
 * Usage: node dotnet/run-parity-native.mjs <dotnet> <composed PicoGK csproj> <comparator> <gyroid|heatx> <fresh out>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity } from './validate-inputs.mjs';
import { fetchPinnedSource } from './fetch-pinned-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dotnetArg, projectArg, comparatorArg, subject, outputArg, ...extra] = process.argv.slice(2);
if (!outputArg || extra.length || !['gyroid', 'heatx'].includes(subject))
  throw new Error(
    'Usage: run-parity-native.mjs <dotnet> <composed PicoGK csproj> <comparator> <gyroid|heatx> <fresh out>',
  );
const [dotnet, project, comparator, out] = [dotnetArg, projectArg, comparatorArg, outputArg].map((value) =>
  resolve(value),
);
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides earlier captures');
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
mkdirSync(out, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

/*
 * Both author trees, for either subject: the fixture names the gyroid example and the HeatX task
 * in one unconditional source, so one program compiles for both and neither subject gets its own
 * variant of the fixture.
 */
const sources = {};
for (const name of ['ShapeKernel', 'HelixHeatX']) {
  const root = fetchPinnedSource(name, join(out, 'author', name));
  const identity = sourceIdentity(root, pins.sources[name]);
  sources[name] = { root, commit: identity.commit, files: Object.keys(identity.files).length };
}
writeFileSync(
  join(out, 'author-sources.json'),
  `${JSON.stringify(
    {
      // `sourceIdentity` throws on any difference, so reaching this line is the proof.
      unmodified: true,
      subject,
      subjects: Object.fromEntries(
        Object.entries(sources).map(([name, value]) => [name, { commit: value.commit, files: value.files }]),
      ),
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);

const fixture = join(out, 'fixture');
mkdirSync(fixture);
const compiled = [
  join(here, 'tests/parity/GeometryParityFixture.cs'),
  join(sources.ShapeKernel.root, 'ShapeKernel/**/*.cs'),
  join(sources.ShapeKernel.root, 'Examples/Ex_ImplicitGyroidSphere.cs'),
  join(sources.HelixHeatX.root, 'src/**/*.cs'),
];
writeFileSync(
  join(fixture, 'Program.cs'),
  '// Entry point only; the fixture and every example source below it are compiled unchanged.\nGeometryParityFixture.Run(args);\n',
);
writeFileSync(
  join(fixture, 'ParityFixture.csproj'),
  `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <NoWarn>$(NoWarn);CS0168;CS0219;CS0414;CS1591;CS8981</NoWarn>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>

  <ItemGroup>
    <Compile Include="Program.cs" />
${compiled.map((path) => `    <Compile Include="${path}" />`).join('\n')}
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="${project}" />
  </ItemGroup>

</Project>
`,
);
const binaries = join(out, 'bin');
run(dotnet, [
  'build',
  join(fixture, 'ParityFixture.csproj'),
  '-c',
  'Release',
  '-nologo',
  '-o',
  binaries,
  `-p:BaseIntermediateOutputPath=${join(out, 'obj')}/`,
]);

/** The engine and its interposed trigonometry, as the comparator built them. */
const shared = process.platform === 'darwin' ? 'dylib' : 'so';
const engine = join(comparator, 'native', `picogk.26.2.${shared}`);
const trig = join(comparator, 'native', `float-trig.${shared}`);
for (const path of [engine, trig])
  if (!existsSync(path)) throw new Error(`Comparator is incomplete: ${path}`);
copyFileSync(engine, join(binaries, `picogk.26.2.${shared}`));

const captures = join(out, 'captures');
// Through the SDK, not the apphost: the executable needs a DOTNET_ROOT this driver does not own.
run(dotnet, [join(binaries, 'ParityFixture.dll'), captures, subject], {
  cwd: out,
  env: {
    ...process.env,
    [process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD']: trig,
  },
});
const written = readdirSync(captures).sort();
const expected =
  subject === 'heatx'
    ? ['HelixHeatX.STL', 'final.mesh']
    : ['capture-0.mesh', 'capture-0.stl', 'capture-1.mesh', 'capture-1.stl'];
for (const name of expected) if (!written.includes(name)) throw new Error(`The fixture wrote no ${name}`);
console.log(`Native ${subject} captures: ${captures}`);
