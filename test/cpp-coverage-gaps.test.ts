// The native paths the feature suites never reached, each exercised through the input that
// reaches it in real use and checked against an independent oracle: the dense JS-callback
// twin for the tape evaluator, upstream's own export for the column-culled and tile-aware
// repairs, and boundary pairs (the rejected tape next to the accepted one) for validation.
// The coverage-cpp CI job measures the nine own C++ translation units over the light suite;
// this file is what keeps them at 100% lines and functions.
//
// Three input classes are not producible through the product's own operations, so they
// arrive the way they arrive in practice, as foreign data:
// - raw tapes with malformed words or non-finite constants (the picovoxel/raw ABI);
// - OpenVDB files holding active tiles, a non-positive background or a band that is not a
//   whole number of voxels (foreignLevelSet below writes them).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, type Pico, type SdfExpression, type Voxels } from '../src/index.ts';
import { bindPicoRaw, type PicoRaw } from '../src/raw.ts';

type Vec3 = readonly [number, number, number];

/** A tile or leaf inside the one level-1 node (index space [0, 128)³) the writer emits. */
interface ForeignNode {
  /** Leaf-aligned origin: multiples of 8, each in [0, 128). */
  at: Vec3;
  /** A tile's value, or a leaf's 512 values (x-major, then y, then z). */
  value: number | Float32Array;
  /** Active state of the tile, or of every voxel of the leaf. */
  active: boolean;
}

/**
 * Serializes one level-set FloatTree (5-4-3) as an uncompressed OpenVDB file, format 225:
 * root, one level-2 node, one level-1 node holding the given tiles and leaves; every other
 * value is an inactive background tile.
 */
function foreignLevelSet(options: {
  voxelSize: number;
  background: number;
  nodes?: readonly ForeignNode[];
}): Uint8Array {
  const { voxelSize: s, background, nodes = [] } = options;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const put = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const scalar = (size: number, write: (view: DataView) => void) => {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    put(bytes);
  };
  const u8 = (n: number) => scalar(1, (v) => v.setUint8(0, n));
  const u32 = (n: number) => scalar(4, (v) => v.setUint32(0, n, true));
  const i64 = (n: number) => scalar(8, (v) => v.setBigInt64(0, BigInt(n), true));
  const f32s = (values: ArrayLike<number>) => put(new Uint8Array(Float32Array.from(values).buffer));
  const text = (value: string) => put(new TextEncoder().encode(value));
  const str = (value: string) => {
    u32(value.length);
    text(value);
  };
  const mask = (bits: number, on: (n: number) => boolean) => {
    const bytes = new Uint8Array(bits / 8);
    for (let n = 0; n < bits; n++) if (on(n)) bytes[n >> 3]! |= 1 << (n & 7);
    put(bytes);
  };

  const slot = ([x, y, z]: Vec3) => ((x >> 3) << 8) | ((y >> 3) << 4) | (z >> 3);
  const bySlot = new Map(nodes.map((node) => [slot(node.at), node]));
  const leafAt = (n: number) => {
    const node = bySlot.get(n);
    return node !== undefined && typeof node.value !== 'number' ? node : undefined;
  };
  const leaves = [...bySlot.keys()].filter((n) => leafAt(n)).sort((a, b) => a - b);
  const NO_MASK_AND_ALL_VALS = 6;

  // Header: magic, format 225, library 13.0, grid offsets present, UUID, no file metadata, one grid.
  i64(0x56444220);
  u32(225);
  u32(13);
  u32(0);
  u8(1);
  text('00000000-0000-0000-0000-000000000000');
  u32(0);
  u32(1);
  // Grid descriptor: name, type, no instance parent, then the grid/block/end offsets (patched below).
  str('foreign');
  str('Tree_float_5_4_3');
  str('');
  const offsets = length;
  for (let i = 0; i < 3; i++) i64(0);

  const gridPos = length;
  u32(0); // no compression
  u32(1); // grid metadata: the level-set class alone
  str('class');
  str('string');
  str('level set');
  str('UniformScaleMap'); // scale, voxel size, inverse scale, inverse scale², inverse twice scale
  const map = [s, s, 1 / s, 1 / s ** 2, 0.5 / s].flatMap((v) => [v, v, v]);
  put(new Uint8Array(Float64Array.from(map).buffer));

  // Topology: one buffer; a root with no tiles and one child at the origin.
  u32(1);
  f32s([background]);
  u32(0);
  u32(1);
  for (let i = 0; i < 3; i++) u32(0);
  // Level-2 node: slot 0 is the level-1 node, every other slot an inactive background tile.
  mask(32768, (n) => n === 0);
  mask(32768, () => false);
  u8(NO_MASK_AND_ALL_VALS);
  f32s(new Float32Array(32768).fill(background));
  // Level-1 node: leaves are children; tiles carry their own value and active state.
  mask(4096, (n) => leafAt(n) !== undefined);
  mask(4096, (n) => bySlot.get(n)?.active === true && leafAt(n) === undefined);
  u8(NO_MASK_AND_ALL_VALS);
  f32s(
    Array.from({ length: 4096 }, (_, n) => {
      const value = bySlot.get(n)?.value ?? background;
      return typeof value === 'number' ? value : 0;
    }),
  );
  for (const n of leaves) mask(512, () => leafAt(n)!.active);

  // Buffers, one per leaf in topology order: value mask, then the 512 values.
  const blockPos = length;
  for (const n of leaves) {
    mask(512, () => leafAt(n)!.active);
    u8(NO_MASK_AND_ALL_VALS);
    f32s(leafAt(n)!.value as Float32Array);
  }
  const endPos = length;

  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const view = new DataView(bytes.buffer);
  [gridPos, blockPos, endPos].forEach((pos, i) => view.setBigInt64(offsets + 8 * i, BigInt(pos), true));
  return bytes;
}

