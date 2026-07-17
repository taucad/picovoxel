// R21 — the surface-completeness backstop coverage cannot see: exact key-set
// equality between the live facade object graph and the checked-in manifest.
// A public member that appears or disappears fails HERE until the manifest (and
// the API surface spec tables) move together.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as picogkModule from '../src/index.ts';
import { createPicoGK } from '../src/index.ts';
import manifest from './surface-manifest.json' with { type: 'json' };

test('every wrapper key set matches the checked-in manifest exactly', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const voxels = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const keys = (value: object) => Object.keys(value).sort();

  const live: Record<string, string[]> = {
    module: keys(picogkModule),
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
