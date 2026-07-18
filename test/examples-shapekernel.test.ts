// R7 (real-world-subjects blueprint) — the ShapeKernel functional-completeness
// gate: all 17 ported examples run headless against the BUILT package, and
// every constructed voxel field is pinned byte-exact (hex-float mesh-roundtrip
// volume + triangle count) in test/fixtures/shapekernel-examples.json.
// Regenerate deliberately with UPDATE_PINS=1; any other change is a regression.
// Voxel sizes follow the geometry scale (implicit examples are mm-scale).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { createPicoGK } from '../src/index.ts';

const examplesDir = join(import.meta.dirname, '..', 'examples', 'shapekernel');
const fixturePath = join(import.meta.dirname, 'fixtures', 'shapekernel-examples.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

interface Pin {
  volumeHex: string;
  triangles: number;
}

const EXAMPLES: Array<{ name: string; voxelSize: number }> = [
  { name: 'ex-base-box', voxelSize: 1 },
  { name: 'ex-base-cylinder', voxelSize: 1 },
  { name: 'ex-base-lens', voxelSize: 1 },
  { name: 'ex-base-pipe', voxelSize: 1 },
  { name: 'ex-base-pipe-segment', voxelSize: 1 },
  { name: 'ex-base-ring', voxelSize: 1 },
  { name: 'ex-base-sphere', voxelSize: 1 },
  { name: 'ex-basic-lattices', voxelSize: 0.5 },
  // voxIntersectImplicit is broken UPSTREAM below 1/3 mm (fBackgroundMM
  // truncates into the fresh grid's int nNarrowBand → band 0 → openvdb csg
  // throws); both our paths replicate it faithfully, so the masked examples
  // run at sizes upstream itself supports.
  { name: 'ex-implicit-gyroid-genus', voxelSize: 0.35 },
  { name: 'ex-implicit-gyroid-sphere', voxelSize: 0.5 },
  // No intersect step — the plain implicit fill has no band constraint.
  { name: 'ex-implicit-super-ellipsoid', voxelSize: 0.02 },
  { name: 'ex-lattice-manifold', voxelSize: 0.5 },
  { name: 'ex-lattice-pipe', voxelSize: 0.5 },
  { name: 'ex-mesh-painter', voxelSize: 1 },
  { name: 'ex-mesh-trafo', voxelSize: 1 },
  { name: 'ex-over-offset', voxelSize: 0.5 },
];

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

const pins: Record<string, Pin[]> = existsSync(fixturePath)
  ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, Pin[]>)
  : {};
const regenerated: Record<string, Pin[]> = {};

test('the example directory carries exactly the 17 ported files', () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith('.ts'));
  assert.equal(files.length, 17, `found ${files.length}: ${files.join(', ')}`);
  assert.ok(files.includes('example-spline.ts'));
});

for (const { name, voxelSize } of EXAMPLES) {
  test(`${name} runs headless and matches its byte-locked pins`, async () => {
    const { task } = (await import(`../examples/shapekernel/${name}.ts`)) as {
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