let pk: Pico;
let raw: PicoRaw;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
  raw = bindPicoRaw(pk.module);
});
afterAll(() => pk.dispose());

/** Copies words into a fresh wasm allocation; the caller frees it. */
function heapCopy(kind: 'u32' | 'f64' | 'f32', values: ArrayLike<number>): number {
  const bytes = { u32: 4, f64: 8, f32: 4 }[kind];
  const pointer = pk.module._malloc(Math.max(values.length, 1) * bytes);
  if (kind === 'u32') pk.module.HEAPU32.set(values, pointer >>> 2);
  else if (kind === 'f32') pk.module.HEAPF32.set(values, pointer >>> 2);
  else pk.module.HEAPF64.set(values, pointer >>> 3);
  return pointer;
}

/** Runs body with pointers to the tape and a bounds box, frees them, and returns what body threw. */
function withTape(
  words: readonly number[],
  constants: readonly number[],
  body: (tape: { instructions: number; constants: number; bounds: number }) => void,
): unknown {
  const instructions = heapCopy('u32', words);
  const pool = heapCopy('f64', constants);
  const bounds = heapCopy('f32', [-2, -2, -2, 2, 2, 2]);
  try {
    body({ instructions, constants: pool, bounds });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    for (const pointer of [instructions, pool, bounds]) pk.module._free(pointer);
  }
}

// Opcodes and the instruction word, as src/tape.ts encodes them: [op, a | (b << 16)].
const OP = { const: 0, x: 1, neg: 8, sub: 5, log: 19 } as const;
const word = (op: number, a = 0, b = 0) => [op, a | (b << 16)];

/** Renders a raw tape into a fresh empty field; returns the field and what the call threw. */
function renderRawTape(
  words: readonly number[],
  constants: readonly number[],
  options: { count?: number; constantCount?: number; nullInstructions?: boolean; nullBounds?: boolean } = {},
): { voxels: Voxels; thrown: unknown } {
  const voxels = pk.createVoxels({ shape: 'empty' });
  const thrown = withTape(words, constants, (tape) =>
    raw.Voxels_RenderImplicitTape(
      pk.handle,
      voxels.handle,
      options.nullBounds ? 0 : tape.bounds,
      options.nullInstructions ? 0 : tape.instructions,
      options.count ?? words.length / 2,
      tape.constants,
      options.constantCount ?? constants.length,
    ),
  );
  return { voxels, thrown };
}

