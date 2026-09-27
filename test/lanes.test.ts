// SKv2-0 V0.5 — the §14.1 lane surface: named bundles, tighten-only
// precedence, per-handle provenance with LUB over ancestry, the refusing L0
// export boundary with `acceptLane`, provenance in artifact metadata, and the
// keyed `serialLattice` init option that replaced the env read (V0.6).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico, type Voxels } from '../src/index.ts';

let open: Pico; // lane omitted — the no-claim legacy behavior
beforeAll(async () => {
  open = await createPico({ voxelSize: 0.4 });
});
afterAll(() => open.dispose());

const body = (p: Pico): Voxels =>
  p
    .createVoxels({ shape: 'sphere', radius: 8 })
    .union(p.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 }));

// ── Resolution ──

test('session.lane reports the RESOLVED lane; auto never leaks', async () => {
  assert.equal(open.lane, 'open');
  for (const [request, resolved] of [
    ['exact', 'exact'],
    ['fast', 'fast'],
    ['auto', 'fast'], // the strongest lane available today; adapter-gated L1 later
  ] as const) {
    const pk = await createPico({ voxelSize: 0.4, lane: request });
    assert.equal(pk.lane, resolved, `lane: '${request}'`);
    pk.dispose();
  }
});

test("constructing { lane: 'exact', fastRenorm: true } is a contradiction and throws", async () => {
  await assert.rejects(
    () => createPico({ voxelSize: 0.4, lane: 'exact', fastRenorm: true }),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_LANE_LOOSENED',
  );
});

// ── Tighten-only precedence ──

test("per-op loosening inside 'exact' throws; tightening and absence run byte-locked", async () => {
  const exact = await createPico({ voxelSize: 0.4, lane: 'exact' });
  try {
    const base = body(exact);
    const cases: [string, (o: { fastRenorm?: boolean }) => Voxels][] = [
      ['offset', (o) => base.offset({ distance: 2, ...o })],
      ['doubleOffset', (o) => base.doubleOffset({ first: 2, second: -2, ...o })],
      ['smoothen', (o) => base.smoothen({ distance: 1, ...o })],
      ['fillet', (o) => base.fillet({ rounding: 2, ...o })],
      ['shell', (o) => base.shell({ inner: -1, outer: 1, ...o })],
    ];
    const reference = body(open);
    for (const [label, run] of cases) {
      assert.throws(
        () => run({ fastRenorm: true }),
        (error: unknown) => error instanceof PicoError && error.code === 'PICO_LANE_LOOSENED',
        `${label}: loosening must throw inside 'exact'`,
      );
      // Absence and explicit false are both the byte-locked path.
      const absent = run({});
      const tightened = run({ fastRenorm: false });
      assert.equal(absent.gridHash().hash, tightened.gridHash().hash, `${label}: absent ≠ explicit false`);
      absent.dispose();
      tightened.dispose();
    }
    reference.dispose();
    base.dispose();
  } finally {
    exact.dispose();
  }
});

test("the 'fast' bundle defaults fastRenorm on; per-op and session tightening restore the L0 path", async () => {
  const fast = await createPico({ voxelSize: 0.4, lane: 'fast' });
  const fastTightened = await createPico({ voxelSize: 0.4, lane: 'fast', fastRenorm: false });
  try {
    const openBase = body(open);
    const viaOptIn = openBase.offset({ distance: 2, fastRenorm: true }); // the V0.4 shape
    const viaL0 = openBase.offset({ distance: 2 });

    // Bundle default = the opt-in, exactly.
    const fastBase = body(fast);
    const viaBundle = fastBase.offset({ distance: 2 });
    assert.equal(viaBundle.gridHash().hash, viaOptIn.gridHash().hash, 'bundle default ≠ per-op opt-in');

    // Tightening, both grains, restores the byte-locked path exactly.
    const viaPerOp = fastBase.offset({ distance: 2, fastRenorm: false });
    assert.equal(viaPerOp.gridHash().hash, viaL0.gridHash().hash, 'per-op tighten inside fast ≠ L0 path');
    const tightBase = body(fastTightened);
    const viaSession = tightBase.offset({ distance: 2 });
    assert.equal(viaSession.gridHash().hash, viaL0.gridHash().hash, 'session tighten inside fast ≠ L0 path');
    assert.equal(fastTightened.lane, 'fast', 'tightening does not rename the lane');
  } finally {
    fast.dispose();
    fastTightened.dispose();
  }
});

