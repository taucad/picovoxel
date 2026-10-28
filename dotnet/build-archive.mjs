/** Build a private browser archive from verified source and workload inputs. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, digest, inventory, verify } from './validate-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, 'inputs.json')));
const dependencies = JSON.parse(readFileSync(join(here, 'archive-sources.json')));
const [configuration, destination, ...extra] = process.argv.slice(2);
if (!configuration || !destination || extra.length)
  throw new Error('Usage: build-archive.sh <configuration.json> <new output directory>');
const config = JSON.parse(readFileSync(configuration));
if (config.purpose !== 'inputs' || config.comparator !== 'picovoxel-browser')
  throw new Error('Archive producer requires picovoxel-browser inputs');
const out = resolve(destination);
mkdirSync(out); // A fresh output is mandatory; never reuse a partly built archive.
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
const query = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const threaded = config.execution === 'threaded';
const flags = [
  '-O3',
  '-msimd128',
  '-ffp-contract=off',
  '-fwasm-exceptions',
  '-sWASM_LEGACY_EXCEPTIONS=0',
  ...(threaded ? ['-pthread'] : []),
];
if (JSON.stringify(config.flags) !== JSON.stringify(flags))
  throw new Error('Configuration flags must exactly match the archive build flags');
for (const name of ['adapter', 'shim', ...Object.keys(dependencies)])
  if (!config.files?.[name]) throw new Error(`Missing declared input: ${name}`);
// The builder itself is an input, so a cache cannot claim an older producer.
for (const name of ['build-archive.sh', 'build-archive.mjs', 'archive-sources.json', 'float-trig.c'])
  config.files[`producer/${name}`] = join(here, name);
const before = capture(config);
write(join(out, 'inputs.json'), before);
// Resolve only after capture has admitted the actual executable and runtime pack.
const properties = JSON.parse(
  query(
    config.dotnet,
    ['msbuild', join(here, 'toolchain.csproj'), '-nologo', '-getProperty:EmscriptenSdkToolsPath,NetCoreRoot'],
    { cwd: here },
  ),
).Properties;
const tools = resolve(properties.EmscriptenSdkToolsPath);
const scripts = join(out, 'emscripten');
cpSync(join(tools, 'emscripten'), scripts, { recursive: true, dereference: true });
verify(inventory(scripts), inventory(join(tools, 'emscripten')));
const pack = (name) => join(properties.NetCoreRoot, 'packs', name, pins.runtime);
const env = {
  ...process.env,
  SOURCE_DATE_EPOCH: '0',
  TZ: 'UTC',
  LC_ALL: 'C',
  DOTNET_EMSCRIPTEN_LLVM_ROOT: join(tools, 'bin'),
  DOTNET_EMSCRIPTEN_BINARYEN_ROOT: tools,
  DOTNET_EMSCRIPTEN_NODE_JS: join(
    pack(`Microsoft.NET.Runtime.Emscripten.${pins.emscriptenPackage}.Node.${config.nativeRid}`),
    'tools/bin/node',
  ),
  EM_CACHE: join(out, 'emscripten-cache'),
};
cpSync(
  join(
    pack(`Microsoft.NET.Runtime.Emscripten.${pins.emscriptenPackage}.Cache.${config.nativeRid}`),
    'tools/emscripten/cache',
  ),
  env.EM_CACHE,
  { recursive: true, dereference: true },
);
const em = (name) => join(scripts, name);
const source = join(out, 'source');
mkdirSync(source);
/** Copy precisely the files whose bytes were admitted, with no ignored extras. */
function stage(root, files, target) {
  for (const [name, expected] of Object.entries(files)) {
    const input = join(root, name);
    if (digest(readFileSync(input)) !== expected) throw new Error(`Input changed while staging: ${input}`);
    const output = join(target, name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
}
const pv = join(source, 'picovoxel');
stage(config.sources.picovoxel, before.sources.picovoxel.files, pv);
const adapter = join(source, 'adapter');
stage(config.files.adapter, before.files.adapter, adapter);
stage(config.files.shim, before.files.shim, join(source, 'shim'));
copyFileSync(join(here, 'float-trig.c'), join(source, 'float-trig.c'));
for (const [name, pin] of Object.entries(dependencies)) {
  const archive = resolve(config.files[name]);
  if (digest(readFileSync(archive)) !== pin.sha256) throw new Error(`Wrong ${name} archive`);
  const target = name === 'openvdb' ? join(source, 'runtime/openvdb') : join(source, name);
  mkdirSync(target, { recursive: true });
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
  const patchDirectory = { runtime: 'PicoGKRuntime', openvdb: 'openvdb', tbb: 'oneTBB' }[name];
  if (patchDirectory)
    for (const patch of readdirSync(join(pv, 'patches', patchDirectory))
      .filter((name) => name.endsWith('.patch'))
      .sort())
      run('patch', ['-p1', '--fuzz=0', '-i', join(pv, 'patches', patchDirectory, patch)], { cwd: target });
}
run('patch', ['-p1', '--fuzz=0', '-i', join(adapter, 'Runtime.browser.patch')], {
  cwd: join(source, 'runtime'),
});
write(join(out, 'staged-source.json'), inventory(source));
const prefix = join(out, 'prefix');
const stableFlags = [
  ...flags,
  `-ffile-prefix-map=${out}=/picogk-build`,
  `-ffile-prefix-map=${tools}=/dotnet-emscripten`,
];
const jobs = config.jobs ?? 4;
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('jobs must be an integer from 1 to 64');
function build(name, path, options, target = 'install') {
  const build = join(out, `build-${name}`);
  run(
    em('emcmake'),
    [
      'cmake',
      '-G',
      'Ninja',
      '-S',
      path,
      '-B',
      build,
      '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      `-DCMAKE_C_FLAGS=${stableFlags.join(' ')}`,
      `-DCMAKE_CXX_FLAGS=${stableFlags.join(' ')}`,
      ...options,
    ],
    { env },
  );
  run('cmake', ['--build', build, '-j', String(jobs), '--target', target], { env });
}
build('tbb', join(source, 'tbb'), [
  '-DTBB_STRICT=OFF',
  '-DTBB_TEST=OFF',
  '-DTBB_EXAMPLES=OFF',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON',
  ...(threaded ? [] : ['-DEMSCRIPTEN_WITHOUT_PTHREAD=true']),
  '-DTBB_EMSCRIPTEN_STACK_SIZE=1048576',
]);
// zlib1.3.1 always defines a shared target. Only its static target is needed;
// the matched .NET sysroot deliberately omits the threaded PIC startup objects.
build(
  'zlib',
  join(source, 'blosc/internal-complibs/zlib-1.3.1'),
  ['-DZLIB_BUILD_EXAMPLES=OFF'],
  'zlibstatic',
);
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
const includes = ['runtime/Source', 'runtime/API', 'shim']
  .map((path) => `-I${join(source, path)}`)
  .concat(`-I${prefix}/include`);
const native = join(out, 'native');
mkdirSync(native);
const objects = [];
for (const [name, input] of [
  ['core', 'runtime/Source/PicoGKLibrary.cpp'],
  ['callbacks', 'adapter/browser-callbacks.cpp'],
  ['tape', 'picovoxel/src/pico-tape.cpp'],
]) {
  const object = join(out, `${name}.o`);
  run(
    em('em++'),
    [
      '-std=c++20',
      ...stableFlags,
      '-DPICOGK_HEADLESS',
      '-DPICOGK_BUILD_LIBRARY',
      ...includes,
      '-c',
      join(source, input),
      '-o',
      object,
    ],
    { env },
  );
  objects.push(object);
}
run(join(tools, 'bin/llvm-ar'), ['rcsD', join(native, 'picogk.26.2.a'), ...objects], { env });
run(
  em('emcc'),
  [...stableFlags, '-fno-builtin', '-c', join(source, 'float-trig.c'), '-o', join(native, 'float-trig.o')],
  { env },
);
for (const name of ['libopenvdb.a', 'libtbb.a', 'libblosc.a', 'libz.a'])
  copyFileSync(join(prefix, 'lib', name), join(native, name));
const symbols = query(join(tools, 'bin/llvm-nm'), [
  '--defined-only',
  '--extern-only',
  join(native, 'picogk.26.2.a'),
]);
const names = new Set(symbols.split('\n').map((line) => line.trim().split(/\s+/).at(-1)));
const required = JSON.parse(readFileSync(join(adapter, 'required-symbols.json')));
if (
  !Array.isArray(required) ||
  !required.length ||
  required.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
)
  throw new Error('Invalid symbol inventory');
for (const name of required) if (!names.has(name)) throw new Error(`Missing archive symbol: ${name}`);
if ([...names].some((name) => /^(Viewer_|TauViewer_|glfw)/.test(name)))
  throw new Error('Native Viewer entered headless archive');
write(join(out, 'symbols.json'), { required, defined: [...names].filter(Boolean).sort() });
const exports = [...new Set(['_main', ...required.map((name) => `_${name}`)])].sort();
write(join(out, 'exports.json'), exports);
run(
  em('em++'),
  [
    '-std=c++20',
    ...stableFlags,
    '-DPICOGK_BUILD_LIBRARY',
    ...includes,
    join(adapter, 'tests/browser-core.cpp'),
    join(native, 'picogk.26.2.a'),
    ...['libopenvdb.a', 'libtbb.a', 'libblosc.a', 'libz.a'].map((name) => join(native, name)),
    `-sEXPORTED_FUNCTIONS=@${out}/exports.json`,
    '-sALLOW_MEMORY_GROWTH=1',
    '-sMAXIMUM_MEMORY=4294967296',
    '-sSTACK_SIZE=8388608',
    '-sENVIRONMENT=node,web,worker',
    ...(threaded ? ['-sPTHREAD_POOL_SIZE=4'] : []),
    '-o',
    join(out, 'link-check.mjs'),
  ],
  { env },
);
// Receipt verification includes all original inputs; generated build/cache files are outside them.
verify(capture(config), before);
const inputsSha256 = digest(readFileSync(join(out, 'inputs.json')));
for (const name of readdirSync(native).sort()) {
  write(join(out, `${name}.metadata.json`), {
    schemaVersion: 1,
    execution: config.execution,
    emscripten: pins.emscripten,
    emscriptenRevision: pins.emscriptenRevision,
    runtime: pins.runtime,
    sha256: digest(readFileSync(join(native, name))),
    inputsSha256,
  });
}
write(join(out, 'outputs.json'), inventory(native));
console.log(`Verified ${config.execution} archive: ${native}`);
