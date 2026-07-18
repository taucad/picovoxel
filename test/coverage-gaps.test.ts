// R24 — the branches the feature suites did not reach, exercised through their
// designed seams. Every test here corresponds to a real behaviour, not a metric:
// dead-flag teardown paths per wrapper, validation arms, unit variants, parser
// tolerances, and escape-hatch accessors.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { guard, PicoGkError } from '../src/errors.ts';
import { createGearOutline, triangulate } from '../examples/picogk/gear.ts';
import { createPicoGK, type PicoGK } from '../src/index.ts';
import { contoursFromSdf, detectWinding, sliceToSvg, sliceVoxels, slicesFromCli, slicesToCli as slicesToCliLocal } from '../src/slicing.ts';
import { meshFromBufferGeometry, toBufferGeometry } from '../src/three.ts';
import { emptyBounds, isEmptyBounds } from '../src/types.ts';

function sdfImageAt(width: number, height: number, sdf: (x: number, y: number) => number) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = sdf(x, y);
  }
  return { width, height, data };
}

const grab = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};
const expectInvalid = (fn: () => unknown, pattern?: RegExp) => {
  const error = grab(fn);
  assert.ok(error instanceof PicoGkError, `expected PicoGkError, got ${String(error)}`);
  assert.equal(error.code, 'PICOGK_INVALID_ARGUMENT');
  if (pattern) assert.match(error.message, pattern);
};

test('guard renders argument detail on every rewrap arm', () => {
  const oom = grab(guard('Op', () => { throw new WebAssembly.RuntimeError('oob'); }, () => 'radius=9'));
  assert.match((oom as Error).message, /\(radius=9\)/);
  const failed = grab(guard('Op', () => { throw new Error('x'); }, () => 'mode=fast'));
  assert.match((failed as Error).message, /\(mode=fast\)/);
});

test('session-death sweep: every wrapper kind no-ops its dispose after teardown, handles readable', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const voxels = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const wrappers = [
    voxels,
    voxels.metadata,
    voxels.toMesh(),
    pk.createLattice(),
    pk.createPolyLine(),
    pk.createScalarField(),
    pk.createVectorField(),
    pk.createVdb(),
  ];
  for (const wrapper of wrappers) assert.equal(typeof wrapper.handle, 'bigint', 'escape hatch present');
  pk.dispose();
  for (const wrapper of wrappers) {
    assert.doesNotThrow(() => wrapper.dispose(), 'D4: dead-session dispose is a no-op');
    assert.doesNotThrow(() => wrapper.dispose(), 'D3: and stays idempotent');
  }
});

test('validation arms: fields getSlice, mesh triples/matrix/normal/radius, three position', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const field = pk.createScalarField({ from: pk.createVoxels({ shape: 'sphere', radius: 4 }) });
  expectInvalid(() => field.getSlice({ index: -1 }), /out of range/);

  expectInvalid(() => pk.createMesh({ vertices: [1, 2], triangles: [] }), /triples/);
  const mesh = pk.createMesh({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] });
  expectInvalid(() => mesh.transform({ matrix: [1, 2, 3] }), /16 elements/);
  expectInvalid(() => mesh.mirror({ point: [0, 0, 0], normal: [0, 0, 0] }), /non-zero/);
  expectInvalid(() => mesh.shellVoxels({ radius: -1 }), /positive radius/);

  const geometry = toBufferGeometry(mesh);
  geometry.deleteAttribute('position');
  expectInvalid(() => meshFromBufferGeometry(pk, geometry), /position attribute/);

  expectInvalid(() => pk.createVoxels({ shape: 'beam', start: [0, 0, 0], end: [1, 0, 0], startRadius: 2 }), /radius/);
  expectInvalid(() => sliceVoxels(pk.createVoxels({ shape: 'sphere', radius: 3 }), { layerHeight: -1 }), /layerHeight/);
  pk.dispose();
});

test('voxels: finite-number arms, empty-shell error, slice z-validation, toScalarField', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  expectInvalid(() => sphere.offset({ distance: Number.NaN }), /finite/);
  expectInvalid(() => sphere.doubleOffset({ first: 1, second: Number.POSITIVE_INFINITY }), /finite/);
  expectInvalid(() => sphere.shell({}), /both offsets/);
  expectInvalid(() => sphere.getSlice({ z: -0.5, interpolated: true } as never), /out of range/);

  const sd = sphere.toScalarField();
  assert.ok(sd.get([4, 0, 0]) !== null, 'toScalarField carries the SD band');
  pk.dispose();
});

