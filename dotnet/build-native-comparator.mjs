/**
 * Build the matched native comparator: the same engine sources the browser archive is built from,
 * compiled for this host.
 *
 * Byte identity is a same-engine claim, so it is only meaningful against a native build of the
 * identical patched sources with the identical float trigonometry. This driver stages exactly what
 * `build-archive.mjs` stages and compiles it with the host toolchain instead of Emscripten.
 *
 * The float trigonometry is a preload library rather than a linked definition, which would bind by
 * lookup order; a preload is the deterministic interposition on both hosts.
 *
 * Usage: node dotnet/build-native-comparator.mjs <adapter directory> <fresh output> [--jobs N]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, inventory } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [adapterArg, outputArg, ...rest] = process.argv.slice(2);
const jobsFlag = rest.indexOf('--jobs');
const jobs = jobsFlag === -1 ? 4 : Number(rest[jobsFlag + 1]);
if (!outputArg || (jobsFlag !== -1 && rest.length !== 2) || (jobsFlag === -1 && rest.length))
  throw new Error('Usage: build-native-comparator.mjs <adapter directory> <fresh output> [--jobs N]');
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('jobs must be an integer from 1 to 64');
const [adapter, out] = [adapterArg, outputArg].map((value) => resolve(value));
if (existsSync(out)) throw new Error('Output must be fresh; a reused tree hides a stale comparator');
const dependencies = JSON.parse(readFileSync(join(here, 'archive-sources.json'), 'utf8'));
mkdirSync(out, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const query = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trim();
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

const hostRid = `${process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
if (!/^(osx|linux)-(x64|arm64)$/u.test(hostRid)) throw new Error('The comparator requires macOS or Linux');
const shared = process.platform === 'darwin' ? 'dylib' : 'so';
const compiler = process.env['CXX'] ?? 'clang++';
const cCompiler = process.env['CC'] ?? 'clang';

const source = join(out, 'source');
mkdirSync(source);
for (const [name, pin] of Object.entries(dependencies)) {
  const response = await fetch(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Download ${name}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== pin.sha256) throw new Error(`Source digest mismatch: ${name}`);
  const archive = join(out, `${name}.tar.gz`);
  writeFileSync(archive, bytes, { flag: 'wx' });
  // OpenVDB lives inside the runtime tree, exactly as the archive build stages it.
  const target = name === 'openvdb' ? join(source, 'runtime/openvdb') : join(source, name);
  mkdirSync(target, { recursive: true });
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
  const patches = { runtime: 'PicoGKRuntime', openvdb: 'openvdb', tbb: 'oneTBB' }[name];
  if (patches)
    for (const patch of readdirSync(join(here, '../patches', patches))
      .filter((file) => file.endsWith('.patch'))
      .sort())
      run('patch', ['-p1', '--fuzz=0', '-i', join(here, '../patches', patches, patch)], { cwd: target });
}
run('patch', ['-p1', '--fuzz=0', '-i', join(adapter, 'Runtime.browser.patch')], {
  cwd: join(source, 'runtime'),
});
write(join(out, 'staged-source.json'), inventory(source));

const prefix = join(out, 'prefix');
/** The flags the recorded same-engine comparison was built with; never add fast math. */
const flags = ['-O3', '-ffp-contract=off', '-fPIC'];
const build = (name, path, options, target = 'install') => {
  const directory = join(out, `build-${name}`);
  run('cmake', [
    '-G',
    'Ninja',
    '-S',
    path,
    '-B',
    directory,
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    `-DCMAKE_C_COMPILER=${cCompiler}`,
    `-DCMAKE_CXX_COMPILER=${compiler}`,
    `-DCMAKE_C_FLAGS=${flags.join(' ')}`,
    `-DCMAKE_CXX_FLAGS=${flags.join(' ')}`,
    ...options,
  ]);
  run('cmake', ['--build', directory, '-j', String(jobs), '--target', target]);
};
build('tbb', join(source, 'tbb'), [
  '-DTBB_STRICT=OFF',
  '-DTBB_TEST=OFF',
  '-DTBB_EXAMPLES=OFF',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON',
]);
build(
  'zlib',
  join(source, 'blosc/internal-complibs/zlib-1.3.1'),
  ['-DZLIB_BUILD_EXAMPLES=OFF'],
  'zlibstatic',
);
mkdirSync(join(prefix, 'lib'), { recursive: true });
mkdirSync(join(prefix, 'include'), { recursive: true });
copyFileSync(join(out, 'build-zlib/libz.a'), join(prefix, 'lib/libz.a'));
copyFileSync(join(out, 'build-zlib/zconf.h'), join(prefix, 'include/zconf.h'));
copyFileSync(join(source, 'blosc/internal-complibs/zlib-1.3.1/zlib.h'), join(prefix, 'include/zlib.h'));
build('blosc', join(source, 'blosc'), [
  '-DBUILD_TESTS=OFF',
  '-DBUILD_BENCHMARKS=OFF',
  '-DBUILD_FUZZERS=OFF',
  '-DBUILD_SHARED=OFF',
  '-DBUILD_STATIC=ON',
  '-DDEACTIVATE_SSE2=ON',
  '-DDEACTIVATE_AVX2=ON',
  '-DPREFER_EXTERNAL_ZLIB=ON',
  `-DZLIB_INCLUDE_DIR=${prefix}/include`,
  `-DZLIB_LIBRARY=${prefix}/lib/libz.a`,
  '-DPREFER_EXTERNAL_LZ4=OFF',
  '-DPREFER_EXTERNAL_ZSTD=OFF',
]);
build('openvdb', join(source, 'runtime/openvdb'), [
  '-DOPENVDB_USE_DELAYED_LOADING=OFF',
  '-DUSE_BLOSC=ON',
  '-DUSE_ZLIB=ON',
  '-DUSE_EXR=OFF',
  '-DOPENVDB_BUILD_BINARIES=OFF',
  '-DOPENVDB_BUILD_UNITTESTS=OFF',
  '-DOPENVDB_BUILD_PYTHON_MODULE=OFF',
  '-DOPENVDB_BUILD_NANOVDB=OFF',
  '-DOPENVDB_CORE_SHARED=OFF',
  '-DOPENVDB_CORE_STATIC=ON',
  '-DUSE_EXPLICIT_INSTANTIATION=OFF',
  `-DTBB_ROOT=${prefix}`,
  `-DBlosc_INCLUDE_DIR=${prefix}/include`,
  `-DBlosc_LIBRARY_RELEASE=${prefix}/lib/libblosc.a`,
  `-DZLIB_INCLUDE_DIR=${prefix}/include`,
  `-DZLIB_LIBRARY=${prefix}/lib/libz.a`,
  '-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH',
  '-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH',
]);