/** A C++ throw crossing the raw ABI arrives as a WebAssembly.Exception, and the target is untouched. */
function assertRejected(result: { voxels: Voxels; thrown: unknown }, label: string): void {
  assert.ok(
    result.thrown instanceof WebAssembly.Exception,
    `${label}: expected a C++ throw, got ${String(result.thrown)}`,
  );
  assert.equal(result.voxels.isEmpty, true, `${label}: the rejected tape wrote into the target`);
}

function assertRendered(result: { voxels: Voxels; thrown: unknown }, label: string): void {
  assert.equal(result.thrown, undefined, `${label}: the accepted twin threw`);
  assert.equal(result.voxels.isEmpty, false, `${label}: the accepted twin rendered nothing`);
}

test('tape validation rejects each malformed class exactly at its boundary, before touching the target', () => {
  const before = pk.allocated.voxels;
  // x - 1: a half-space, so every accepted twin below renders something.
  const halfSpace = [...word(OP.x), ...word(OP.const, 0), ...word(OP.sub, 0, 1)];

  assertRejected(renderRawTape(halfSpace, [1], { count: 0 }), 'empty instruction stream');
  assertRejected(renderRawTape(halfSpace, [1], { nullInstructions: true }), 'null instruction stream');
  assertRendered(renderRawTape(halfSpace, [1]), 'three-instruction half-space');

  // log(x) is the last opcode (19); one past it is unknown.
  assertRejected(renderRawTape([...word(OP.x), ...word(20, 0)], []), 'opcode 20');
  assertRendered(renderRawTape([...word(OP.x), ...word(OP.log, 0), ...word(OP.neg, 1)], []), 'opcode 19');

  // CONST reads pool[a]: a = 1 needs two constants.
  const constOne = [...word(OP.x), ...word(OP.const, 1), ...word(OP.sub, 0, 1)];
  assertRejected(renderRawTape(constOne, [0, 1], { constantCount: 1 }), 'constant index == count');
  assertRendered(renderRawTape(constOne, [0, 1]), 'constant index < count');

  // Operands must name an earlier instruction (SSA): a or b == i is a self-reference.
  assertRejected(renderRawTape([...word(OP.x), ...word(OP.neg, 1)], []), 'operand a == i');
  assertRendered(renderRawTape([...word(OP.x), ...word(OP.neg, 0)], []), 'operand a < i');
  assertRejected(
    renderRawTape([...word(OP.x), ...word(OP.const, 0), ...word(OP.sub, 1, 2)], [1]),
    'operand b == i',
  );
  assertRendered(
    renderRawTape([...word(OP.x), ...word(OP.const, 0), ...word(OP.sub, 0, 1)], [1]),
    'operand b < i',
  );

  assert.equal(pk.allocated.voxels - before, 11, 'one field per case, nothing more');
});

test('tape entry points reject a null bounds box and a non-empty fresh-render target, leaving the target as it was', () => {
  const halfSpace = [...word(OP.x), ...word(OP.const, 0), ...word(OP.sub, 0, 1)];
  assertRejected(renderRawTape(halfSpace, [1], { nullBounds: true }), 'render: null bounds');

  const sphere = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const hash = sphere.gridHash().hash;
  const intoNonEmpty = withTape(halfSpace, [1], (tape) =>
    raw.Voxels_RenderImplicitTape(
      pk.handle,
      sphere.handle,
      tape.bounds,
      tape.instructions,
      3,
      tape.constants,
      1,
    ),
  );
  assert.ok(intoNonEmpty instanceof WebAssembly.Exception, 'render into a non-empty field must throw');
  assert.equal(sphere.gridHash().hash, hash, 'the rejected fresh render modified the target');

  const composeNullBounds = withTape(halfSpace, [1], (tape) =>
    raw.Voxels_RenderImplicitTapeCompose(
      pk.handle,
      sphere.handle,
      0,
      tape.instructions,
      3,
      tape.constants,
      1,
    ),
  );
  assert.ok(composeNullBounds instanceof WebAssembly.Exception, 'compose with null bounds must throw');
  assert.equal(sphere.gridHash().hash, hash, 'the rejected compose modified the target');
});