test('createVectorField({ from }) without value builds the gradient field', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
  const gradient = pk.createVectorField({ from: sphere });
  // The gradient of an SD field near the surface points radially: probe it.
  const at = gradient.get([5, 0, 0]);
  assert.ok(at !== null, 'gradient field active near the surface');
  pk.dispose();
});

test('vdb: default field name, index getters, unstamped/empty bytes for the handshake arms', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const vdb = pk.createVdb();
  const index = vdb.add(pk.createVoxels({ shape: 'sphere', radius: 3 })); // default name ''
  assert.equal(index, 0);
  assert.ok(vdb.getVoxels(0).volume > 0, 'index getter path');

  // Unstamped bytes (raw save, bypassing the facade's PicoGK metadata stamping):
  // the handshake finds no PicoGK.VoxelSize and reports 0.
  const raw = pk.module;
  const h = 'bigint';
  const create = raw.cwrap('VdbFile_hCreate', h, [h]) as (l: bigint) => bigint;
  const addVox = raw.cwrap('VdbFile_nAddVoxels', 'number', [h, h, 'number', h]) as (l: bigint, f: bigint, n: number, v: bigint) => number;
  const save = raw.cwrap('VdbFile_bSaveToFile', 'boolean', [h, h, 'number']) as (l: bigint, f: bigint, p: number) => boolean;
  const writeString = (text: string) => {
    const bytes = raw.lengthBytesUTF8(text) + 1;
    const pointer = raw._malloc(bytes);
    raw.stringToUTF8(text, pointer, bytes);
    return pointer;
  };

  const rawFile = create(pk.handle);
  const namePtr = writeString('plain');
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 2 });
  addVox(pk.handle, rawFile, namePtr, sphere.handle);
  const pathPtr = writeString('/unstamped.vdb');
  assert.ok(save(pk.handle, rawFile, pathPtr));
  const unstamped = raw.FS.readFile('/unstamped.vdb');
  raw.FS.unlink('/unstamped.vdb');
  assert.equal(pk.vdbVoxelSize(unstamped), 0, 'no PicoGK.VoxelSize metadata -> 0');

  // Empty container bytes: handshake 0 + voxelsFromVdb "no fields" arm.
  const emptyFile = create(pk.handle);
  const emptyPathPtr = writeString('/empty.vdb');
  assert.ok(save(pk.handle, emptyFile, emptyPathPtr));
  const emptyBytes = raw.FS.readFile('/empty.vdb');
  raw.FS.unlink('/empty.vdb');
  assert.equal(pk.vdbVoxelSize(emptyBytes), 0);
  const error = grab(() => pk.voxelsFromVdb(emptyBytes));
  assert.equal((error as PicoGkError).code, 'PICOGK_VDB_NO_COMPATIBLE_FIELD');
  assert.match((error as Error).message, /No fields contained/);

  // First-field-type arms of the handshake: scalar-first and vector-first bytes.
  const scalarFirst = pk.createVdb();
  scalarFirst.add(pk.createScalarField({ from: sphere }), 's');
  assert.ok(pk.vdbVoxelSize(scalarFirst.toBytes()) > 0, 'scalar-first stamped bytes read back');
  const vectorFirst = pk.createVdb();
  const vec = pk.createVectorField();
  vec.set([0, 0, 0], [1, 2, 3]);
  vectorFirst.add(vec, 'v');
  assert.ok(pk.vdbVoxelSize(vectorFirst.toBytes()) > 0, 'vector-first stamped bytes read back');
  pk.dispose();
});

test('gear: high tooth counts (root above base circle) and degenerate triangulation', () => {
  const fifty = createGearOutline({ teeth: 50 });
  assert.ok(fifty.length > 1000, 'outline generated without base-circle root points');
  assert.equal(detectWinding(fifty.flat()), 'ccw', 'outline is CCW without fix-up');

  assert.deepEqual(triangulate([[0, 0], [1, 0], [2, 0], [3, 0]]), [], 'collinear polygon has no ears');

  // A concave notch forces the point-in-triangle containment rejection branch.
  const notched: Array<[number, number]> = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]];
  const tris = triangulate(notched);
  assert.equal(tris.length, 3, 'notched pentagon triangulates into 3 ears');
});

