// SKv2-0 V0.5 — the §14.1 lane surface: named bundles, tighten-only
// precedence, per-handle provenance with LUB over ancestry, the export
// boundary with `acceptLane`, provenance in artifact metadata, and the keyed
// `serialLattice` init option that replaced the env read (V0.6).
//
// LANES D-pre.1 (ratified 2026-09-27) adds, below the V0.5 block: the
// session-claim export matrix (item 1), the CLI/SVG stamps (item 2), the
// pin-writer guard and its static backstop (item 3), the persisted-set
// grammar (item 4) and the five defects (item 5).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { assertPinSource, unguardedPinArms } from '../bench/pin-guard.mjs';
import { createPico, PicoError, type Mesh, type Pico, type Voxels } from '../src/index.ts';
import { bindPicoRaw } from '../src/raw.ts';
import { sliceToSvg, sliceVoxels, slicesFromCli, slicesToCli, type Slice, type SliceStack } from '../src/slicing.ts';
import { meshToStlBytes } from '../src/stl.ts';

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

// ══ LANES D-pre.1 (ratified 2026-09-27) ══

const LANE = 'PicoVoxel.Lane';
const isCode = (code: string) => (error: unknown) => error instanceof PicoError && error.code === code;
const latin1 = (bytes: Uint8Array, end = 80) => String.fromCharCode(...bytes.subarray(0, end));
const TETRA = {
  vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};

// Coarse sessions keep the matrix cheap; the lane rules do not depend on scale.
let exactS: Pico;
let fastS: Pico;
let autoS: Pico;
let openS: Pico;
beforeAll(async () => {
  exactS = await createPico({ voxelSize: 0.8, lane: 'exact' });
  fastS = await createPico({ voxelSize: 0.8, lane: 'fast' });
  autoS = await createPico({ voxelSize: 0.8, lane: 'auto' });
  openS = await createPico({ voxelSize: 0.8 });
});
afterAll(() => {
  for (const p of [exactS, fastS, autoS, openS]) p.dispose();
});

/** A Class-2 derived part: the session default in fast/auto, the per-op opt-in in open. */
const fastPart = (p: Pico): Voxels => {
  const part = body(p).offset({ distance: 1, ...(p.lane === 'open' ? { fastRenorm: true } : {}) });
  assert.equal(part.lane, 'fast', 'fixture must carry fast provenance');
  return part;
};

/** Writes PicoVoxel.Lane through the raw ABI — how a foreign writer (or a future build) would. */
function forgeLaneTag(p: Pico, target: { metadata: { handle: bigint } }, value: string | number): void {
  const raw = bindPicoRaw(p.module);
  const cString = (text: string) => {
    const size = p.module.lengthBytesUTF8(text) + 1;
    const pointer = p.module._malloc(size);
    p.module.stringToUTF8(text, pointer, size);
    return pointer;
  };
  const name = cString(LANE);
  try {
    if (typeof value === 'number') {
      raw.Metadata_SetFloatValue(p.handle, target.metadata.handle, name, value);
    } else {
      const text = cString(value);
      raw.Metadata_SetStringValue(p.handle, target.metadata.handle, name, text);
      p.module._free(text);
    }
  } finally {
    p.module._free(name);
  }
}

/** .vdb bytes from "elsewhere": a sphere whose PicoVoxel.Lane is whatever the writer chose. */
function foreignVdb(value?: string | number): Uint8Array {
  const sphere = openS.createVoxels({ shape: 'sphere', radius: 4 });
  if (value !== undefined) forgeLaneTag(openS, sphere, value);
  const file = openS.createVdb();
  file.add(sphere, 'part'); // the wrapper's lane was settled before the forge: no refusal
  return file.toBytes();
}

/** Replaces the 80-byte STL header with the given bytes (space-padded). */
function withHeader(stl: Uint8Array, header: string | number[], pad = 0x20): Uint8Array {
  const out = stl.slice();
  out.fill(pad, 0, 80);
  const codes = typeof header === 'string' ? [...header].map((c) => c.charCodeAt(0)) : header;
  out.set(codes, 0);
  return out;
}

// ── Item 1 — the session-claim hybrid (D2+D3, riders R1–R4) ──

