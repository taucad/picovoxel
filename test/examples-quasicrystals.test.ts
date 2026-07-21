// R15 (real-world-subjects blueprint) — the QuasiCrystals-TS scaling subject:
// gen-0/1/2 wireframes from a QuasiTile_02 seed complete non-empty against the
// BUILT package and are pinned byte-exact (hex-float volume + triangles +
// tile/beam counts) in test/fixtures/quasicrystals.json, tile/beam counts grow
// across generations (the aperiodic-inflation scaling property), and the two
// other headless showcase tasks (face seed / QuasiTile_04 seed) are pinned.
// Regenerate deliberately with UPDATE_PINS=1.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { createPico } from '../src/index.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'quasicrystals.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

test('QuasiCrystal wireframes @ 2.0 mm: gens 0-2 pinned and scaling; face/tile tasks pinned', async () => {
  const { wireframeFromCrystalTask, crystalFromFaceTask, crystalFromTileTask } = await import(
    '../examples/quasicrystals/run.ts'
  );
  const pk = await createPico({ voxelSize: 2 });
  try {
    const generations = [0, 1, 2].map((generation) => {
      const { voxels, tileCount, beamCount } = wireframeFromCrystalTask(pk, generation);
      assert.equal(voxels.isEmpty, false, `gen ${generation} wireframe voxelizes non-empty`);
      return {
        tileCount,
        beamCount,
        volumeHex: hexFloat(voxels.properties().volume),
        triangles: voxels.toMesh().triangleCount,
      };
    });

    // The scaling property: every inflation multiplies tiles and beams.
    for (let generation = 1; generation < generations.length; generation += 1) {
      const previous = generations[generation - 1]!;
      const current = generations[generation]!;
      assert.ok(
        current.tileCount > previous.tileCount,
        `tiles grow: gen ${generation} has ${current.tileCount} > ${previous.tileCount}`,
      );
      assert.ok(
        current.beamCount > previous.beamCount,
        `beams grow: gen ${generation} has ${current.beamCount} > ${previous.beamCount}`,
      );
    }

    const pinVoxels = (voxels: ReturnType<typeof crystalFromFaceTask>) => {
      assert.equal(voxels.isEmpty, false, 'every showcase task voxelizes non-empty');
      return { volumeHex: hexFloat(voxels.properties().volume), triangles: voxels.toMesh().triangleCount };
    };
    const recorded = {
      generations,
      crystalFromFace: pinVoxels(crystalFromFaceTask(pk)),
      crystalFromTile: pinVoxels(crystalFromTileTask(pk)),
    };

    if (updatePins) {
      writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 1)}\n`);
    } else {
      const pinned = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof recorded;
      assert.deepEqual(
        recorded,
        pinned,
        'the quasicrystal wireframes drifted from their pins — regenerate deliberately with UPDATE_PINS=1 if intended',
      );
    }
  } finally {
    pk.dispose();
  }
}, 600_000);
