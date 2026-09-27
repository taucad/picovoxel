#!/usr/bin/env node
// Clean-room consumer smoke for the frozen candidate (create-repo §6). Installs
// the packed tarball into an empty npm project on the running Node, then, from
// that project only:
// - runs the README quick start through `picovoxel` and `picovoxel/multi` (the
//   multi pool must engage and match serial byte for byte);
// - imports every JavaScript subpath, and resolves every asset subpath with
//   `import.meta.resolve` to the sibling file the entry loads by default;
// - runs the README host overrides from the asset subpaths: `locateFile` on the
//   serial entry, and `mainScriptUrlOrBlob` (a filesystem path in Node) plus
//   `instantiateWasm` with a precompiled module on the multi entry;
// - proves every JavaScript subpath fails `require()` with the ESM-only
//   diagnostic, while `require.resolve` still finds `picovoxel/package.json`
//   and the assets;
// - typechecks consumers with the pinned TypeScript: ESM on `nodenext` and on
//   `bundler` compile against every script subpath, while a CommonJS
//   `nodenext` consumer (`import x = require(...)`) fails with TS2339 on each,
//   because the `require` condition's types are `never`;
// - builds HelixHeatX at 2.0 mm through `picovoxel/multi` and requires its G0
//   tuple to equal test/fixtures/g0-candidate.json (close-out D32): the tarball
//   computes the pinned geometry, not merely a mesh. The example sources are
//   copied into the project, so they import the installed package by name.
// Nothing is rebuilt and no repository module is imported.
//
// Usage: node scripts/test-package.mjs <candidate-directory>

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidate = resolve(process.argv[2] ?? 'candidate');
const { packages } = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
const root = packages.find(({ name }) => name === 'picovoxel');
if (!root) throw new Error('candidate manifest has no picovoxel package');

// `three` is the optional peer behind picovoxel/three; install the exact
// version the repository tests against.
const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exact = (name) => {
  const version = devDependencies[name];
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? ''))
    throw new Error(`package.json must pin an exact ${name} devDependency`);
  return `${name}@${version}`;
};

