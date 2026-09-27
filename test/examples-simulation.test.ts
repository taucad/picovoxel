// R14 (real-world-subjects blueprint) — the PicoGK_SimulationExample subject:
// the SimpleFlowDevice geometry pinned byte-exact, the 5-field VDB write→read
// round-trip validated exactly as the C# reader does (1 VectorField + 2
// ScalarFields + 2 Voxels or throw), typed read-back introspection, and field
// values verified on the C# 2 mm probe grid. Container field order is NOT
// stable (vdb.ts header), so introspection compares sorted.
// Regenerate pins deliberately with UPDATE_PINS=1.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { assertPinSource } from '../bench/pin-guard.mjs';
import { createPico } from '../src/index.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'simulation.json');
const updatePins = process.env.UPDATE_PINS === '1';

assert.ok(
  existsSync(join(import.meta.dirname, '..', 'dist', 'index.js')),
  'examples consume built artifacts — run `npm run build` first.',
);

const hexFloat = (value: number): string => Buffer.from(Float64Array.of(value).buffer).toString('hex');

const FLUID_DENSITY = 1000; // kg/m3, as written by writeTask
const FLUID_VISCOSITY = Math.fround(0.00000897); // m2/s — fields store float32
const INLET_VELOCITY_Z = Math.fround(-1.5); // m/s, -Z flow

test('SimpleFluidSimulation @ 1.0 mm: pinned device, 5-field round-trip, probe-grid values', async () => {
  const { writeTask, readTask } = await import('../examples/simulation/run.ts');
  const pk = await createPico({ voxelSize: 1 });
  try {
    const written = writeTask(pk);

    // The flow-device voxels, pinned byte-exact (hex-float volume + triangles).
    const pin = (voxels: (typeof written)['fluidDomain']) => {
      assert.equal(voxels.isEmpty, false, 'every device domain voxelizes non-empty');
      assertPinSource(voxels.lane, 'flow device'); // LANES item 3 — only exact sources pin
      return { volumeHex: hexFloat(voxels.properties().volume), triangles: voxels.toMesh().triangleCount };
    };
    const recorded = {
      fluid: pin(written.fluidDomain),
      solid: pin(written.solidDomain),
      inlet: pin(written.inletPatch),
    };
    if (updatePins) {
      writeFileSync(fixturePath, `${JSON.stringify(recorded, null, 1)}\n`);
    } else {
      const pinned = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof recorded;
      assert.deepEqual(
        recorded,
        pinned,
        'the flow device drifted from its pins — regenerate deliberately with UPDATE_PINS=1 if intended',
      );
    }

    // Write→read round-trip: the C# reader validates and types every field.
    const { input, probe } = readTask(pk, written.bytes);

    // Typed read-back introspection matches what was written (sorted — order is not stable).
    assert.deepEqual(
      [...input.fields].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'Simulation.Domain_fluid', type: 'voxels' },
        { name: 'Simulation.Domain_solid', type: 'voxels' },
        { name: 'Simulation.Field_density', type: 'scalarField' },
        { name: 'Simulation.Field_velocity', type: 'vectorField' },
        { name: 'Simulation.Field_viscosity', type: 'scalarField' },
      ],
      'the 5 fields come back with the C# metadata naming and types',
    );

    // Domains survive the round-trip bit-identically.
    assert.ok(Object.is(input.fluidDomain.properties().volume, written.fluidDomain.properties().volume));
    assert.ok(Object.is(input.solidDomain.properties().volume, written.solidDomain.properties().volume));

    // Velocity structure: zero default over the fluid domain, the extracted
    // inlet merged in. Inlet normals are float32, so a few carry tiny lateral
    // components (dot rounds to exactly 1) — faithful to the C# float math.
    let zeroCount = 0;
    let inletCount = 0;
    input.velocityField.traverse((_x, _y, _z, vx, vy, vz) => {
      if (vx === 0 && vy === 0 && vz === 0) {
        zeroCount += 1;
      } else {
        assert.equal(vz, INLET_VELOCITY_Z, `inlet velocity z is exactly -1.5, got ${vz}`);
        assert.ok(
          Math.abs(vx) < 2e-3 && Math.abs(vy) < 2e-3,
          `lateral inlet components stay tiny: ${vx}, ${vy}`,
        );
        inletCount += 1;
      }
    });
    assert.ok(inletCount > 0, 'the inlet extractor produced actives');
    assert.ok(zeroCount > inletCount, `the bulk stays at the zero default: ${zeroCount} vs ${inletCount}`);

    // The C# 2 mm probe grid: all three fields share the velocity structure,
    // so hit counts agree; values are the written constants.
    assert.ok(probe.samples > 10_000, `the grid covers the device: ${probe.samples} samples`);
    assert.ok(probe.density.length > 0, 'the probe grid lands on active voxels');
    assert.equal(probe.viscosity.length, probe.density.length, 'shared structure ⇒ identical hit patterns');
    assert.equal(probe.velocity.length, probe.density.length, 'shared structure ⇒ identical hit patterns');
    for (const density of probe.density) assert.equal(density, FLUID_DENSITY);
    for (const viscosity of probe.viscosity) assert.equal(viscosity, FLUID_VISCOSITY);
    let probedInletHits = 0;
    for (const [vx, vy, vz] of probe.velocity) {
      if (vx === 0 && vy === 0 && vz === 0) continue;
      assert.equal(vz, INLET_VELOCITY_Z, `probed inlet velocity z is exactly -1.5, got ${vz}`);
      probedInletHits += 1;
    }
    assert.ok(probedInletHits > 0, 'the probe grid reaches the inlet cap');

    // The reader throws on unsuitable containers, exactly as the C# does.
    const wrongCount = pk.createVdb();
    wrongCount.add(written.fluidDomain, 'just_one');
    assert.throws(() => readTask(pk, wrongCount.toBytes()), /Five fields are expected/);

    const wrongMix = pk.createVdb();
    for (let i = 0; i < 5; i += 1) wrongMix.add(written.inletPatch, `voxels_${i}`);
    assert.throws(() => readTask(pk, wrongMix.toBytes()), /One vector field is expected/);

    const wrongNames = pk.createVdb();
    wrongNames.add(written.inletPatch, 'a');
    wrongNames.add(written.inletPatch, 'b');
    const strayVector = pk.createVectorField();
    strayVector.set([0, 0, 0], [1, 0, 0]);
    wrongNames.add(strayVector, 'v');
    const strayScalar = pk.createScalarField();
    strayScalar.set([0, 0, 0], 1);
    wrongNames.add(strayScalar, 's1');
    wrongNames.add(strayScalar, 's2');
    assert.throws(() => readTask(pk, wrongNames.toBytes()), /Missing fluid density field/);
  } finally {
    pk.dispose();
  }
}, 600_000);
