// R21 — the surface-completeness backstop coverage cannot see: exact key-set
// equality between the live facade object graph and the checked-in manifest.
// A public member that appears or disappears fails HERE until the manifest (and
// the API surface spec tables) move together.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import * as picoModule from '../src/index.ts';
import { createPico } from '../src/index.ts';
import manifest from './surface-manifest.json' with { type: 'json' };

test('every wrapper key set matches the checked-in manifest exactly', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  const voxels = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const keys = (value: object) => Object.keys(value).sort();

  const live: Record<string, string[]> = {
    module: keys(picoModule),
    session: keys(pk),
    voxels: keys(voxels),
    mesh: keys(voxels.toMesh()),
    lattice: keys(pk.createLattice()),
    polyLine: keys(pk.createPolyLine()),
    scalarField: keys(pk.createScalarField()),
    vectorField: keys(pk.createVectorField()),
    metadata: keys(voxels.metadata),
    vdbFile: keys(pk.createVdb()),
  };

  assert.deepEqual(Object.keys(live).sort(), Object.keys(manifest).sort(), 'manifest sections');
  for (const [section, expected] of Object.entries(manifest)) {
    assert.deepEqual(
      live[section],
      expected,
      `${section} surface drifted — update test/surface-manifest.json AND the API surface spec tables together`,
    );
  }
  pk.dispose();
});

// SK-0.10 — the same shape of backstop for a defect coverage also cannot see:
// a heap view indexed with the SIGNED shift. Above 2 GiB `pointer >> 2` goes
// negative, `subarray` clamps rather than throws, and the read silently returns
// a window one to two gigabytes away — geometry that still has the right
// triangle count. Reproducing it needs a 2.8 GiB heap, which no unit test can
// afford, so the invariant is pinned at the source instead.
test('no wasm pointer is indexed with a signed shift', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  const offenders = [...walk('src'), ...walk(join('spikes', 'webgpu'))]
    .filter((path) => path !== join('src', 'raw.generated.ts'))
    .flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => ({ where: `${path}:${i + 1}`, line }))
        .filter(({ line }) => /[^>]>>\s*[23]\b/.test(line)),
    );
  assert.deepEqual(offenders, [], 'use `>>> 2` / `>>> 3` — see checkedMalloc in src/context.ts');
});