const smoke = String.raw`
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const quickStart = async (entry, wasm) => {
  const { createPico } = await import(entry);
  const pico = await createPico({ voxelSize: 0.5, wasm });
  try {
    const sphere = pico.createVoxels({ shape: 'sphere', radius: 10 });
    const gyroid = sphere.maskedByImplicit({
      sdf: (x, y, z) =>
        Math.abs(Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x)) - 0.4,
    });
    const stl = gyroid.toMesh().toStl();
    const triangles = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
    assert.ok(triangles > 0, entry + ' produced an empty mesh');
    assert.equal(stl.byteLength, 84 + 50 * triangles, entry + ' produced a malformed binary STL');
    return { stl: Buffer.from(stl), workers: pico.module.PThread?.runningWorkers.length ?? 0 };
  } finally {
    pico.dispose();
  }
};

const serial = await quickStart('picovoxel');
const multi = await quickStart('picovoxel/multi');
assert.ok(multi.workers > 0, 'picovoxel/multi never engaged its worker pool');
assert.ok(multi.stl.equals(serial.stl), 'picovoxel/multi and picovoxel disagree on the quick start');

// Asset subpaths: each resolves to the sibling its entry loads by default, so a
// host that relocates them and a host that does not load the same bytes.
const assets = {
  'picovoxel/wasm': ['picovoxel', 'pico.wasm'],
  'picovoxel/glue': ['picovoxel', 'pico.mjs'],
  'picovoxel/multi/wasm': ['picovoxel/multi', 'pico-multi.wasm'],
  'picovoxel/multi/worker': ['picovoxel/multi', 'pico-multi.mjs'],
};
for (const [specifier, [entry, sibling]] of Object.entries(assets)) {
  const url = import.meta.resolve(specifier);
  assert.equal(url, new URL(sibling, import.meta.resolve(entry)).href, specifier + ' is not the sibling ' + entry + ' loads');
  assert.ok(existsSync(fileURLToPath(url)), specifier + ' resolves to a missing file');
}
for (const specifier of ['picovoxel/wasm', 'picovoxel/multi/wasm']) {
  await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve(specifier))));
}

// README host overrides, driven from the asset subpaths.
const located = [];
const serialLocated = await quickStart('picovoxel', {
  locateFile: (file) => {
    located.push(file);
    return import.meta.resolve('picovoxel/wasm');
  },
});
assert.deepEqual(located, ['pico.wasm'], 'locateFile was not consulted for the serial wasm');
assert.ok(serialLocated.stl.equals(serial.stl), 'locateFile changed the serial result');
const compiled = await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve('picovoxel/multi/wasm'))));
let instantiations = 0;
const multiHosted = await quickStart('picovoxel/multi', {
  mainScriptUrlOrBlob: fileURLToPath(import.meta.resolve('picovoxel/multi/worker')),
  instantiateWasm: (imports, receive) => {
    instantiations += 1;
    WebAssembly.instantiate(compiled, imports).then((instance) => receive(instance, compiled));
    return {};
  },
});
assert.equal(instantiations, 1, 'instantiateWasm was not used for the multi module');
assert.ok(multiHosted.workers > 0, 'the multi pool never engaged from mainScriptUrlOrBlob');
assert.ok(multiHosted.stl.equals(serial.stl), 'the hosted multi entry disagrees with serial');

const { exports, version } = JSON.parse(readFileSync('node_modules/picovoxel/package.json', 'utf8'));
const scripts = Object.keys(exports).filter((subpath) => typeof exports[subpath] !== 'string');
for (const subpath of scripts) {
  const specifier = subpath === '.' ? 'picovoxel' : 'picovoxel/' + subpath.slice(2);
  const module = await import(specifier);
  assert.ok(Object.keys(module).length > 0, specifier + ' exports nothing');
}

// CommonJS: every script entry throws the ESM-only diagnostic; resolution of the
// manifest and the assets still works for tooling.
const require = createRequire(import.meta.url);
for (const subpath of scripts) {
  const specifier = subpath === '.' ? 'picovoxel' : 'picovoxel/' + subpath.slice(2);
  assert.throws(() => require(specifier), /^Error: picovoxel is ESM-only; use import\("picovoxel"\) from CommonJS\.$/u, specifier);
}
assert.equal(require(require.resolve('picovoxel/package.json')).version, version);
for (const specifier of Object.keys(assets)) {
  assert.equal(require.resolve(specifier), fileURLToPath(import.meta.resolve(specifier)), 'require.resolve ' + specifier);
}

console.log('consumer smoke on Node ' + process.version + ': picovoxel@' + version + '; quick start '
  + serial.stl.byteLength + ' STL bytes; ' + multi.workers + ' multi workers; ' + scripts.length
  + ' script subpaths imported; ' + Object.keys(assets).length + ' asset subpaths resolved; overrides honoured; '
  + 'CommonJS diagnostic on every script subpath');
`;

const directory = mkdtempSync(join(tmpdir(), 'picovoxel-consumer-'));
try {
  execFileSync('npm', ['init', '--yes'], { cwd: directory, stdio: 'ignore' });
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(candidate, root.filename),
      ...['three', '@types/three', 'typescript'].map(exact),
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  writeFileSync(join(directory, 'smoke.mjs'), smoke);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit' });
  typecheckConsumers(directory);
  pinCandidateGeometry(directory);
} finally {
  rmSync(directory, { force: true, recursive: true });
}

/**
 * Typechecks three consumer fixtures against the installed package: ESM on
 * `nodenext` and on `bundler` must compile, and CommonJS on `nodenext` must fail
 * with exactly one TS2339 per script subpath.
 */
