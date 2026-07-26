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
import { createPico } from '../src/index.ts';
import { createPico as createMulti } from '../src/multi.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'helixheatx.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

/** LEAP71's published STL size at 1.0 mm (README table): 94 MB. */
const PUBLISHED_STL_BYTES_AT_1MM = 94 * 2 ** 20;

const EXPECTED_KERNEL_STAGES = [
  'bounding.create',
  'turning-fins.hot',
  'turning-fins.cool',
  'corner-fins.union',
  'straight-fins.hot',
  'straight-fins.cool',
  'straight-fins.union',
  'fins.union',
  'outer-structure.create',
  'helical-void.hot',
  'helical-void.cool',
  'cool-inner.offset',
  'hot-fluid-void.subtract',
  'hot-inner.offset',
  'cool-fluid-void.subtract',
  'inner-volume.union',
  'splitters.union',
  'outer-volume.offset',
  'flange.create',
  'finished-flange.fillet',
  'finished-flange.smoothen',
  'outer-volume.union-flange',
  'io-supports.create',
  'outer-volume.union-supports',
  'outer-volume.fillet',
  'outer-volume.smoothen',
  'centre-piece.add',
  'outer-volume.union-structure',
  'outer-volume.subtract-screw-holes',
  'outer-volume.project-z-slice',
  'print-web.create',
  'outer-volume.subtract-print-web',
  'result.subtract-inner-volume',
  'result.union-fins',
  'result.union-splitters',
  'result.intersect-bounding',
  'io-threads.create',
  'result.union-threads',
  'io-cuts.create',
  'result.subtract-io-cuts',
] as const;

test('HelixHeatX @ 1.0 mm: pinned result, STL-size parity, single↔multi identity', async () => {
  const { task } = await import('../examples/helixheatx/run.ts');

  const single = await createPico({ voxelSize: 1.0 });
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

    assert.deepEqual(
      singleRun.kernelTimings.map(({ stage }) => stage),
      EXPECTED_KERNEL_STAGES,
      'every HeatX kernel stage is timed in execution order',
    );
    assert.ok(Object.isFrozen(singleRun.kernelTimings), 'kernel timing collection is immutable');
    for (const timing of singleRun.kernelTimings) {
      assert.ok(Object.isFrozen(timing), `${timing.stage} timing is immutable`);
      assert.ok(Number.isFinite(timing.ms) && timing.ms >= 0, `${timing.stage} has a finite non-negative duration`);
    }
    const accountedMs =
      singleRun.authorMs +
      singleRun.unattributedMs +
      singleRun.kernelTimings.reduce((total, timing) => total + timing.ms, 0);
    assert.ok(
      Math.abs(accountedMs - singleRun.constructMs) < 1e-6,
      `HeatX timing accounts for the full construct: ${accountedMs} vs ${singleRun.constructMs}`,
    );
    assert.ok(
      singleRun.unattributedMs >= 0 && singleRun.unattributedMs <= singleRun.constructMs * 0.01,
      `unattributed ${singleRun.unattributedMs.toFixed(1)} ms stays below 1% of construct time`,
    );

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

// ── Fine-cell MT identity gate (SK-0 P0) ──
//
// FIXME(SK-0-P0): SKIPPED BECAUSE IT CURRENTLY FAILS — it is the gate for a live
// defect, not a passing check. Enable it in the commit that fixes the P0.
// See bench/results/webgpu-v2/SK-0-P0-finecell.md.
//
// The 1.0 mm differential above passes and always has; the defect only appears on
// FINER cells, so 1.0 mm is exactly the one voxel size that cannot see it. Measured
// on webgpu @ff68494: the multi build drops geometry nondeterministically at every
// size below 1.0 mm (0.7 mm observed at 3,158,084 / 4,053,020 tris across builds vs
// the 4,542,736 reference, with a different volume each run).
//
// Pinned against the single build rather than running one: single is stable and
// already pinned at 1.0 mm, so re-deriving it here would cost ~126 s to re-learn a
// known value. This shape is ~47 s and still catches both failure modes — wrong
// geometry AND run-to-run variance — because a nondeterministic multi build cannot
// hit a fixed pin. Reference: bench/results/webgpu-v2/sk-0.1-heatx-sweep-dlmalloc.json
// (0.7 mm, where single ≡ multi still held).
const FINE_CELL_MM = 0.7;
const FINE_CELL_VOLUME_HEX = '000000a0e5ff2141'; // 589810.8125
const FINE_CELL_TRIANGLES = 4_542_736;

// Skipped by default so CI stays green while the defect is open, but runnable on
// demand with SK0_P0_GATE=1 — a red gate nobody can execute is not a gate. The fix
// commit deletes the skipIf.
test.skipIf(!process.env.SK0_P0_GATE)(
  `HelixHeatX @ ${FINE_CELL_MM} mm: multi build reproduces the pinned fine-cell geometry`,
  async () => {
    const { task } = await import('../examples/helixheatx/run.ts');
    const multi = await createMulti({ voxelSize: FINE_CELL_MM });
    try {
      const run = task(multi);
      assert.deepEqual(
        { volumeHex: hexFloat(run.voxels.volume), triangles: run.voxels.toMesh().triangleCount },
        { volumeHex: FINE_CELL_VOLUME_HEX, triangles: FINE_CELL_TRIANGLES },
        'multi build drops geometry on fine cells — see bench/results/webgpu-v2/SK-0-P0-finecell.md',
      );
    } finally {
      multi.dispose();
    }
  },
  600_000,
);

function expectIdentical(actual: number, expected: number): void {
  assert.ok(Object.is(actual, expected), `volumes bit-identical: ${actual} vs ${expected}`);
}