// ── Provenance ──

test('provenance: exact by construction, tainted by Class-2 ops, LUB over ancestry', () => {
  const base = body(open);
  assert.equal(base.lane, 'exact');

  const fastOffset = base.offset({ distance: 2, fastRenorm: true });
  assert.equal(fastOffset.lane, 'fast', 'the Class-2 producer must taint');
  assert.equal(base.offset({ distance: 2 }).lane, 'exact', 'the byte-locked path must not');

  // LUB through derives: clones, further byte-locked ops, and booleans in
  // either operand position all preserve the taint.
  assert.equal(fastOffset.clone().lane, 'fast');
  assert.equal(fastOffset.offset({ distance: -1 }).lane, 'fast');
  assert.equal(base.union(fastOffset).lane, 'fast', 'fast operand must taint an exact receiver');
  assert.equal(fastOffset.subtract(base).lane, 'fast');
  assert.equal(base.intersect(base.clone()).lane, 'exact', 'exact ⊓ exact stays exact');

  // Across type boundaries: meshes and fields inherit, and mesh derives LUB.
  const fastMesh = fastOffset.toMesh();
  assert.equal(fastMesh.lane, 'fast');
  assert.equal(fastMesh.transform({ scale: 2 }).lane, 'fast');
  const exactMesh = base.toMesh();
  assert.equal(exactMesh.lane, 'exact');
  assert.equal(exactMesh.merged(fastMesh).lane, 'fast');
  assert.equal(fastMesh.toVoxels().lane, 'fast');
  assert.equal(base.withMesh(fastMesh).lane, 'fast');
  assert.equal(fastOffset.toScalarField().lane, 'fast');
  assert.equal(open.createScalarField({ from: fastOffset }).lane, 'fast');
  assert.equal(open.createVectorField({ from: fastOffset, value: [1, 0, 0] }).lane, 'fast');
  assert.equal(open.createScalarField({ from: base }).lane, 'exact');
});

// ── The refusing L0 export boundary ──

test('fast provenance refuses STL/GLB export unless acknowledged; the artifact records the lane', () => {
  const base = body(open);
  const fastMesh = base.offset({ distance: 2, fastRenorm: true }).toMesh();
  const exactMesh = base.toMesh();

  for (const [label, run] of [
    ['toStl', () => fastMesh.toStl()],
    ['toGlb', () => fastMesh.toGlb()],
  ] as const) {
    assert.throws(
      run,
      (error: unknown) => error instanceof PicoError && error.code === 'PICO_LANE_EXPORT',
      `${label}: unacknowledged fast export must refuse`,
    );
  }

  // Acknowledged: the STL header records the lane, and reading it back
  // restores provenance. The exact header is untouched (byte-pin safety).
  const fastBytes = fastMesh.toStl({ acceptLane: 'fast' });
  const header = new TextDecoder().decode(fastBytes.slice(0, 80));
  assert.ok(header.includes('LANE=fast'), 'acknowledged export must stamp the header');
  assert.equal(open.meshFromStl(fastBytes).lane, 'fast', 'the stamp must round-trip');
  const exactHeader = new TextDecoder().decode(exactMesh.toStl().slice(0, 80));
  assert.ok(!exactHeader.includes('LANE'), 'exact exports must keep the historical header');
  assert.equal(open.meshFromStl(exactMesh.toStl()).lane, 'exact');
  assert.ok(fastMesh.toGlb({ acceptLane: 'fast' }).length > 0, 'acknowledged GLB export must serialize');
});