function typecheckConsumers(directory) {
  const { exports } = JSON.parse(
    readFileSync(join(directory, 'node_modules/picovoxel/package.json'), 'utf8'),
  );
  const specifiers = Object.keys(exports)
    .filter((subpath) => typeof exports[subpath] !== 'string')
    .map((subpath) => (subpath === '.' ? 'picovoxel' : `picovoxel/${subpath.slice(2)}`));
  const tsc = (project) => {
    try {
      execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', project], {
        cwd: directory,
        encoding: 'utf8',
      });
      return { ok: true, output: '' };
    } catch (error) {
      return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };
  const fixture = (name, compilerOptions, file, source) => {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, file), source);
    const options = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: ['es2023', 'dom'],
      target: 'es2022',
      ...compilerOptions,
    };
    writeFileSync(
      join(directory, name, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: options, files: [file] }),
    );
    return tsc(name);
  };
  const esm = specifiers
    .map(
      (specifier, index) =>
        `import * as m${index} from '${specifier}';\nexport const k${index}: string[] = Object.keys(m${index});\n`,
    )
    .join('');
  for (const { name, options, file } of [
    {
      name: 'esm-nodenext',
      options: { module: 'nodenext', moduleResolution: 'nodenext' },
      file: 'index.mts',
    },
    { name: 'esm-bundler', options: { module: 'esnext', moduleResolution: 'bundler' }, file: 'index.ts' },
  ]) {
    const result = fixture(name, options, file, esm);
    if (!result.ok) throw new Error(`the ${name} TypeScript consumer failed to compile:\n${result.output}`);
  }
  const cjs = specifiers
    .map(
      (specifier, index) =>
        `import m${index} = require('${specifier}');\nexport const v${index} = m${index}.createPico;\n`,
    )
    .join('');
  const result = fixture(
    'cjs-nodenext',
    { module: 'nodenext', moduleResolution: 'nodenext' },
    'index.cts',
    cjs,
  );
  const errors = result.output.split('\n').filter((line) => line.includes('error TS'));
  const expected = errors.filter((line) =>
    line.includes("error TS2339: Property 'createPico' does not exist on type 'never'."),
  );
  if (result.ok || errors.length !== specifiers.length || expected.length !== specifiers.length) {
    throw new Error(
      `the CommonJS TypeScript consumer must fail with one TS2339 per script subpath:\n${result.output}`,
    );
  }
  console.log(
    `TypeScript consumers: ESM nodenext and bundler compile against ${specifiers.length} script subpaths; ` +
      `CommonJS nodenext fails with ${expected.length} x TS2339 on never`,
  );
}

/**
 * The candidate G0 pin: HelixHeatX at 2.0 mm on the pthread entry must produce
 * the pinned G0 tuple (grid hash and counts, raw volume, mesh counts, STL
 * multiset). The pin was recorded on the exact lane from the CI-built wasm of
 * main 7040437 (run 36344828928), identical on the serial and pthread builds.
 * A deliberate geometry change regenerates it with
 * `node bench/g0-identity.mjs record --fixture heatx --build multi --size 2.0`,
 * naming the cause, as UPDATE_PINS does for test/g0-gate.test.ts.
 */
function pinCandidateGeometry(directory) {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const heatx = join(directory, 'helixheatx');
  mkdirSync(heatx);
  for (const file of ['run.ts', 'helixHeatX.ts', 'helpers.ts']) {
    cpSync(join(repository, 'examples/helixheatx', file), join(heatx, file));
  }
  // The consumer project is CommonJS (npm init); the example is ESM TypeScript.
  writeFileSync(join(heatx, 'package.json'), '{ "type": "module" }\n');
  cpSync(join(repository, 'bench/stl-multiset.mjs'), join(directory, 'stl-multiset.mjs'));
  cpSync(join(repository, 'test/fixtures/g0-candidate.json'), join(directory, 'g0-candidate.json'));
  writeFileSync(
    join(directory, 'g0-pin.mjs'),
    String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPico } from 'picovoxel/multi';
import { task } from './helixheatx/run.ts';
import { stlIdentity } from './stl-multiset.mjs';

const pin = JSON.parse(readFileSync('g0-candidate.json', 'utf8'))['heatx@2mm'];
const hexFloat = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
};
const started = performance.now();
const pico = await createPico({ voxelSize: 2 });
try {
  const { voxels } = task(pico);
  const grid = voxels.gridHash();
  const mesh = voxels.toMesh();
  const stl = stlIdentity(mesh.toStl());
  assert.equal(stl.nonFiniteRecords, 0, 'a non-finite coordinate is never legitimate output');
  assert.deepEqual(
    {
      gridHash: grid.hash,
      activeVoxels: grid.activeVoxels,
      insideTiles: grid.insideTiles,
      insideOffVoxels: grid.insideOffVoxels,
      volumeHex: hexFloat(voxels.volume),
      triangles: mesh.triangleCount,
      vertices: mesh.vertexCount,
      multiset: stl.multiset,
    },
    pin,
    'the candidate computes a HelixHeatX @ 2.0 mm G0 tuple other than test/fixtures/g0-candidate.json',
  );
  console.log('candidate G0 pin: HelixHeatX @ 2.0 mm on picovoxel/multi matches (' + (pico.module.PThread?.runningWorkers.length ?? 0)
    + ' workers, ' + Math.round(performance.now() - started) + ' ms)');
} finally {
  pico.dispose();
}
`,
  );
  // Node 22.14 strips types only behind the flag; later releases do it by default.
  const flags = process.features.typescript
    ? []
    : ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];
  execFileSync(process.execPath, [...flags, 'g0-pin.mjs'], { cwd: directory, stdio: 'inherit' });
}
