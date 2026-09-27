#!/usr/bin/env node
// Clean-room consumer smoke for the frozen candidate (create-repo §6). Installs
// the packed tarball into an empty npm project on the running Node, then, from
// that project only: runs the README quick start through `picovoxel` and
// `picovoxel/multi` (the multi pool must engage and match serial byte for byte),
// imports every exported subpath, and proves `require()` fails because the
// package is ESM-only. Nothing is rebuilt and no repository file is imported.
//
// Usage: node scripts/test-package.mjs <candidate-directory>

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const candidate = resolve(process.argv[2] ?? 'candidate');
const { packages } = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
const root = packages.find(({ name }) => name === 'picovoxel');
if (!root) throw new Error('candidate manifest has no picovoxel package');

// `three` is the optional peer behind picovoxel/three; install the locked version.
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const three = lock.packages['node_modules/three']?.version;
if (!three) throw new Error('package-lock.json does not lock three');

const smoke = String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const quickStart = async (entry) => {
  const { createPico } = await import(entry);
  const pico = await createPico({ voxelSize: 0.5 });
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

const { exports } = JSON.parse(readFileSync('node_modules/picovoxel/package.json', 'utf8'));
for (const subpath of Object.keys(exports)) {
  const specifier = subpath === '.' ? 'picovoxel' : 'picovoxel/' + subpath.slice(2);
  const module = await import(specifier);
  assert.ok(Object.keys(module).length > 0, specifier + ' exports nothing');
}

assert.throws(() => createRequire(import.meta.url)('picovoxel'), 'require(picovoxel) must fail: ESM-only');
console.log('consumer smoke on Node ' + process.version + ': quick start ' + serial.stl.byteLength + ' STL bytes; '
  + multi.workers + ' multi workers; ' + Object.keys(exports).length + ' subpaths');
`;

const directory = mkdtempSync(join(tmpdir(), 'picovoxel-consumer-'));
try {
  execFileSync('npm', ['init', '--yes'], { cwd: directory, stdio: 'ignore' });
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(candidate, root.filename), `three@${three}`],
    { cwd: directory, stdio: 'inherit' },
  );
  writeFileSync(join(directory, 'smoke.mjs'), smoke);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit' });
} finally {
  rmSync(directory, { force: true, recursive: true });
}
