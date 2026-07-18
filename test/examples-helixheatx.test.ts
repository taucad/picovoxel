// R11 (real-world-subjects blueprint) — the HelixHeatX flagship subject:
// full-app construction at 1.0 mm, pinned byte-exact, STL size checked against
// LEAP71's published table (94 MB @ 1.0 mm — the cross-implementation parity
// signal, ±10%), and a single↔multi whole-app differential: an identical part
// regardless of thread count, through ~10^5 beams, the boolean assembly and
// the entire finishing family.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { createPicoGK } from '../src/index.ts';
import { createPicoGK as createMulti } from '../src/multi.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'helixheatx.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

/** LEAP71's published STL size at 1.0 mm (README table): 94 MB. */
const PUBLISHED_STL_BYTES_AT_1MM = 94 * 2 ** 20;

test('HelixHeatX @ 1.0 mm: pinned result, STL-size parity, single↔multi identity', async () => {
  const { task } = await import('../examples/helixheatx/run.ts');

  const single = await createPicoGK({ voxelSize: 1.0 });
  const multi = await createMulti({ voxelSize: 1.0 });
  try {
    const singleRun = task(single);
    const singleMesh = singleRun.voxels.toMesh();
    const singleStl = singleMesh.toStl();

    // Cross-implementation parity signal (blueprint D5): same geometry ⇒
    // binary STL sizes land within a few percent of the published table.
    const ratio = singleStl.length / PUBLISHED_STL_BYTES_AT_1MM;
    assert.ok(
      ratio > 0.9 && ratio < 1.1,
      `STL ${(singleStl.length / 2 ** 20).toFixed(1)} MB within ±10% of the published 94 MB (ratio ${ratio.toFixed(3)})`,
    );

    // Authoring stays a sliver of wall time (Finding 8's premise, sanity-level).
    assert.ok(singleRun.authorMs < 10_000, `authoring ${singleRun.authorMs.toFixed(0)} ms is JS-cheap`);

    const recorded = {
      volumeHex: hexFloat(singleRun.voxels.volume),
      triangles: singleMesh.triangleCount,
      stlBytes: singleStl.length,
    };
    if (updatePins) {
      writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 1)}\n`);
    } else {
      const pinned = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof recorded;
      assert.deepEqual(
        recorded,
        pinned,
        'HelixHeatX drifted from its pins — regenerate deliberately with UPDATE_PINS=1 if intended',
      );
    }

    // Whole-app thread-count differential: the multi build must produce the
    // IDENTICAL part (same wasm code, TBB-parallel; every op in the chain is
    // schedule-independent).
    const multiRun = task(multi);
    expectIdentical(multiRun.voxels.volume, singleRun.voxels.volume);
    const multiStl = multiRun.voxels.toMesh().toStl();
    assert.ok(Buffer.from(multiStl).equals(Buffer.from(singleStl)), 'multi STL bytes identical to single');
  } finally {
    single.dispose();
    multi.dispose();
  }
}, 600_000);

function expectIdentical(actual: number, expected: number): void {
  assert.ok(Object.is(actual, expected), `volumes bit-identical: ${actual} vs ${expected}`);
}