test("item 1 matrix: session {exact, fast, auto, open} x format {stl, glb, vdb} x provenance {exact, fast}", () => {
  // Exact provenance exports everywhere, unstamped and identical across sessions.
  const reference = body(openS).toMesh().toStl();
  for (const p of [exactS, fastS, autoS, openS]) {
    const part = body(p);
    assert.equal(part.lane, 'exact', `${p.lane}: fresh CSG is exact`);
    const mesh = part.toMesh();
    const stl = mesh.toStl();
    assert.ok(!latin1(stl).includes('LANE'), `${p.lane}: exact STL keeps the historical header`);
    assert.deepEqual(stl, reference, `${p.lane}: exact STL bytes are session-independent`);
    assert.ok(mesh.toGlb().length > 0, `${p.lane}: exact GLB needs no acknowledgement`);
    const file = p.createVdb();
    file.add(part, 'part');
    const reopened = openS.openVdb(file.toBytes()).getVoxels('part');
    assert.equal(reopened.lane, 'exact');
    assert.ok(!reopened.metadata.names().includes(LANE), `${p.lane}: exact .vdb stays untagged`);
  }

  // Fast provenance in a session that DECLARED a lane ('fast', or 'auto' — the
  // 'auto'-consent rider): STL and .vdb stamp and never refuse; GLB refuses.
  for (const p of [fastS, autoS]) {
    const part = fastPart(p);
    const stl = part.toMesh().toStl();
    assert.match(latin1(stl), /^PicoGK UNITS=mm LANE=fast {2}/, `${p.lane}: stamped without acceptLane`);
    assert.equal(openS.meshFromStl(stl).lane, 'fast');
    const file = p.createVdb();
    file.add(part, 'part');
    const reopened = openS.openVdb(file.toBytes()).getVoxels('part');
    assert.equal(reopened.metadata.get(LANE), 'fast', `${p.lane}: the .vdb stamp rides the field`);
    assert.throws(() => part.toMesh().toGlb(), isCode('PICO_LANE_EXPORT'), `${p.lane}: GLB has no slot — refuses`);
    assert.ok(part.toMesh().toGlb({ acceptLane: 'fast' }).length > 0);
  }

  // Fast provenance in an 'open' session: every format refuses unless acknowledged,
  // and the STL/vdb messages teach BOTH remedies (the D3 DX note).
  const part = fastPart(openS);
  const mesh = part.toMesh();
  assert.throws(
    () => mesh.toStl(),
    (error: unknown) =>
      isCode('PICO_LANE_EXPORT')(error) &&
      /acceptLane: 'fast'/.test((error as Error).message) &&
      /createPico\(\{ lane: 'fast' \}\)/.test((error as Error).message),
  );
  assert.match(latin1(mesh.toStl({ acceptLane: 'fast' })), /^PicoGK UNITS=mm LANE=fast {2}/);
  const file = openS.createVdb();
  file.add(part, 'part');
  assert.throws(
    () => file.toBytes(),
    (error: unknown) =>
      isCode('PICO_LANE_EXPORT')(error) &&
      /acceptLane: 'fast'/.test((error as Error).message) &&
      /createPico\(\{ lane: 'fast' \}\)/.test((error as Error).message),
  );
  assert.ok(file.toBytes({ acceptLane: 'fast' }).length > 0);
  assert.throws(
    () => mesh.toGlb(),
    (error: unknown) => isCode('PICO_LANE_EXPORT')(error) && /every session/.test((error as Error).message),
  );
  assert.ok(mesh.toGlb({ acceptLane: 'fast' }).length > 0);

  // Fast provenance in an 'exact' session is unconstructible: the Class-2 op
  // throws (above), and so does importing it (the ingest-lock test below).
  assert.throws(() => body(exactS).offset({ distance: 1, fastRenorm: true }), isCode('PICO_LANE_LOOSENED'));
});