test('the tape IntersectImplicit oracle keeps an empty target empty and a solid mask keeps the inside set', () => {
  const inside = [...word(OP.const, 0)];
  const empty = pk.createVoxels({ shape: 'empty' });
  const onEmpty = withTape(inside, [-10], (tape) =>
    raw.Voxels_IntersectImplicitTape(pk.handle, empty.handle, tape.instructions, 1, tape.constants, 1),
  );
  assert.equal(onEmpty, undefined);
  assert.equal(empty.isEmpty, true);

  const sphere = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const masked = sphere.clone();
  const onSphere = withTape(inside, [-10], (tape) =>
    raw.Voxels_IntersectImplicitTape(pk.handle, masked.handle, tape.instructions, 1, tape.constants, 1),
  );
  assert.equal(onSphere, undefined);
  assert.equal(
    masked.equals(sphere),
    true,
    'a mask that is inside everywhere must not change the inside set',
  );
});

// ── The tape evaluator's special cases, against the dense JS-callback twin ──
//
// Every expression below wraps its special case in min(sphere, X) (or scales the sphere by
// it). X either never wins or is NaN, and std::min returns its first operand on NaN, so the
// field is the sphere's to the bit, whatever libm does in X. What X changes is the interval
// pass: a NaN-capable or unbounded interval blocks the branch decision and the pruning, so
// the dense loop must run where it did not before, and the grid hash (which includes every
// active value) must still equal the dense callback's.

const cmin = (a: number, b: number) => (b < a ? b : a); // std::min, NaN included
const cmax = (a: number, b: number) => (a < b ? b : a); // std::max
const sphereExpression = (radius: number): SdfExpression => [
  '-',
  ['sqrt', ['+', ['*', 'x', 'x'], ['*', 'y', 'y'], ['*', 'z', 'z']]],
  radius,
];
const sphereTwin = (radius: number) => (x: number, y: number, z: number) =>
  Math.sqrt(x * x + y * y + z * z) - radius;
const around = { boundsMin: [-8, -8, -8] as Vec3, boundsMax: [8, 8, 8] as Vec3 };

function assertTwins(
  expression: SdfExpression,
  twin: (x: number, y: number, z: number) => number,
  label: string,
) {
  const fromTape = pk.createVoxels({ shape: 'implicit', ...around, sdf: expression });
  const fromCallback = pk.createVoxels({ shape: 'implicit', ...around, sdf: twin });
  assert.equal(fromTape.isEmpty, false, `${label}: empty field`);
  assert.equal(
    fromTape.gridHash().hash,
    fromCallback.gridHash().hash,
    `${label}: tape diverged from its twin`,
  );
  assert.equal(fromTape.equals(fromCallback), true, `${label}: inside sets differ`);
}

test('unbounded and NaN-capable intervals never prune: min(sphere, X) equals its dense twin', () => {
  const sphere = sphereExpression(5);
  const twin = sphereTwin(5);
  const huge: SdfExpression = ['exp', 1000]; // +inf at every sample; its interval is [DBL_MAX, +inf]
  const cases: [string, SdfExpression, (x: number, y: number, z: number) => number][] = [
    ['inf - inf (a full-line interval)', ['-', huge, huge], () => Math.exp(1000) - Math.exp(1000)],
    ['0 * inf (a NaN corner)', ['*', 0, huge], () => 0 * Math.exp(1000)],
    ['sin(inf) (a non-finite sine argument)', ['sin', huge], () => Math.sin(Math.exp(1000))],
    ['pow(2, inf) (a non-finite exponent)', ['pow', 2, huge], () => 2 ** Math.exp(1000)],
  ];
  for (const [label, x, xTwin] of cases) {
    assertTwins(['min', sphere, x], (px, py, pz) => cmin(twin(px, py, pz), xTwin(px, py, pz)), label);
  }
});

