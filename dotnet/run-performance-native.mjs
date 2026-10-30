/**
 * Measure the matched native comparator's own cost, the denominator the browser is judged against.
 *
 * A ratio needs both sides measured the same way. The browser app times the fixture's own `Run` and
 * nothing else, so this driver rebuilds the comparator's managed entry as a timed one, from the
 * identical source set the parity run compiled, and reports the geometry time it printed. The whole
 * process is recorded beside it, because an author pays the host's start too. Each round is a fresh
 * process, because a browser page is one.
 *
 * `--prebuilt <bin>` times a timed comparator an earlier run built, from that run's `bin`, instead
 * of building one. It lets a browser path's own runner time native beside it: the build needs the
 * staged tree at its absolute paths, the timing needs only the assembly and the engine.
 *
 * Usage: node dotnet/run-performance-native.mjs <dotnet> <fixture directory> <comparator>
 *          <gyroid|heatx> <fresh out> [--rounds N] [--prebuilt <bin>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';

/** Take `--name value` out of the arguments, returning its value. */
const option = (argv, name) => {
  const at = argv.indexOf(name);
  if (at === -1) return { argv, value: undefined };
  if (at + 1 >= argv.length) throw new Error(`${name} needs a value`);
  return { argv: [...argv.slice(0, at), ...argv.slice(at + 2)], value: argv[at + 1] };
};
const roundsOption = option(process.argv.slice(2), '--rounds');
const prebuiltOption = option(roundsOption.argv, '--prebuilt');
const rounds = roundsOption.value === undefined ? 3 : Number(roundsOption.value);
const prebuilt = prebuiltOption.value === undefined ? undefined : resolve(prebuiltOption.value);
const positional = prebuiltOption.argv;
const [dotnetArg, fixtureArg, comparatorArg, subject, outputArg, ...extra] = positional;
if (
  !outputArg ||
  extra.length ||
  !['gyroid', 'heatx'].includes(subject) ||
  !Number.isInteger(rounds) ||
  rounds < 1
)
  throw new Error(
    'Usage: run-performance-native.mjs <dotnet> <fixture directory> <comparator> <gyroid|heatx> <fresh out> [--rounds N] [--prebuilt <bin>]',
  );
const [dotnet, fixture, comparator, out] = [dotnetArg, fixtureArg, comparatorArg, outputArg].map((value) =>
  resolve(value),
);
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides earlier measurements');

const shared = process.platform === 'darwin' ? 'dylib' : 'so';
const engine = join(comparator, 'native', `picogk.26.2.${shared}`);
const trig = join(comparator, 'native', `float-trig.${shared}`);
const authored = join(fixture, 'ParityFixture.csproj');
for (const path of prebuilt ? [engine, trig, join(prebuilt, 'TimedFixture.dll')] : [engine, trig, authored])
  if (!existsSync(path)) throw new Error(`The native comparator is incomplete: ${path}`);
mkdirSync(out, { recursive: true });
const binaries = join(out, 'bin');
if (prebuilt) cpSync(prebuilt, binaries, { recursive: true });
else build();
copyFileSync(engine, join(binaries, `picogk.26.2.${shared}`));
const assembly = join(binaries, 'TimedFixture.dll');
if (!existsSync(assembly)) throw new Error('The timed comparator did not build');

/** Build the timed comparator from the parity project, with only its entry swapped. */
function build() {
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
}

/*
 * GNU `time` reports the peak the kernel saw rather than what the process admits to, so it is used
 * where it exists. Where it does not, the run is still measured: the geometry time this gate judges
 * comes from the program itself, and only the peak goes unrecorded.
 */
const gnuTime = '/usr/bin/time';
const haveGnuTime = existsSync(gnuTime);

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
  const [command, args] = haveGnuTime
    ? [gnuTime, ['-v', dotnet, assembly, captures, subject]]
    : [dotnet, [assembly, captures, subject]];
  const run = spawnSync(command, args, {
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
      // Which machine, because a ratio is only matched when both sides ran on the same one.
      cpu: { model: cpus()[0]?.model, count: cpus().length },
      comparator,
      prebuilt: Boolean(prebuilt),
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