test("rider R2: meshToStlBytes has no session, so it keeps 'open' semantics", () => {
  const vertices = new Float32Array(TETRA.vertices);
  const triangles = new Uint32Array(TETRA.triangles);
  const historical = openS.createMesh(TETRA).toStl();
  assert.deepEqual(meshToStlBytes(vertices, triangles), historical, 'omitted lane: historical bytes');
  assert.deepEqual(meshToStlBytes(vertices, triangles, {}, 'exact'), historical, "'exact': historical bytes");
  assert.deepEqual(meshToStlBytes(vertices, triangles, { acceptLane: 'fast' }), historical, 'acknowledging exact stamps nothing');
  assert.throws(() => meshToStlBytes(vertices, triangles, {}, 'fast'), isCode('PICO_LANE_EXPORT'));
  const stamped = meshToStlBytes(vertices, triangles, { acceptLane: 'fast' }, 'fast');
  assert.match(latin1(stamped), /^PicoGK UNITS=mm LANE=fast {2}/);
  assert.deepEqual(stamped.subarray(80), historical.subarray(80), 'the stamp changes the header only');
});

test("rider (ii): a lane: 'fast' session consents to Class-2 'fast' only — gpu-l1 and unknown still need acceptLane", () => {
  const mm = openS.createMesh(TETRA).toStl();
  const outsideConsent = (error: unknown) =>
    isCode('PICO_LANE_EXPORT')(error) &&
    /outside the Class-2 consent/.test((error as Error).message) &&
    /acceptLane: 'fast'/.test((error as Error).message) &&
    !/createPico\(\{ lane: 'fast' \}\)/.test((error as Error).message); // declaring the lane would not help

  for (const p of [fastS, autoS]) {
    // STL: an ingested set with a member other than 'fast'.
    for (const [header, stamp] of [
      ['PicoGK UNITS=mm LANE=gpu-l1', 'LANE=gpu-l1'],
      ['PicoGK UNITS=mm LANE=fast,gpu-l1', 'LANE=fast,gpu-l1'],
      ['PicoGK UNITS=mm LANE=unknown', 'LANE=unknown'],
      ['PicoGK UNITS=mm LANE=FAST', 'LANE=unknown'], // malformed → unknown
    ] as const) {
      const mesh = p.meshFromStl(withHeader(mm, header));
      assert.throws(() => mesh.toStl(), outsideConsent, `${p.lane}: ${header} must not ride the fast consent`);
      assert.ok(latin1(mesh.toStl({ acceptLane: 'fast' })).includes(` ${stamp} `), `${p.lane}: acknowledged export stamps ${stamp}`);
      // Class-2 geometry merged with it inherits the wider set, and the refusal.
      assert.throws(() => mesh.merged(fastPart(p).toMesh()).toStl(), outsideConsent);
    }
    assert.doesNotThrow(() => p.meshFromStl(withHeader(mm, 'PicoGK UNITS=mm LANE=fast')).toStl(), 'Class-2 fast still needs nothing');

    // .vdb: fields added from foreign gpu-l1 / float-tagged (unknown) grids.
    for (const value of ['gpu-l1', 'fast,gpu-l1', 1] as const) {
      const container = p.createVdb();
      container.add(p.voxelsFromVdb(foreignVdb(value)), 'foreign');
      assert.throws(() => container.toBytes(), outsideConsent, `${p.lane}: vdb tag '${value}' must not ride the fast consent`);
      assert.ok(container.toBytes({ acceptLane: 'fast' }).length > 0);
    }
    // Union across fields: one fast field plus one gpu-l1 field refuses; fast alone does not.
    const mixed = p.createVdb();
    mixed.add(fastPart(p), 'fast');
    assert.ok(mixed.toBytes().length > 0, 'a Class-2-only container exports on the session consent');
    mixed.add(p.voxelsFromVdb(foreignVdb('gpu-l1')), 'gpu');
    assert.throws(() => mixed.toBytes(), outsideConsent);
  }

  // In an 'open' session the same refusal applies, again without the useless "declare the lane" remedy.
  assert.throws(() => openS.meshFromStl(withHeader(mm, 'PicoGK UNITS=mm LANE=gpu-l1')).toStl(), outsideConsent);
});