test('pow intervals: zero, negative integer (pole and away) and fractional exponents equal their twins', () => {
  const sphere = sphereExpression(5);
  const twin = sphereTwin(5);
  // pow(x, 0) is 1 for every x, NaN and the pole included.
  assertTwins(['*', sphere, ['pow', 'x', 0]], (x, y, z) => twin(x, y, z) * x ** 0, 'pow(x, 0)');
  // +100 keeps X above the sphere wherever it is finite: blocks straddling x = 0 hit the
  // pole case, blocks away from it the monotone case, for odd (-1) and even (-2) k.
  assertTwins(
    ['min', sphere, ['+', ['pow', 'x', -1], 100], ['+', ['pow', 'y', -2], 100]],
    (x, y, z) => cmin(cmin(twin(x, y, z), x ** -1 + 100), y ** -2 + 100),
    'pow(x, -1) and pow(y, -2)',
  );
  // A fractional exponent is NaN for negative bases (those blocks cannot be classified) and
  // monotone on the corners for non-negative ones.
  assertTwins(
    ['min', sphere, ['+', ['pow', 'x', 1.5], 100]],
    (x, y, z) => cmin(twin(x, y, z), x ** 1.5 + 100),
    'pow(x, 1.5)',
  );
});

test('z-varying floor and mod run in the paired-lane evaluator and equal their twin', () => {
  // Both operands depend on z, so they land in the level evaluated two z samples per
  // f64x2 lane pair. floor, and mod as a - b*floor(a/b), are exact, so the twin is bitwise.
  const expression: SdfExpression = [
    'max',
    sphereExpression(6),
    ['-', ['mod', 'z', 3], 1],
    ['-', ['floor', ['*', 0.3, 'z']], 1],
  ];
  const twin = sphereTwin(6);
  assertTwins(
    expression,
    (x, y, z) => cmax(cmax(twin(x, y, z), z - 3 * Math.floor(z / 3) - 1), Math.floor(0.3 * z) - 1),
    'mod(z, 3) and floor(0.3 z)',
  );
});

