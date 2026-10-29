/**
 * Measure the matched native comparator's own cost, which is what the browser is measured against.
 *
 * The 1.3x target in R31 is a ratio, so it needs a denominator measured the same way as the
 * numerator. The browser app times `GeometryParityFixture.Run` and nothing else, so this driver
 * does too: it rebuilds the comparator's managed entry as a timed one, compiling the identical
 * source set the parity run compiled, and reports the geometry time that entry printed. The whole
 * process is recorded beside it, because an author pays the host's start as well.
 *
 * Each round is a fresh process, because a browser page is one too.
 *
 * Usage: node dotnet/run-performance-native.mjs <dotnet> <fixture directory> <comparator>
 *          <gyroid|heatx> <fresh out> [--rounds N]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const roundsAt = argv.indexOf('--rounds');
const rounds = roundsAt === -1 ? 3 : Number(argv[roundsAt + 1]);
const positional = roundsAt === -1 ? argv : [...argv.slice(0, roundsAt), ...argv.slice(roundsAt + 2)];
const [dotnetArg, fixtureArg, comparatorArg, subject, outputArg, ...extra] = positional;
if (
  !outputArg ||
  extra.length ||
  !['gyroid', 'heatx'].includes(subject) ||
  !Number.isInteger(rounds) ||
  rounds < 1
)
  throw new Error(
    'Usage: run-performance-native.mjs <dotnet> <fixture directory> <comparator> <gyroid|heatx> <fresh out> [--rounds N]',
  );
const [dotnet, fixture, comparator, out] = [dotnetArg, fixtureArg, comparatorArg, outputArg].map((value) =>
  resolve(value),
);
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides earlier measurements');

const shared = process.platform === 'darwin' ? 'dylib' : 'so';
const engine = join(comparator, 'native', `picogk.26.2.${shared}`);
const trig = join(comparator, 'native', `float-trig.${shared}`);
const authored = join(fixture, 'ParityFixture.csproj');
for (const path of [engine, trig, authored])
  if (!existsSync(path)) throw new Error(`The native comparator is incomplete: ${path}`);
mkdirSync(out, { recursive: true });

/*
 * The timed entry is the only file that differs from the parity run's program: the project is the
 * parity project with its entry swapped, so the fixture, the author trees and the engine reference
 * are the same items, named by the same absolute paths. Nothing measured here was recompiled from
 * different sources than the bytes the parity gate compared.
 */
const timed = join(out, 'TimedProgram.cs');
writeFileSync(
  timed,
  `// Entry point only; the fixture and every author source beside it are compiled unchanged.
var measured = System.Diagnostics.Stopwatch.StartNew();
GeometryParityFixture.Run(args);
measured.Stop();
System.Console.WriteLine($"PARITY_NATIVE_RUN {measured.Elapsed.TotalMilliseconds}");
`,
  { flag: 'wx' },
);
const project = join(out, 'TimedFixture.csproj');
const authoredProject = readFileSync(authored, 'utf8');
if (!authoredProject.includes('<Compile Include="Program.cs" />'))
  throw new Error('The parity project no longer declares its entry as Program.cs');
writeFileSync(
  project,
  authoredProject.replace('<Compile Include="Program.cs" />', `<Compile Include="${timed}" />`),
  {
    flag: 'wx',
  },
);
const binaries = join(out, 'bin');
execFileSync(
  dotnet,
  [
    'build',
    project,
    '-c',
    'Release',
    '-nologo',
    '-o',
    binaries,
    `-p:BaseIntermediateOutputPath=${join(out, 'obj')}/`,
  ],
  { stdio: 'inherit' },
);
copyFileSync(engine, join(binaries, `picogk.26.2.${shared}`));
const assembly = join(binaries, 'TimedFixture.dll');
if (!existsSync(assembly)) throw new Error('The timed comparator did not build');

/** Peak resident memory, which is what a run is bounded by on either side. */
const peakKilobytes = (stderr) => {
  const matched = /Maximum resident set size \(kbytes\): (\d+)/u.exec(stderr);
  return matched ? Number(matched[1]) : undefined;
};
/** The geometry time the entry printed, which is the figure the browser's `run` is comparable to. */
const runMilliseconds = (stdout) => {
  const matched = /^PARITY_NATIVE_RUN (\d+(?:\.\d+)?)$/mu.exec(stdout);
  if (!matched) throw new Error('The timed comparator printed no geometry time');
  return Number(matched[1]);
};
const measured = [];
for (let round = 0; round < rounds; round += 1) {
  const captures = join(out, `round-${String(round)}`);
  rmSync(captures, { recursive: true, force: true });
  const started = process.hrtime.bigint();
  // Through `time`, which reports the peak the kernel saw rather than what the process admits to.
  const run = spawnSync('/usr/bin/time', ['-v', dotnet, assembly, captures, subject], {
    cwd: out,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      [process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD']: trig,
    },
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (run.status !== 0) throw new Error(`The native fixture failed:\n${run.stderr ?? ''}`);
  measured.push({
    round,
    runMilliseconds: runMilliseconds(run.stdout ?? ''),
    milliseconds: elapsed,
    peakResidentKilobytes: peakKilobytes(run.stderr ?? ''),
  });
  const last = measured.at(-1);
  console.log(
    `native ${subject} round ${String(round)}: run ${String(Math.round(last.runMilliseconds))} ms, process ${String(
      Math.round(elapsed),
    )} ms`,
  );
}

/** The fastest round, because a slower one measured the machine rather than the program. */
const best = measured.reduce((left, right) => (right.runMilliseconds < left.runMilliseconds ? right : left));
writeFileSync(
  join(out, 'performance-native.json'),
  `${JSON.stringify(
    {
      subject,
      host: `${process.platform}-${process.arch}`,
      comparator,
      rounds: measured,
      best,
      dotnetVersion: execFileSync(dotnet, ['--version'], { encoding: 'utf8' }).trim(),
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
console.log(`native ${subject} best: ${String(Math.round(best.runMilliseconds))} ms of geometry`);
