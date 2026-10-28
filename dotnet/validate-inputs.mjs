/** Pin and revalidate the concrete inputs to one dual-runtime build. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const roles = ['leap-shipped', 'tau-native', 'picovoxel-native', 'picovoxel-browser'];

/** Hash bytes without relying on file timestamps or cache stamps. */
export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Run a tool without shell interpolation, preserving failures. */
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options }).trim();
}

/** Require exact identities, including patch versions. */
function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, found ${actual}`);
}

/** Inventory a complete tree; reject links so files cannot escape its root. */
export function inventory(path, allowInternalFileLinks = false) {
  const entries = {};
  function visit(current, name) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(current);
      const offset = relative(realpathSync(path), target);
      if (
        !allowInternalFileLinks ||
        offset.startsWith('..') ||
        isAbsolute(offset) ||
        !lstatSync(target).isFile()
      ) {
        throw new Error(`Input symlink is not admitted: ${current}`);
      }
      entries[name] = { target: offset, sha256: digest(readFileSync(target)) };
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(current).sort())
        visit(join(current, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) {
      entries[name || '.'] = digest(readFileSync(current));
    } else throw new Error(`Unsupported input: ${current}`);
  }
  visit(path, '');
  if (!Object.keys(entries).length) throw new Error(`Empty input: ${path}`);
  return entries;
}

/** Compare source bytes to pinned Git blobs, independent of assume-unchanged flags. */
export function sourceIdentity(root, pin) {
  const list = run('git', ['ls-tree', '-r', '-z', pin.commit, '--', ...pin.paths], { cwd: root });
  const files = {};
  for (const entry of list.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    const [mode, type, expected] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode))
      throw new Error(`Unsupported source entry: ${path}`);
    const file = join(root, path);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error(`Non-file source: ${path}`);
    const bytes = readFileSync(file);
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    equal(actual, expected, `Dirty source ${path}`);
    files[path] = digest(bytes);
  }
  if (!Object.keys(files).length) throw new Error('Pinned source selection is empty');
  const extra = run('git', ['ls-files', '--others', '--exclude-standard', '--', ...pin.paths], { cwd: root });
  if (extra) throw new Error(`Untracked source inputs: ${extra}`);
  const tracked = run('git', ['diff', '--name-only', pin.commit, '--', ...pin.paths], { cwd: root });
  if (tracked) throw new Error(`Changed source selection: ${tracked}`);
  return { commit: pin.commit, files };
}

/** Follow SDK-pack precedence, otherwise require the exact restored NuGet runtime. */
export function resolveRuntimePack(sdkPath, nugetPath) {
  return realpathSync(existsSync(sdkPath) ? sdkPath : nugetPath);
}

/** Resolve the workload selected by MSBuild, then compare its compiler to Mono's build metadata. */
export function toolchainIdentity(dotnet, nuget, hostRid, execution = 'serial') {
  const resolved = JSON.parse(
    run(
      dotnet,
      [
        'msbuild',
        join(here, 'toolchain.csproj'),
        '-nologo',
        `-p:WasmEnableThreads=${execution === 'threaded'}`,
        '-target:ProcessFrameworkReferences',
        '-getItem:RuntimePack',
        '-getProperty:NETCoreSdkVersion,EmscriptenVersion,EmscriptenRevision,EmscriptenSdkToolsPath,NetCoreRoot',
      ],
      { cwd: here },
    ),
  );
  const properties = resolved.Properties;
  equal(properties.NETCoreSdkVersion, pins.sdk, 'SDK');
  equal(properties.EmscriptenVersion, pins.emscripten, 'Resolved emcc');
  equal(properties.EmscriptenRevision, pins.emscriptenRevision, 'Resolved emcc revision');
  const root = realpathSync(properties.NetCoreRoot);
  const pack = (name) => join(root, 'packs', name, pins.runtime);
  const tools = realpathSync(properties.EmscriptenSdkToolsPath);
  equal(
    tools,
    realpathSync(
      join(pack(`Microsoft.NET.Runtime.Emscripten.${pins.emscriptenPackage}.Sdk.${hostRid}`), 'tools'),
    ),
    'Compiler pack',
  );
  const runtimeName =
    execution === 'threaded'
      ? 'Microsoft.NETCore.App.Runtime.Mono.multithread.browser-wasm'
      : 'Microsoft.NETCore.App.Runtime.Mono.browser-wasm';
  const selected = resolved.Items.RuntimePack.find((item) => item.RuntimeIdentifier === 'browser-wasm');
  equal(selected?.Identity, runtimeName, 'Selected runtime pack');
  equal(selected?.NuGetPackageVersion, pins.runtime, 'Selected runtime version');
  const mono = resolveRuntimePack(pack(runtimeName), join(nuget, runtimeName.toLowerCase(), pins.runtime));
  const runtimeProps = JSON.parse(
    readFileSync(join(mono, 'runtimes/browser-wasm/native/src/wasm-props.json'), 'utf8'),
  );
  const runtime = Object.fromEntries(
    runtimeProps.items.EmccProperties.map(({ identity, value }) => [identity, value]),
  );
  equal(runtime.RuntimeEmccVersion, pins.emscripten, 'Runtime emcc');
  equal(runtime.RuntimeEmccVersionHash, pins.emscriptenRevision, 'Runtime emcc revision');
  const node = join(
    pack(`Microsoft.NET.Runtime.Emscripten.${pins.emscriptenPackage}.Node.${hostRid}`),
    'tools/bin/node',
  );
  const env = {
    ...process.env,
    EMSDK_PYTHON: join(here, 'python-no-bytecode.sh'),
    PICOGK_PYTHON: process.env.EMSDK_PYTHON ?? 'python3',
    DOTNET_EMSCRIPTEN_LLVM_ROOT: join(tools, 'bin'),
    DOTNET_EMSCRIPTEN_BINARYEN_ROOT: tools,
    DOTNET_EMSCRIPTEN_NODE_JS: node,
  };
  const compiler = run(join(tools, 'emscripten/emcc'), ['--version'], { env });
  equal(compiler.split('\n')[0], runtime.RuntimeEmccVersionRaw, 'Compiler executable');
  const inputs = {
    sdk: inventory(join(root, 'sdk', pins.sdk), true),
    mono: inventory(mono),
    dotnet: inventory(dotnet),
    host: inventory(join(root, 'host/fxr', pins.runtime)),
    nativeRuntime: inventory(join(root, 'shared/Microsoft.NETCore.App', pins.runtime)),
    aotCompiler: inventory(pack(`Microsoft.NETCore.App.Runtime.AOT.${hostRid}.Cross.browser-wasm`)),
    aotTasks: inventory(pack('Microsoft.NET.Runtime.MonoAOTCompiler.Task')),
    monoTargets: inventory(pack('Microsoft.NET.Runtime.MonoTargets.Sdk')),
    emscriptenCache: inventory(
      pack(`Microsoft.NET.Runtime.Emscripten.${pins.emscriptenPackage}.Cache.${hostRid}`),
    ),
    references: inventory(join(pack('Microsoft.NETCore.App.Ref'), 'ref/net11.0')),
    compiler: inventory(tools, true),
    node: inventory(dirname(node)),
    wasmSdk: inventory(pack('Microsoft.NET.Runtime.WebAssembly.Sdk')),
  };
  for (const [path, expected] of Object.entries(pins.compilerFiles)) {
    const actual = digest(readFileSync(join(nuget, path)));
    equal(actual, expected, `Roslyn ${path}`);
    inputs[path] = { '.': actual };
  }
  const manifest = join(
    root,
    'sdk-manifests/11.0.100-rc.3/microsoft.net.workload.mono.toolchain.current',
    pins.workload,
    'WorkloadManifest.json',
  );
  equal(JSON.parse(readFileSync(manifest, 'utf8')).version, pins.workload, 'Workload manifest');
  inputs.workload = inventory(manifest);
  inputs.emscriptenManifest = inventory(
    join(
      root,
      'sdk-manifests/11.0.100-rc.3/microsoft.net.workload.emscripten.current',
      pins.workload,
      'WorkloadManifest.json',
    ),
  );
  return { sdk: pins.sdk, runtime: pins.runtime, emscripten: pins.emscripten, compiler, hostRid, inputs };
}

/** Reject cached browser binaries made with a different compiler or execution mode. */
export function artifactIdentity(artifact, execution, sources, files, flags) {
  const metadata = JSON.parse(readFileSync(artifact.metadata, 'utf8'));
  equal(metadata.schemaVersion, 1, 'Artifact schema');
  equal(metadata.execution, execution, 'Artifact execution');
  equal(metadata.emscripten, pins.emscripten, 'Artifact emcc');
  equal(metadata.emscriptenRevision, pins.emscriptenRevision, 'Artifact emcc revision');
  equal(metadata.runtime, pins.runtime, 'Artifact runtime');
  const sha256 = digest(readFileSync(artifact.path));
  equal(sha256, metadata.sha256, 'Artifact bytes');
  if (!/^[a-f0-9]{64}$/.test(metadata.inputsSha256 ?? ''))
    throw new Error('Artifact input receipt is required');
  const receipt = readFileSync(artifact.inputs);
  equal(digest(receipt), metadata.inputsSha256, 'Artifact producer inputs');
  const producer = JSON.parse(receipt);
  equal(producer.toolchain?.sdk, pins.sdk, 'Artifact producer SDK');
  equal(producer.toolchain?.runtime, pins.runtime, 'Artifact producer runtime');
  equal(producer.toolchain?.emscripten, pins.emscripten, 'Artifact producer emcc');
  equal(producer.execution, execution, 'Artifact producer execution');
  if (!sources || !Object.keys(sources).length) throw new Error('Expected artifact sources are required');
  equal(
    digest(JSON.stringify(producer.sources)),
    digest(JSON.stringify(sources)),
    'Artifact producer sources',
  );
  equal(digest(JSON.stringify(producer.files)), digest(JSON.stringify(files)), 'Artifact staged inputs');
  equal(digest(JSON.stringify(producer.flags)), digest(JSON.stringify(flags)), 'Artifact build flags');
  return { metadata, sha256 };
}

/** Capture one explicitly named comparator and its binary/source inputs. */
export function capture(config) {
  if (!['inputs', 'link'].includes(config.purpose)) throw new Error('Purpose must be inputs or link');
  if (
    config.purpose === 'link' &&
    config.comparator === 'picovoxel-browser' &&
    !Object.keys(config.browserArtifacts ?? {}).length
  )
    throw new Error('Browser link requires producer-attested archives');
  if (!roles.includes(config.comparator)) throw new Error('An explicit comparator is required');
  if (!/^(osx|linux|win)-(arm64|x64)$/.test(config.nativeRid ?? ''))
    throw new Error('An explicit native RID is required');
  if (!['serial', 'threaded'].includes(config.execution))
    throw new Error('Execution must be serial or threaded');
  if (!config.files || !Object.keys(config.files).length)
    throw new Error('Explicit binary/staged input files are required');
  const sources = {};
  for (const [name, pin] of Object.entries(pins.sources)) {
    if (!config.sources?.[name]) throw new Error(`Missing source: ${name}`);
    sources[name] = sourceIdentity(resolve(config.sources[name]), pin);
  }
  const files = {};
  for (const name of Object.keys(config.files).sort()) files[name] = inventory(resolve(config.files[name]));
  const artifacts = {};
  for (const [name, artifact] of Object.entries(config.browserArtifacts ?? {}))
    artifacts[name] = artifactIdentity(artifact, config.execution, sources, files, config.flags ?? []);
  return {
    schemaVersion: 1,
    driverSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    globalJsonSha256: digest(readFileSync(join(here, 'global.json'))),
    projectSha256: digest(readFileSync(join(here, 'toolchain.csproj'))),
    pinsSha256: digest(readFileSync(join(here, 'inputs.json'))),
    purpose: config.purpose,
    comparator: config.comparator,
    nativeRid: config.nativeRid,
    execution: config.execution,
    flags: config.flags ?? [],
    artifacts,
    sources,
    files,
    toolchain: toolchainIdentity(
      resolve(config.dotnet),
      resolve(config.nuget),
      config.nativeRid,
      config.execution,
    ),
  };
}

/** Refuse any stale receipt; record is deliberately separate from verification. */
export function verify(actual, expected) {
  if (digest(JSON.stringify(actual)) === digest(JSON.stringify(expected))) return;
  const changed = [];
  function compare(left, right, pointer) {
    if (JSON.stringify(left) === JSON.stringify(right) || changed.length >= 20) return;
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        compare(left[key], right[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    } else changed.push(pointer);
  }
  compare(actual, expected, '');
  throw new Error(`Build input receipt changed (first 20 paths): ${changed.join(', ') || 'key order'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, configPath, receiptPath, ...extra] = process.argv.slice(2);
    if (!['record', 'verify'].includes(command) || !configPath || !receiptPath || extra.length) {
      throw new Error('Usage: node dotnet/validate-inputs.mjs record|verify <config.json> <receipt.json>');
    }
    const actual = capture(JSON.parse(readFileSync(configPath, 'utf8')));
    if (command === 'record')
      writeFileSync(receiptPath, `${JSON.stringify(actual, null, 2)}\n`, { flag: 'wx' });
    else verify(actual, JSON.parse(readFileSync(receiptPath, 'utf8')));
    console.log(`${command}: ${actual.comparator} ${actual.nativeRid} ${actual.execution} inputs verified`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