test('a raw NaN constant, inf - inf and its negation give three NaN fields with one canonical hash', () => {
  // Stored NaN bits differ (the sign follows the expression; inf - inf's own sign is the
  // platform's), and the grid hash canonicalizes every NaN to 0x7fc00000.
  const box = { boundsMin: [0, 0, 0] as Vec3, boundsMax: [1, 1, 1] as Vec3 };
  const nan: SdfExpression = ['-', ['exp', 1000], ['exp', 1000]];
  const positive = pk.createVoxels({ shape: 'implicit', ...box, sdf: nan });
  const negated = pk.createVoxels({ shape: 'implicit', ...box, sdf: ['-', nan] });

  const fromConstant = pk.createVoxels({ shape: 'empty' });
  const bounds = heapCopy('f32', [0, 0, 0, 1, 1, 1]);
  const instructions = heapCopy('u32', word(OP.const, 0));
  const pool = heapCopy('f64', [Number.NaN]);
  try {
    raw.Voxels_RenderImplicitTape(pk.handle, fromConstant.handle, bounds, instructions, 1, pool, 1);
  } finally {
    for (const pointer of [bounds, instructions, pool]) pk.module._free(pointer);
  }

  const bitsOf = (voxels: Voxels) => {
    const { data } = voxels.getSlice({ index: 2, mode: 'sdf' });
    return new Set(new Uint32Array(data.buffer, data.byteOffset, data.length));
  };
  const [a] = [...bitsOf(positive)];
  assert.equal(bitsOf(positive).size, 1);
  assert.deepEqual([...bitsOf(negated)], [(a! ^ 0x80000000) >>> 0], 'negation flips only the sign bit');
  for (const bits of [a!, (a! ^ 0x80000000) >>> 0]) {
    assert.ok(
      (bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0,
      `0x${bits.toString(16)} is not a NaN`,
    );
  }

  const hash = positive.gridHash();
  assert.equal(hash.activeVoxels, 9 ** 3, 'every sample of the 2+2x3 voxel box is an active NaN');
  assert.deepEqual(negated.gridHash(), hash);
  assert.deepEqual(fromConstant.gridHash(), hash);
});

// ── Compose (withImplicit on a non-empty field) ──

test('compose: a z-independent SDF composes into a live field exactly like the callback', () => {
  const base = pk.createVoxels({ shape: 'sphere', center: [10, 0, 0], radius: 6 });
  const bounds = { boundsMin: [-12, -12, -6] as Vec3, boundsMax: [12, 12, 6] as Vec3 };
  const cylinder: SdfExpression = ['-', ['sqrt', ['+', ['*', 'x', 'x'], ['*', 'y', 'y']]], 4];
  const fromTape = base.withImplicit({ ...bounds, sdf: cylinder });
  const fromCallback = base.withImplicit({ ...bounds, sdf: (x, y) => Math.sqrt(x * x + y * y) - 4 });
  assert.equal(fromTape.equals(fromCallback), true);
  assert.equal(fromTape.gridHash().hash, fromCallback.gridHash().hash);
  assert.ok(fromTape.properties().volume > base.properties().volume, 'the cylinder was not composed');
});

test('compose: a column proven solid fills clipped and whole blocks with the dense per-voxel result', () => {
  // Deep inside a radius-50 sphere every column of this box is interior, so the compose
  // skips the tape: whole leaves become tiles, bbox-clipped blocks are written directly.
  // The oracle is the per-voxel definition itself: over the box grown by the 3-voxel band
  // (voxels -13..13 on each axis) the result is solid, elsewhere it is the base field.
  // (Not the callback: the post-fill prune picovoxel's own patch adds to the callback
  // render, patches/PicoGKRuntime/0002-post-fill-prune.patch, collapses an inactive leaf
  // holding both signs by the sign of its first voxel. Upstream PicoGK does not prune
  // there, and the tape path matches upstream's per-voxel result, which this test locks in.)
  // pow(v, 2) rather than v * v: its interval knows a square is non-negative, so a column
  // whose z range straddles 0 still classifies (v * v's corners go negative there).
  const solid: SdfExpression = ['-', ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]], 50];
  const base = pk.createVoxels({ shape: 'sphere', center: [6, 0, 0], radius: 3 });
  const bounds = { boundsMin: [-5, -5, -5] as Vec3, boundsMax: [5, 5, 5] as Vec3 };
  const composed = base.withImplicit({ ...bounds, sdf: solid });
  const inBox = (v: number) => v >= -6.5 && v <= 6.5;
  let mismatches = 0;
  for (let x = -9; x <= 10; x += 0.5) {
    for (let y = -9; y <= 9; y += 0.5) {
      for (let z = -9; z <= 9; z += 0.5) {
        const expected = (inBox(x) && inBox(y) && inBox(z)) || base.isInside([x, y, z]);
        if (composed.isInside([x, y, z]) !== expected) mismatches++;
      }
    }
  }
  assert.equal(mismatches, 0, 'the composed inside set is not box ∪ base');
  // On an empty field the compose and the fresh-grid fill are one field.
  const empty = pk.createVoxels({ shape: 'empty' }).withImplicit({ ...bounds, sdf: solid });
  const fresh = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: solid });
  assert.equal(empty.equals(fresh), true);
  assert.equal(empty.gridHash().hash, fresh.gridHash().hash);
});

// ── Foreign level sets: active tiles, background and band edge cases ──

/** A second session at the given voxel size (1.0 mm: where the column-culled projection matches the vendored export). */
async function withSession<T>(
  voxelSize: number,
  body: (session: Pico, sessionRaw: PicoRaw) => T,
): Promise<T> {
  const session = await createPico({ voxelSize });
  try {
    return body(session, bindPicoRaw(session.module));
  } finally {
    session.dispose();
  }
}

const solidLeaf = (value: number) => new Float32Array(512).fill(value);
/** Active tiles inside (-1) and outside (+1) the surface, and one far above in z. */
const tiled: ForeignNode[] = [
  { at: [16, 16, 16], value: -1, active: true },
  { at: [40, 16, 16], value: 1, active: true },
  { at: [16, 16, 64], value: -1, active: true },
];