test('stl: auto write rejected; every unit header parses back; unknown unit defaults to mm', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const mesh = pk.createMesh({ vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0], triangles: [0, 1, 2] });
  expectInvalid(() => mesh.toStl({ unit: 'auto' }), /auto/);

  for (const unit of ['cm', 'm', 'ft', 'in'] as const) {
    const back = pk.meshFromStl(mesh.toStl({ unit }));
    const max = back.bounds().max;
    assert.ok(Math.abs(max[0] - 10) < 1e-3, `${unit}: ${max[0]}`);
  }

  // A header with an unknown UNITS token falls back to mm (raw numbers).
  const cm = mesh.toStl({ unit: 'cm' });
  const mangled = cm.slice();
  const headerText = `PicoGK UNITS=xy`.padEnd(80, ' ');
  for (let i = 0; i < 80; i++) mangled[i] = headerText.charCodeAt(i);
  const back = pk.meshFromStl(mangled);
  assert.ok(Math.abs(back.bounds().max[0] - 1) < 1e-3, 'unknown unit token reads raw (cm-scaled) numbers');
  pk.dispose();
});

test('slicing edges: degenerate winding, tiny images, parser warnings and failure arms', () => {
  assert.equal(detectWinding([0, 0, 1, 1, 2, 2]), 'unknown', 'collinear loop has zero area');
  assert.deepEqual(contoursFromSdf({ width: 1, height: 5, data: new Float32Array(5) }), []);

  const cli = (body: string) =>
    new TextEncoder().encode(`$$HEADERSTART\n$$ASCII\n$$UNITS/1\n$$LABEL/1,default\n$$HEADEREND\n$$GEOMETRYSTART\n${body}\n$$GEOMETRYEND\n`);

  // Warnings: degenerate polyline, zero-area polyline, winding mismatch, unknown command.
  const tolerant = slicesFromCli(
    cli(
      [
        '$$LAYER/0.5',
        '$$POLYLINE/1,1,2,0.0,0.0,1.0,1.0', // 2 vertices -> degenerate discard
        '$$POLYLINE/1,1,3,0.0,0.0,1.0,1.0,2.0,2.0', // zero area -> discard
        '$$POLYLINE/1,0,4,0.0,0.0,4.0,0.0,4.0,4.0,0.0,4.0', // declared cw, actually ccw
        '$$WIBBLE/9', // unsupported command
        '// a comment line',
      ].join('\n'),
    ),
  );
  assert.equal(tolerant.slices.length, 1);
  assert.equal(tolerant.slices[0]!.contours.length, 1);
  assert.equal(tolerant.slices[0]!.contours[0]!.winding, 'ccw', 'actual winding wins');
  assert.equal(tolerant.warnings.length, 4, tolerant.warnings.join('; '));

  // Failure arms.
  assert.throws(() => slicesFromCli(cli('$$LAYER/2.0\n$$LAYER/1.0')), /smaller than the previous/);
  assert.throws(() => slicesFromCli(cli('$$POLYLINE/1,1,3,0,0,1,0,1,1')), /z position 0/);
  assert.throws(() => slicesFromCli(cli('$$LAYER/1.0\n$$POLYLINE/7,1,3,0,0,1,0,1,1')), /multiple models/);
  assert.throws(() => slicesFromCli(cli('$$LAYER/1.0\n$$POLYLINE/1,9,3,0,0,1,0,1,1')), /direction/);
  assert.throws(() => slicesFromCli(cli('$$LAYER/1.0\n$$POLYLINE/1,1')), /Missing parameter/);
  assert.throws(
    () => slicesFromCli(new TextEncoder().encode('$$HEADERSTART\n$$UNITS/0\n$$HEADEREND\n')),
    /Invalid parameter for \$\$UNITS/,
  );
  assert.throws(
    () => slicesFromCli(new TextEncoder().encode('$$HEADERSTART\n$$UNITS/abc\n$$HEADEREND\n')),
    /Invalid parameter/,
  );
  assert.throws(
    () => slicesFromCli(new TextEncoder().encode('$$HEADERSTART\n$$LABEL/1,a\n$$LABEL/2,b\n$$HEADEREND\n')),
    /Multiple labels/,
  );
  assert.throws(
    () => slicesFromCli(new TextEncoder().encode('$$HEADERSTART\n$$HEADEREND\n')),
    /no usable \$\$UNITS/,
  );

  // Header niceties: $$DIMENSION consumed, comments and prose tolerated.
  const fancy = slicesFromCli(
    new TextEncoder().encode(
      'preamble prose\n// comment\n$$HEADERSTART\n$$ASCII\n$$UNITS/1\n$$DATE/2026-07-18\n' +
        '$$DIMENSION/0.0,0.0,0.0,1.0,1.0,1.0\n$$LAYERS/00001\n$$HEADEREND\n' +
        '$$GEOMETRYSTART\n$$LAYER/1.0\n$$POLYLINE/3,1,3,0.0,0.0,1.0,0.0,1.0,1.0\n$$GEOMETRYEND\n',
    ),
  );
  assert.equal(fancy.date, '2026-07-18');
  assert.equal(fancy.headerLayerCount, 1);
  assert.equal(fancy.slices[0]!.contours[0]!.winding, 'ccw');
});