test('provenance lookups refuse same-session wrappers that carry no geometry provenance (before any native call)', () => {
  const lattice = openS.createLattice();
  const polyLine = openS.createPolyLine();
  const container = openS.createVdb();
  const invalid = isCode('PICO_INVALID_ARGUMENT');
  const before = openS.allocated;
  for (const operand of [lattice, polyLine, container] as unknown as Voxels[]) {
    assert.throws(() => openS.createScalarField({ from: operand }), invalid);
    assert.throws(() => openS.createVectorField({ from: operand, value: [1, 0, 0] }), invalid);
    assert.throws(() => body(openS).union(operand), invalid);
    assert.throws(() => openS.createMesh(TETRA).merged(operand as unknown as Mesh), invalid);
    assert.throws(() => openS.createVdb().add(operand), invalid);
  }
  const after = openS.allocated;
  assert.equal(after.scalarFields, before.scalarFields, 'no field was created from a non-geometry operand');
  assert.equal(after.vectorFields, before.vectorFields);
});

// ── Item 2 — the CLI/SVG stamp (never refuse) ──

test('item 2: fast slice stacks stamp a CLI v2.0 header remark and an SVG <metadata>; exact bytes do not move', () => {
  const date = { date: '2026-09-27' };
  const strip = (stack: SliceStack): SliceStack => ({
    slices: stack.slices.map(({ lane: _lane, ...slice }) => slice),
    bounds: stack.bounds,
  });

  // Exact: a lane field changes nothing about the bytes.
  const exactStack = sliceVoxels(body(openS));
  assert.equal(exactStack.lane, 'exact');
  assert.ok(exactStack.slices.every((slice) => slice.lane === 'exact'));
  const exactCli = slicesToCli(exactStack, date);
  assert.deepEqual(exactCli, slicesToCli(strip(exactStack), date), 'exact CLI bytes unchanged');
  assert.ok(!new TextDecoder().decode(exactCli).includes('//'), 'no remark on exact stacks');
  assert.equal(slicesFromCli(exactCli).lane, 'exact');

  // Fast: exactly one remark line, inside the header, and the round-trip restores it.
  const fastStack = sliceVoxels(fastPart(fastS));
  assert.equal(fastStack.lane, 'fast');
  assert.ok(fastStack.slices.every((slice) => slice.lane === 'fast'));
  const fastText = new TextDecoder().decode(slicesToCli(fastStack, date));
  assert.match(fastText, /\n\/\/ PicoVoxel LANE=fast \/\/\n\$\$HEADEREND\n/);
  assert.equal(
    fastText.replace('// PicoVoxel LANE=fast //\n', ''),
    new TextDecoder().decode(slicesToCli(strip(fastStack), date)),
    'the stamp is the only difference',
  );
  const back = slicesFromCli(new TextEncoder().encode(fastText));
  assert.equal(back.lane, 'fast');
  assert.ok(back.slices.every((slice) => slice.lane === 'fast'));
  assert.deepEqual(back.warnings, [], 'the remark is a legal CLI comment, not an unsupported command');

  // LUB for hand-assembled stacks: one fast slice stamps the file.
  const mixed: SliceStack = { slices: [exactStack.slices[0]!, { ...fastStack.slices[0]!, lane: 'fast' }], bounds: exactStack.bounds };
  assert.match(new TextDecoder().decode(slicesToCli(mixed, date)), /\/\/ PicoVoxel LANE=fast \/\//);

  // The reader honours only header remarks, with the anchored, case-exact token.
  const inject = (line: string, before: string) =>
    new TextEncoder().encode(new TextDecoder().decode(exactCli).replace(before, () => `${line}\n${before}`));
  const laneOf = (line: string, before = '$$HEADEREND') => slicesFromCli(inject(line, before)).lane;
  assert.equal(laneOf('// PLANE=FASTENED //'), 'exact');
  assert.equal(laneOf('// written by another tool //'), 'exact');
  assert.equal(laneOf('// LANE=fast //', '$$HEADERSTART'), 'exact', 'a remark before the header is not a header stamp');
  assert.equal(laneOf('//LANE=fast//'), 'fast', 'unspaced remark delimiters');
  assert.equal(laneOf('// LANE=gpu-l1 //'), 'fast', 'unknown members are fast-like');

  // SVG: the stamp is one <metadata> line; exact renders the historical document.
  const exactSlice = exactStack.slices[Math.floor(exactStack.slices.length / 2)]!;
  const { lane: _drop, ...bare } = exactSlice;
  assert.equal(sliceToSvg(exactSlice), sliceToSvg(bare as Slice), 'exact SVG bytes unchanged');
  assert.ok(!sliceToSvg(exactSlice).includes('<metadata>'));
  const fastSvg = sliceToSvg({ ...exactSlice, lane: 'fast' });
  assert.ok(fastSvg.includes('\n<metadata>PicoVoxel LANE=fast</metadata>\n<g>'));
  assert.equal(fastSvg.replace('<metadata>PicoVoxel LANE=fast</metadata>\n', ''), sliceToSvg(bare as Slice));
});

// ── Item 3 — the pin-writer guard (D8) ──

test('item 3: assertPinSource admits exact sources only', () => {
  assert.doesNotThrow(() => assertPinSource('exact', 'pin'));
  assert.throws(() => assertPinSource('fast', 'heatx@1mm'), /heatx@1mm: refusing to pin a source with 'fast' provenance/);
  assert.throws(() => assertPinSource(undefined, 'legacy record'), /refusing to pin/, 'a record without provenance is unpinnable');
});

test('item 3: unguardedPinArms flags every unguarded arm, and comments never count as a guard', () => {
  const guarded = "assertPinSource(v.lane, 'a');\nif (updatePins) write();\n";
  assert.deepEqual(unguardedPinArms(guarded), []);
  assert.deepEqual(unguardedPinArms("if (updatePins) write();\nassertPinSource(v.lane, 'a');\n"), [1], 'guard after the arm');
  assert.deepEqual(unguardedPinArms(`${guarded}if (updatePins) writeAgain();\n`), [3], 'a second arm needs its own guard');
  assert.deepEqual(unguardedPinArms(`${guarded}assertPinSource(w.lane, 'b');\nif (updatePins) writeAgain();\n`), []);
  assert.deepEqual(unguardedPinArms("// assertPinSource(v.lane, 'a');\nif (updatePins) write();\n"), [2], 'line comment');
  assert.deepEqual(unguardedPinArms("/* assertPinSource(v.lane) */\nif (updatePins) write();\n"), [2], 'block comment');
  assert.deepEqual(unguardedPinArms("if (process.env.UPDATE_SNAPSHOTS === '1') write();\n"), [1], 'env-keyed arm');
  assert.deepEqual(unguardedPinArms("if (!updateSnapshots) compare();\n"), [1], 'UPDATE_SNAPSHOTS naming');
  assert.deepEqual(unguardedPinArms("const pins = process.env.UPDATE_PINS;\nwhile (pins) write();\n"), [0], 'writer keyed some other way');
  assert.deepEqual(unguardedPinArms('// mentions UPDATE_PINS only in prose\n'), []);
});

test('item 3: every pin-writing arm under test/, bench/ and scripts/ calls the shared guard first (static backstop)', () => {
  const root = join(import.meta.dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return ['results', 'fixtures', 'node_modules'].includes(entry.name) ? [] : walk(path);
      return /\.(ts|mts|mjs|js|cjs)$/.test(entry.name) ? [path] : [];
    });
  // This file is excluded: it is the checker's own test and holds synthetic unguarded arms.
  const sources = ['test', 'bench', 'scripts'].flatMap(walk).filter((path) => path !== join('test', 'lanes.test.ts'));
  const failures = sources.flatMap((path) =>
    unguardedPinArms(readFileSync(join(root, path), 'utf8')).map((line) => `${path}:${line}`),
  );
  assert.deepEqual(failures, [], 'pin-writing arms without a preceding assertPinSource (line 0 = flag used without an if-arm)');

  const pinWriters = sources.filter((path) => /\bif\s*\(\s*updatePins\s*\)/.test(readFileSync(join(root, path), 'utf8'))).sort();
  assert.deepEqual(
    pinWriters,
    [
      'test/examples-helixheatx.test.ts',
      'test/examples-latticelibrary.test.ts',
      'test/examples-quasicrystals.test.ts',
      'test/examples-roverwheel.test.ts',
      'test/examples-shapekernel.test.ts',
      'test/examples-simulation.test.ts',
      'test/g0-gate.test.ts',
    ].map((path) => join(...path.split('/'))),
    'the known pin writers (a new one is fine once it is guarded — add it here)',
  );
  const harness = readFileSync(join(root, 'bench', 'g0-identity.mjs'), 'utf8');
  assert.match(harness, /assertPinSource\(firstOf\[build\]\.provenance/, 'the g0 exact reference path is guarded');
  assert.match(harness, /provenance: mesh\.lane/, 'g0 records carry value provenance, not just the session lane');
});

// ── Item 4 + defect 1 — the persisted set, read by value ──

test('item 4 / defect 1: PicoVoxel.Lane is read by value as a set, collapsed by LUB, never rewritten', () => {
  const cases: Array<[value: string | number, lane: 'exact' | 'fast', derived: string | undefined]> = [
    ['fast', 'fast', 'fast'],
    ['gpu-l1', 'fast', 'gpu-l1'], // an unknown member: fast-like, preserved
    ['gpu-l1,fast,fast', 'fast', 'fast,gpu-l1'], // canonicalised on derivation only
    ['exact', 'exact', 'exact'], // the bottom element: nothing to write, the copy keeps its bytes
    ['GPU!', 'fast', 'unknown'], // outside the member grammar
    ['', 'fast', 'unknown'],
    [1, 'fast', 'unknown'], // float-typed: used to collapse to 'exact'
  ];
  for (const [value, lane, derived] of cases) {
    const loaded = openS.voxelsFromVdb(foreignVdb(value));
    assert.equal(loaded.lane, lane, `'${value}' reads as ${lane}`);
    assert.equal(loaded.metadata.get(LANE), value, `'${value}' is not rewritten on load`);
    const copy = loaded.clone();
    assert.equal(copy.lane, lane);
    assert.equal(copy.metadata.get(LANE), derived, `'${value}' derives as '${derived}'`);
  }

  // Union across operands and across the mesh boundary.
  const gpu = openS.voxelsFromVdb(foreignVdb('gpu-l1'));
  const union = gpu.union(fastPart(openS));
  assert.equal(union.metadata.get(LANE), 'fast,gpu-l1', 'LUB is set union');
  const merged = gpu.toMesh().merged(fastPart(openS).toMesh());
  assert.match(latin1(merged.toStl({ acceptLane: 'fast' })), /^PicoGK UNITS=mm LANE=fast,gpu-l1 /);
  assert.equal(openS.createScalarField({ from: gpu }).metadata.get(LANE), 'gpu-l1');

  // Hygiene: fresh geometry is never read or tagged; only non-exact sets write.
  const fresh = openS.createVoxels({ shape: 'sphere', radius: 2 });
  assert.ok(!fresh.metadata.names().includes(LANE));
  assert.equal(fastPart(openS).metadata.get(LANE), 'fast', "today's bytes already conform to the set grammar");
});

// ── Defects 2 + 3 — the STL header parse ──

test('defects 2+3: anchored case-exact STL lane token, byte-wise UNITS=, set grammar mirrored', () => {
  const mm = openS.createMesh(TETRA).toStl();
  const read = (header: string | number[], pad?: number) => openS.meshFromStl(withHeader(mm, header, pad));

  assert.equal(read('PicoGK UNITS=mm PLANE=FASTENED').lane, 'exact', 'the old substring match false-positived here');
  assert.equal(read('PicoGK UNITS=mm lane=fast').lane, 'exact', 'case-exact key');
  assert.equal(read('PicoGK UNITS=mm XLANE=fast').lane, 'exact', 'anchored at a token start');
  assert.equal(read('PicoGK UNITS=mm LANE=fast').lane, 'fast');
  assert.equal(read('PicoGK UNITS=mm LANE=FAST').lane, 'fast', 'a malformed value is fast-like, never exact');
  assert.equal(read([...'LANE=fast'].map((c) => c.charCodeAt(0)), 0).lane, 'fast', 'NUL-padded headers delimit too');

  // ß (0xDF) upper-cases to 'SS': the old string parse slid the UNITS= index one byte.
  const cm = read([...'PicoGK '].map((c) => c.charCodeAt(0)).concat([0xdf], [...' UNITS=cm'].map((c) => c.charCodeAt(0))));
  assert.deepEqual(cm.bounds().max, [100, 100, 100], 'cm honoured past a high byte');
  assert.deepEqual(read('PicoGK units=cm').bounds().max, [100, 100, 100], 'UNITS= stays case-insensitive (upstream)');

  // The token carries the set: canonical on re-export, overflow degrades to `unknown`.
  const set = fastS.meshFromStl(withHeader(mm, 'PicoGK UNITS=mm LANE=gpu-l1,fast,fast'));
  assert.match(latin1(set.toStl({ acceptLane: 'fast' })), /^PicoGK UNITS=mm LANE=fast,gpu-l1 /);
  const long = fastS.meshFromStl(withHeader(mm, `LANE=${'a'.repeat(70)}`));
  assert.equal(long.lane, 'fast');
  assert.match(latin1(long.toStl({ acceptLane: 'fast' })), /^PicoGK UNITS=mm LANE=unknown /, 'a set too long for 80 bytes stamps unknown');
});

// ── Defect 4 — foreign .vdb pass-through ──

test('defect 4: foreign .vdb tags pass through byte-for-byte; untagged stays untagged; no authorship asserted', () => {
  const tagged = foreignVdb('fast,gpu-l1');
  for (const p of [openS, fastS, exactS]) {
    // Re-serialising opened content never refuses — not even in 'open' or 'exact'.
    const out = p.openVdb(tagged).toBytes();
    assert.equal(openS.openVdb(out).getVoxels('part').metadata.get(LANE), 'fast,gpu-l1', `${p.lane}: tag byte-for-byte`);
  }
  const untagged = foreignVdb();
  const reopened = openS.openVdb(openS.openVdb(untagged).toBytes()).getVoxels('part');
  assert.equal(reopened.lane, 'exact', 'importing is not a Class-2 op: untagged is honestly exact (weak claim)');
  assert.ok(!reopened.metadata.names().includes(LANE), 'and no exact stamp is ever written');

  // A container mixing a foreign fast field with a local exact one still passes through.
  const mixed = openS.openVdb(tagged);
  mixed.add(openS.createVoxels({ shape: 'sphere', radius: 1 }), 'local');
  assert.ok(mixed.toBytes().length > 0);
});

// ── Defect 5 — the ingest lock ──

test("defect 5: importing non-exact provenance into a lane: 'exact' session throws PICO_LANE_LOOSENED, no override, no leak", () => {
  const remedy = (error: unknown) =>
    isCode('PICO_LANE_LOOSENED')(error) && /'open' session/.test((error as Error).message) && /lane: 'fast'/.test((error as Error).message);
  const before = exactS.allocated;

  for (const value of ['fast', 'gpu-l1', 1] as const) {
    assert.throws(() => exactS.voxelsFromVdb(foreignVdb(value)), remedy, `'${value}' must not enter an exact session`);
  }
  const fields = openS.createVdb();
  const fast = fastPart(openS);
  fields.add(openS.createScalarField({ from: fast }), 'sdf');
  fields.add(openS.createVectorField({ from: fast, value: [1, 0, 0] }), 'flow');
  const fieldBytes = fields.toBytes({ acceptLane: 'fast' });
  assert.throws(() => exactS.openVdb(fieldBytes).getScalarField('sdf'), remedy);
  assert.throws(() => exactS.openVdb(fieldBytes).getVectorField('flow'), remedy);

  const fastStl = fast.toMesh().toStl({ acceptLane: 'fast' });
  assert.throws(() => exactS.meshFromStl(fastStl), remedy);

  const after = exactS.allocated;
  for (const kind of ['voxels', 'scalarFields', 'vectorFields', 'meshes'] as const) {
    assert.equal(after[kind], before[kind], `refused ingests free their ${kind}`);
  }

  // Exact and untagged assets load; so does a header that merely looks lane-ish.
  assert.equal(exactS.voxelsFromVdb(foreignVdb()).lane, 'exact');
  assert.equal(exactS.voxelsFromVdb(foreignVdb('exact')).lane, 'exact');
  const plane: Mesh = exactS.meshFromStl(withHeader(openS.createMesh(TETRA).toStl(), 'PicoGK UNITS=mm PLANE=FASTENED'));
  assert.equal(plane.lane, 'exact');
});
