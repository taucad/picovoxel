// R13 (real-world-subjects blueprint) — the LatticeLibrary functional-
// completeness gate: all 7 ported example tasks run headless against the
// BUILT package, and every constructed voxel field is pinned byte-exact
// (hex-float mesh-roundtrip volume + triangle count) in
// test/fixtures/latticelibrary-examples.json. Regenerate deliberately with
// UPDATE_PINS=1; any other change is a regression. The masked-implicit
// examples run at ≥ 0.34 mm — voxIntersectImplicit is broken UPSTREAM below
// 1/3 mm (see test/examples-shapekernel.test.ts).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { createPicoGK } from '../src/index.ts';

const examplesDir = join(import.meta.dirname, '..', 'examples', 'latticelibrary');
const fixturePath = join(import.meta.dirname, 'fixtures', 'latticelibrary-examples.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'latticelibrary.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

interface Pin {
  volumeHex: string;
  triangles: number;
}

const EXAMPLES: Array<{ name: string; voxelSize: number }> = [
  { name: 'ex-implicit-logic-split', voxelSize: 0.5 },
  { name: 'ex-implicit-modular', voxelSize: 0.5 },
  { name: 'ex-implicit-radial', voxelSize: 0.5 },
  { name: 'ex-implicit-random', voxelSize: 0.5 },
  { name: 'ex-implicit-regular', voxelSize: 0.5 },
  { name: 'ex-lattice-conformal', voxelSize: 1 },
  { name: 'ex-lattice-regular', voxelSize: 1 },
];

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

const pins: Record<string, Pin[]> = existsSync(fixturePath)
  ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, Pin[]>)
  : {};
const regenerated: Record<string, Pin[]> = {};

test('the example directory carries exactly the 7 ported files', () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith('.ts'));
  assert.equal(files.length, 7, `found ${files.length}: ${files.join(', ')}`);
});

for (const { name, voxelSize } of EXAMPLES) {
  test(`${name} runs headless and matches its byte-locked pins`, async () => {
    const { task } = (await import(`../examples/latticelibrary/${name}.ts`)) as {
      task: (pk: Awaited<ReturnType<typeof createPicoGK>>) => Array<{
        properties(): { volume: number };
        toMesh(): { triangleCount: number };
        isEmpty: boolean;
      }>;
    };
    const pk = await createPicoGK({ voxelSize });
    try {
      const outputs = task(pk);
      assert.ok(outputs.length > 0);
      const recorded: Pin[] = outputs.map((voxels) => {
        assert.equal(voxels.isEmpty, false, 'every example output voxelizes non-empty');
        return { volumeHex: hexFloat(voxels.properties().volume), triangles: voxels.toMesh().triangleCount };
      });
      if (updatePins) {
        regenerated[name] = recorded;
        writeFixture();
      } else {
        assert.deepEqual(
          recorded,
          pins[name],
          `${name} drifted from its pins — regenerate deliberately with UPDATE_PINS=1 if the change is intended`,
        );
      }
    } finally {
      pk.dispose();
    }
  });
}

function writeFixture(): void {
  const merged = { ...pins, ...regenerated };
  const ordered = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]!]));
  writeFileSync(fixturePath, `${JSON.stringify(ordered, null, 1)}\n`);
}