test('svg: unknown-winding stroke and explicit viewBox', () => {
  const slice = {
    z: 1,
    contours: [{ points: new Float64Array([0, 0, 1, 1, 2, 2, 0, 0]), winding: 'unknown' as const }],
  };
  const svg = sliceToSvg(slice, { viewBox: [0, 0, 10, 10], strokeWidth: 0.5 });
  assert.match(svg, /stroke='red'/, 'degenerate contours render red');
  assert.match(svg, /viewBox='0 0 10 10'/);
});

test('types: the SG15 sentinel helpers', () => {
  const sentinel = emptyBounds();
  assert.ok(isEmptyBounds(sentinel));
  assert.ok(!isEmptyBounds({ min: [0, 0, 0], max: [1, 1, 1] }));
});

test('stl: degenerate triangle writes a zero normal; solid-headed binary parses; headerless units default mm', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  // All three corners identical -> zero-area facet -> unnormalizable normal.
  const degenerate = pk.createMesh({ vertices: [1, 1, 1, 1, 1, 1, 1, 1, 1], triangles: [0, 1, 2] });
  const stl = degenerate.toStl();
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getFloat32(84, true), 0, 'zero normal written, not NaN');

  // A BINARY stl whose header starts with 'solid' (no ASCII 'vertex' text) must parse.
  const mesh = pk.createMesh({ vertices: [0, 0, 0, 5, 0, 0, 0, 5, 0], triangles: [0, 1, 2] });
  const solidHeaded = mesh.toStl().slice();
  const solidHeader = 'solid but actually binary'.padEnd(80, ' ');
  for (let i = 0; i < 80; i++) solidHeaded[i] = solidHeader.charCodeAt(i);
  assert.equal(pk.meshFromStl(solidHeaded).triangleCount, 1);

  // No UNITS= token anywhere -> auto defaults to mm.
  const plainHeader = 'no units here'.padEnd(80, ' ');
  const headerless = mesh.toStl().slice();
  for (let i = 0; i < 80; i++) headerless[i] = plainHeader.charCodeAt(i);
  assert.ok(Math.abs(pk.meshFromStl(headerless).bounds().max[0] - 5) < 1e-3);
  pk.dispose();
});

test('vdb: empty-container listing, index-keyed type mismatch, non-field wrapper refused', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const vdb = pk.createVdb();
  const missing = grab(() => vdb.getVoxels('anything'));
  assert.match((missing as Error).message, /has: none/, 'empty container listing says none');

  vdb.add(pk.createVoxels({ shape: 'sphere', radius: 2 }), 'v');
  const mismatch = grab(() => vdb.getScalarField(0));
  assert.match((mismatch as Error).message, /Field 0 is a voxels/, 'index-keyed mismatch message');

  const mesh = pk.createMesh({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] });
  expectInvalid(() => vdb.add(mesh as never), /Expected a Voxels/);
  pk.dispose();
});

test('slicing: border-clipped blobs stitch one-sidedly and drop open fragments', () => {
  // Circles centred on opposite image corners: the arcs hit the border and stay
  // open, driving BOTH one-sided extension arms (seed lands at either chain end
  // depending on scan order) and the open-fragment discard path.
  for (const corner of [
    (x: number, y: number) => Math.hypot(x, y) - 30,
    (x: number, y: number) => Math.hypot(x - 39, y - 39) - 30,
    (x: number, y: number) => Math.min(Math.hypot(x, y - 39) - 25, Math.hypot(x - 39, y) - 25),
  ]) {
    const contours = contoursFromSdf(sdfImageAt(40, 40, corner));
    for (const contour of contours) {
      const p = contour.points;
      assert.equal(p[0], p[p.length - 2], 'surviving contours are closed');
    }
  }
});