const includes = ['runtime/Source', 'runtime/API']
  .map((path) => `-I${join(source, path)}`)
  .concat(`-I${join(here, '../shim')}`, `-I${prefix}/include`);
const native = join(out, 'native');
mkdirSync(native);
const objects = [];
/*
 * The tape evaluator is not built here. `src/pico-tape.cpp` is a wasm translation unit — it
 * includes `wasm_simd128.h` and partitions work with Emscripten's threading — so it has no native
 * form, and its two exports are excluded from the comparator's symbol requirement below. That is
 * the right shape for I1 rather than a gap in it: the tape is a browser-side evaluation of the
 * author's own signed distance, and the gate is that it reproduces these native bytes exactly.
 */
for (const [name, input] of [
  ['core', join(source, 'runtime/Source/PicoGKLibrary.cpp')],
  ['callbacks', join(adapter, 'browser-callbacks.cpp')],
]) {
  const object = join(out, `${name}.o`);
  run(compiler, [
    '-std=c++20',
    ...flags,
    /*
     * `PicoGK.h` uses the fixed-width integer names without including `<cstdint>`; Emscripten's
     * libc++ provides them transitively and this host's standard library does not. Forcing the
     * header in is a flag, not a source change: I2 keeps these trees unpatched beyond the patches
     * the archive build applies.
     */
    '-include',
    'cstdint',
    '-DPICOGK_HEADLESS',
    '-DPICOGK_BUILD_LIBRARY',
    ...includes,
    '-c',
    input,
    '-o',
    object,
  ]);
  objects.push(object);
}
const library = join(native, `picogk.26.2.${shared}`);
run(compiler, [
  process.platform === 'darwin' ? '-dynamiclib' : '-shared',
  ...objects,
  ...['libopenvdb.a', 'libtbb.a', 'libblosc.a', 'libz.a'].map((name) => join(prefix, 'lib', name)),
  '-o',
  library,
]);
// The interposed trigonometry both sides share, as its own preload library.
const trig = join(native, `float-trig.${shared}`);
run(cCompiler, [
  ...flags,
  '-fno-builtin',
  process.platform === 'darwin' ? '-dynamiclib' : '-shared',
  join(here, 'float-trig.c'),
  '-o',
  trig,
]);

/** The engine exports the host imports; a missing one is a build failure, not a run-time surprise. */
const defined = new Set(
  query(process.platform === 'darwin' ? 'nm' : 'nm', ['--defined-only', '--extern-only', library])
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).at(-1)?.replace(/^_/u, '')),
);
/** The browser-only tape exports, which no native build of these sources defines. */
const wasmOnly = ['Voxels_IntersectImplicitTape', 'Voxels_RenderImplicitTape'];
const required = JSON.parse(readFileSync(join(adapter, 'required-symbols.json'), 'utf8')).filter(
  (name) => !wasmOnly.includes(name),
);
for (const name of required) if (!defined.has(name)) throw new Error(`Missing comparator symbol: ${name}`);
if ([...defined].some((name) => /^(?:Viewer_|TauViewer_|glfw)/u.test(name ?? '')))
  throw new Error('Native Viewer entered the headless comparator');
write(join(out, 'symbols.json'), {
  required,
  excluded: wasmOnly,
  defined: [...defined].filter(Boolean).sort((left, right) => left.localeCompare(right)),
});

// The engine's own C++ corpus, built and run against this library, before any managed comparison.
const check = join(out, 'core-test');
run(compiler, [
  '-std=c++20',
  ...flags,
  '-include',
  'cstdint',
  '-DPICOGK_BUILD_LIBRARY',
  ...includes,
  join(adapter, 'tests/browser-core.cpp'),
  library,
  '-o',
  check,
]);
run(check, [], {
  cwd: out,
  env: {
    ...process.env,
    [process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD']: trig,
  },
});

write(join(out, 'outputs.json'), inventory(native));
write(join(out, 'inputs.json'), {
  schemaVersion: 1,
  comparator: 'picovoxel-native',
  hostRid,
  compiler: { cxx: query(compiler, ['--version']).split('\n')[0], flags },
  sources: dependencies,
  adapter: inventory(adapter),
  trig: digest(readFileSync(join(here, 'float-trig.c'))),
});
console.log(`Verified native comparator: ${native}`);