test('equality counts active tiles by sign, tile-aware, and agrees with the upstream scan', async () => {
  await withSession(1, (session, sessionRaw) => {
    const load = (nodes: ForeignNode[]) =>
      session.voxelsFromVdb(foreignLevelSet({ voxelSize: 1, background: 3, nodes }));
    const agree = (a: Voxels, b: Voxels, label: string) => {
      const fast = a.equals(b);
      assert.equal(
        fast,
        sessionRaw.Voxels_bIsEqual(session.handle, a.handle, b.handle),
        `${label}: diverged from upstream`,
      );
      return fast;
    };
    const tiles = load(tiled);
    assert.equal(tiles.isInside([19, 19, 19]), true);
    assert.equal(tiles.isInside([43, 19, 19]), false);
    assert.equal(agree(tiles, tiles.clone(), 'clone'), true);
    // The same field with every tile written as a dense leaf of the same value.
    const dense = load(tiled.map((node) => ({ ...node, value: solidLeaf(node.value as number) })));
    assert.equal(agree(tiles, dense, 'tiles vs dense leaves'), true);
    // Dropping the inside tile changes the inside set; dropping the outside one does not.
    assert.equal(agree(tiles, load(tiled.filter((_, i) => i !== 0)), 'without the inside tile'), false);
    assert.equal(agree(tiles, load(tiled.filter((_, i) => i !== 1)), 'without the outside tile'), true);
  });
});

test('equality: a different voxel size is unequal, and a non-positive background takes the upstream scan', async () => {
  await withSession(1, (session, sessionRaw) => {
    const at = (voxelSize: number, background: number, nodes: ForeignNode[] = tiled) =>
      session.voxelsFromVdb(foreignLevelSet({ voxelSize, background, nodes }));
    const slow = (a: Voxels, b: Voxels) => sessionRaw.Voxels_bIsEqual(session.handle, a.handle, b.handle);

    // Identical index-space content; only the transform differs.
    const own = at(1, 3);
    const coarse = at(2, 6);
    assert.equal(own.equals(at(1, 3)), true);
    assert.equal(own.equals(coarse), false);
    assert.equal(slow(own, coarse), false);

    // With background 0, whatever a file leaves out reads 0, which classifies inside: an
    // absent inside tile changes nothing, an absent outside tile turns its region inside.
    // Only the dense scan reproduces that, so the fast path defers to it.
    const zero = at(1, 0);
    const noInsideTile = at(
      1,
      0,
      tiled.filter((_, i) => i !== 0),
    );
    const noOutsideTile = at(
      1,
      0,
      tiled.filter((_, i) => i !== 1),
    );
    assert.equal(zero.equals(noInsideTile), true);
    assert.equal(slow(zero, noInsideTile), true);
    assert.equal(zero.equals(noOutsideTile), false);
    assert.equal(slow(zero, noOutsideTile), false);
  });
});

test('column-culled projectZSlice sees active tiles and equals the vendored export at 1.0 mm', async () => {
  await withSession(1, (session, sessionRaw) => {
    const tiles = session.voxelsFromVdb(foreignLevelSet({ voxelSize: 1, background: 3, nodes: tiled }));
    // The slab spans the two low tiles; the tile at z 64..71 lies above it.
    const fast = tiles.projectZSlice({ startZ: 30, endZ: 0 });
    const reference = tiles.clone();
    sessionRaw.Voxels_ProjectZSlice(session.handle, reference.handle, 30, 0);
    assert.equal(fast.gridHash().hash, reference.gridHash().hash);
    assert.equal(fast.equals(reference), true);
    assert.equal(fast.isInside([19, 19, 2]), true, 'the inside tile projected down to endZ');
  });
});

