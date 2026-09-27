// R10 (real-world-subjects blueprint) — the RoverWheel-TS regression gate:
// the Wheel_02 preset (the upstream showcase default) runs headless against
// the BUILT package and is pinned byte-exact (hex-float mesh-roundtrip volume
// + triangle count) in test/fixtures/roverwheel.json; a 20-seed corpus proves
// the randomized generator voxelizes non-empty across its parameter space;
// and the single↔multi differential proves the whole construction pipeline is
// thread-count independent. Regenerate pins deliberately with UPDATE_PINS=1.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { assertPinSource } from '../bench/pin-guard.mjs';
import { createPico } from '../src/index.ts';
import { createPico as createPicoMulti } from '../src/multi.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'roverwheel.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

interface Pin {
  volumeHex: string;
  triangles: number;
}

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

const pins: Record<string, Pin> = existsSync(fixturePath)
  ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, Pin>)
  : {};
const regenerated: Record<string, Pin> = {};

const loadTasks = async () =>
  (await import('../examples/roverwheel/run.ts')) as {
    presetWheelTask: (pk: Awaited<ReturnType<typeof createPico>>) => {
      properties(): { volume: number };
      toMesh(): { triangleCount: number; toStl(): Uint8Array };
      isEmpty: boolean;
      lane: 'exact' | 'fast';
    };
    randomWheelTask: (pk: Awaited<ReturnType<typeof createPico>>, seed: number) => { isEmpty: boolean };
  };

test('wheel-02 preset builds headless and matches its byte-locked pins', { timeout: 600_000 }, async () => {
  const { presetWheelTask } = await loadTasks();
  const pk = await createPico({ voxelSize: 1 });
  try {
    const voxels = presetWheelTask(pk);
    assert.equal(voxels.isEmpty, false);
    assertPinSource(voxels.lane, 'wheel-02'); // LANES item 3 — only exact sources pin
    const recorded: Pin = {
      volumeHex: hexFloat(voxels.properties().volume),
      triangles: voxels.toMesh().triangleCount,
    };
    if (updatePins) {
      regenerated['wheel-02'] = recorded;
      writeFixture();
    } else {
      assert.deepEqual(
        recorded,
        pins['wheel-02'],
        'wheel-02 drifted from its pins — regenerate deliberately with UPDATE_PINS=1 if the change is intended',
      );
    }
  } finally {
    pk.dispose();
  }
});

// Seeded corpus: the randomized generator must produce solid geometry across
// its whole parameter space (all 5 element types, all 3 tread patterns,
// profile and solid-layer treads). Coarse voxels keep the runtime sane; the
// mulberry32 streams make every seed reproducible.
for (let seed = 1; seed <= 20; seed += 1) {
  test(`random wheel seed ${seed} voxelizes non-empty`, { timeout: 600_000 }, async () => {
    const { randomWheelTask } = await loadTasks();
    const pk = await createPico({ voxelSize: 2 });
    try {
      assert.equal(randomWheelTask(pk, seed).isEmpty, false);
    } finally {
      pk.dispose();
    }
  });
}

test(
  'wheel-02 is identical across the single- and multi-threaded engines',
  { timeout: 600_000 },
  async () => {
    const { presetWheelTask } = await loadTasks();
    const serial = await createPico({ voxelSize: 2 });
    const multi = await createPicoMulti({ voxelSize: 2 });
    try {
      const serialWheel = presetWheelTask(serial);
      const multiWheel = presetWheelTask(multi);
      assert.ok(Object.is(serialWheel.properties().volume, multiWheel.properties().volume));
      assert.ok(Buffer.from(serialWheel.toMesh().toStl()).equals(Buffer.from(multiWheel.toMesh().toStl())));
    } finally {
      serial.dispose();
      multi.dispose();
    }
  },
);

function writeFixture(): void {
  const merged = { ...pins, ...regenerated };
  const ordered = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((k) => [k, merged[k]!]),
  );
  writeFileSync(fixturePath, `${JSON.stringify(ordered, null, 1)}\n`);
}