test('cli: absolute-XY stacks write signed dimensions; prose before GEOMETRYSTART tolerated', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const negative = pk.createVoxels({ shape: 'sphere', center: [-30, -30, 0], radius: 4 });
  const stack = sliceVoxels(negative, { useAbsoluteXY: true });
  const text = new TextDecoder().decode(slicesToCliLocal(stack, { date: '2026-07-18' }));
  assert.match(text, /\$\$DIMENSION\/-000000\d{2}\./, 'negative bounds carry the sign');

  const parsed = slicesFromCli(
    new TextEncoder().encode(
      '$$HEADERSTART\n$$UNITS/1\n$$HEADEREND\nprose between header and geometry\n$$GEOMETRYSTART\n' +
        '$$LAYER/1.0\n$$POLYLINE/1,1,3,0.0,0.0,1.0,0.0,1.0,1.0\n$$GEOMETRYEND\n',
    ),
  );
  assert.equal(parsed.slices.length, 1);
  pk.dispose();
});

test('cli: units validation, default date, empty geometry, header variants', () => {
  const stackLike = { slices: [{ z: 1, contours: [] }], bounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const } };
  assert.throws(() => slicesToCliLocal(stackLike, { units: -5 }), /units must be positive/);

  // Default date arm: today's ISO date lands in the header.
  const dated = new TextDecoder().decode(slicesToCliLocal(stackLike, {}));
  assert.match(dated, /\$\$DATE\/\d{4}-\d{2}-\d{2}/);

  // Empty geometry: header only -> zero slices, stackBounds([]) arm.
  const empty = slicesFromCli(
    new TextEncoder().encode('$$HEADERSTART\n$$UNITS/1\n$$HEADEREND\n$$GEOMETRYSTART\n$$GEOMETRYEND\n'),
  );
  assert.equal(empty.slices.length, 0);
  assert.equal(empty.bounds.max[2], 0);

  // Header variants: commands on the HEADERSTART line, prose inside the header,
  // parameterless $$DATE, blank + prose lines inside geometry.
  const variants = slicesFromCli(
    new TextEncoder().encode(
      '$$HEADERSTART$$UNITS/1\nheader prose\n$$DATE\n$$HEADEREND\n$$GEOMETRYSTART\n\nstray prose\n' +
        '$$LAYER/1.0\n$$POLYLINE/1,1,3,0.0,0.0,2.0,0.0,2.0,2.0\n$$GEOMETRYEND\n',
    ),
  );
  assert.equal(variants.date, '');
  assert.equal(variants.slices.length, 1);
});

test('sliceVoxels with useAbsoluteXY shifts contours to world coordinates', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  const off = pk.createVoxels({ shape: 'sphere', center: [30, 0, 0], radius: 3 });
  const relative = sliceVoxels(off);
  const absolute = sliceVoxels(off, { useAbsoluteXY: true });
  const midR = relative.slices[Math.floor(relative.slices.length / 2)]!.contours[0]!;
  const midA = absolute.slices[Math.floor(absolute.slices.length / 2)]!.contours[0]!;
  assert.ok(midA.points[0]! > midR.points[0]! + 20, 'absolute XY re-bases near x=30');
  pk.dispose();
});

test('withSdfPointer rejects a non-function before touching the module (internal trust boundary)', async () => {
  // All facade routes narrow sdf by typeof before reaching this seam; the guard
  // defends direct/raw misuse. It throws before any ctx use, so a stub is fine.
  const { withSdfPointer } = await import('../src/context.ts');
  assert.throws(
    () => withSdfPointer(undefined as never, 42 as never, () => 0),
    (error: unknown) => error instanceof PicoGkError && /must be a function/.test((error as Error).message),
  );
});

test('checkedMalloc: a failed wasm allocation throws the typed OOM error, not a RangeError', async () => {
  // Found by the R12 fine-voxel probe: near the 4 GB wasm32 ceiling _malloc
  // returns 0 and the subsequent HEAP*.set surfaced as a bare RangeError.
  const { checkedMalloc } = await import('../src/context.ts');
  const failing = { _malloc: () => 0 } as never;
  assert.throws(
    () => checkedMalloc(failing, 1024, 'a test buffer'),
    (error: unknown) =>
      error instanceof PicoGkError &&
      error.code === 'PICOGK_OUT_OF_MEMORY' &&
      /1024 bytes.*a test buffer/.test(error.message),
  );
  // A zero-byte request may legitimately return 0 without throwing.
  assert.equal(checkedMalloc(failing, 0, 'nothing'), 0);
});