test('vdb: fast fields refuse toBytes unless acknowledged; provenance rides the bytes', () => {
  const base = body(open);
  const fast = base.offset({ distance: 2, fastRenorm: true });

  const container = open.createVdb();
  container.add(fast, 'accelerated');
  assert.throws(
    () => container.toBytes(),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_LANE_EXPORT',
  );
  const bytes = container.toBytes({ acceptLane: 'fast' });

  // Round-trip: the PicoVoxel.Lane metadata rides the field, so both loaders
  // restore 'fast' provenance from the bytes alone.
  const reopened = open.openVdb(bytes);
  assert.equal(reopened.getVoxels('accelerated').lane, 'fast');
  assert.equal(open.voxelsFromVdb(bytes).lane, 'fast');

  // Field types restore from their tags too (scalar/vector wrap arms).
  const fieldContainer = open.createVdb();
  fieldContainer.add(open.createScalarField({ from: fast }), 'sdf');
  fieldContainer.add(open.createVectorField({ from: fast, value: [1, 0, 0] }), 'flow');
  const fieldBytes = fieldContainer.toBytes({ acceptLane: 'fast' });
  const fields = open.openVdb(fieldBytes);
  assert.equal(fields.getScalarField('sdf').lane, 'fast');
  assert.equal(fields.getVectorField('flow').lane, 'fast');

  // The exact path is untouched: no tag, no refusal, provenance stays exact.
  const exactContainer = open.createVdb();
  exactContainer.add(base, 'plain');
  const exactBytes = exactContainer.toBytes();
  assert.equal(open.voxelsFromVdb(exactBytes).lane, 'exact');
});

test('provenance is forgery-resistant at the public metadata surface', () => {
  const base = body(open);
  assert.throws(
    () => base.metadata.set('PicoVoxel.Lane', 'fast'),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_RESERVED_METADATA',
  );
  assert.throws(() => base.metadata.remove('PicoVoxel.Lane'));
});

// ── V0.6 — the keyed serial-lattice arm ──

test('serialLattice is a keyed init option: deterministic per arm, byte-different across arms', async () => {
  const serial = await createPico({ voxelSize: 0.4, serialLattice: true });
  const serial2 = await createPico({ voxelSize: 0.4, serialLattice: true });
  try {
    const render = (p: Pico) => {
      const lattice = p.createLattice();
      lattice.addBeam({ start: [0, 0, 0], end: [10, 0, 0], radius: 2 });
      lattice.addBeam({ start: [10, 0, 0], end: [10, 10, 0], radius: 1.5 });
      return lattice.toVoxels();
    };
    const tubeArm = render(open).gridHash();
    const serialArm = render(serial).gridHash();
    assert.notEqual(serialArm.hash, tubeArm.hash, 'the two arms are distinct geometry classes — that is WHY the flag must be keyed');
    assert.equal(render(serial2).gridHash().hash, serialArm.hash, 'the serial arm is deterministic');
    assert.equal(render(open).gridHash().hash, tubeArm.hash, 'the tube arm is deterministic');
    // The withLattice path follows the same per-session arm.
    const via = (p: Pico) => {
      const lattice = p.createLattice();
      lattice.addBeam({ start: [0, 0, 0], end: [10, 0, 0], radius: 2 });
      lattice.addBeam({ start: [10, 0, 0], end: [10, 10, 0], radius: 1.5 });
      return p.createVoxels({ shape: 'sphere', center: [20, 0, 0], radius: 1 }).withLattice(lattice);
    };
    assert.notEqual(via(serial).gridHash().hash, via(open).gridHash().hash);
  } finally {
    serial.dispose();
    serial2.dispose();
  }
});