test('maskedByImplicit keeps an active tile in its support: callback and tape agree', async () => {
  await withSession(1, (session) => {
    const tiles = session.voxelsFromVdb(foreignLevelSet({ voxelSize: 1, background: 3, nodes: tiled }));
    // An SDF inside everywhere: the intersection is the target's inside set, provided the
    // fresh render covers the tile columns (a skipped column reads +background and drops it).
    const viaCallback = tiles.maskedByImplicit({ sdf: () => -10 });
    const viaTape = tiles.maskedByImplicit({ sdf: -10 });
    assert.equal(viaCallback.equals(tiles), true);
    assert.equal(viaTape.equals(tiles), true);
    assert.equal(viaTape.gridHash().hash, viaCallback.gridHash().hash);
    assert.equal(viaTape.isInside([19, 19, 19]), true);
  });
});

test('tube lattices on a band that is not a whole number of voxels fall back to the serial render', async () => {
  await withSession(1, (session, sessionRaw) => {
    // round(2.5 / 1.0) = 3 voxels, and 3 x 1.0 != 2.5: the complex cannot match this band.
    const field = session.voxelsFromVdb(foreignLevelSet({ voxelSize: 1, background: 2.5 }));
    const lattice = session.createLattice();
    lattice.addSphere({ center: [0, 0, 0], radius: 4 });
    lattice.addBeam({ start: [0, 0, 0], end: [12, 0, 0], radius: 2 });
    const tubes = field.withLattice(lattice);
    const serial = field.clone();
    sessionRaw.Voxels_RenderLattice(session.handle, serial.handle, lattice.handle);
    assert.equal(tubes.isEmpty, false);
    assert.equal(tubes.gridHash().hash, serial.gridHash().hash);
    assert.equal(tubes.equals(serial), true);
  });
});

// ── Empty inputs and bulk-buffer guards ──

test('closest-point batch on an empty field reports nothing found and writes no points', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  const queries = heapCopy('f32', [1, 2, 3, 4, 5, 6]);
  const points = heapCopy('f32', [7, 7, 7, 7, 7, 7]);
  const found = pk.module._malloc(2);
  pk.module.HEAPU8.fill(0xff, found, found + 2);
  try {
    assert.equal(raw.Voxels_ClosestPointBatch(pk.handle, empty.handle, queries, 2, points, found), 0);
    assert.deepEqual([...pk.module.HEAPU8.subarray(found, found + 2)], [0, 0]);
    assert.deepEqual([...pk.module.HEAPF32.subarray(points >>> 2, (points >>> 2) + 6)], [7, 7, 7, 7, 7, 7]);
  } finally {
    for (const pointer of [queries, points, found]) pk.module._free(pointer);
  }
});

test('Mesh_GetTriangles writes nothing for a null buffer or a non-positive count', () => {
  const mesh = pk.createVoxels({ shape: 'sphere', radius: 2 }).toMesh();
  const count = mesh.triangleCount;
  assert.ok(count > 0);
  const buffer = pk.module._malloc(count * 12);
  pk.module.HEAPU32.fill(0xdeadbeef, buffer >>> 2, (buffer >>> 2) + count * 3);
  try {
    assert.equal(raw.Mesh_GetTriangles(pk.handle, mesh.handle, 0, count), 0);
    assert.equal(raw.Mesh_GetTriangles(pk.handle, mesh.handle, buffer, 0), 0);
    assert.equal(raw.Mesh_GetTriangles(pk.handle, mesh.handle, buffer, -1), 0);
    assert.equal(pk.module.HEAPU32[buffer >>> 2], 0xdeadbeef, 'a guarded call wrote into the buffer');
    assert.equal(raw.Mesh_GetTriangles(pk.handle, mesh.handle, buffer, count), count);
    assert.deepEqual(
      Array.from(pk.module.HEAPU32.subarray(buffer >>> 2, (buffer >>> 2) + count * 3)),
      Array.from(mesh.triangles),
    );
  } finally {
    pk.module._free(buffer);
  }
});

test('maskedByImplicit(callback) on an empty field stays empty without evaluating the SDF', () => {
  let calls = 0;
  const masked = pk.createVoxels({ shape: 'empty' }).maskedByImplicit({
    sdf: () => {
      calls++;
      return -1;
    },
  });
  assert.equal(masked.isEmpty, true);
  assert.equal(calls, 0);
});
