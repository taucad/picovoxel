// TP4 — the SdfExpression → tape compiler and the parallel implicit fill.
//
// Encoding tests pin the exact words the C++ evaluator reads (the two halves
// of the contract are mirrored constants — a renumbered opcode must fail HERE).
// Runtime tests prove the tape path against the JS-callback path on the same
// session: both engines are deterministic software float (V8's fdlibm Math and
// musl-wasm libm), so equality is exact and platform-independent — hex-float
// discipline, no tolerances. The single↔multi bit-identity differential lives
// in multi.test.ts next to the other cross-variant proofs.
import { expect, test } from 'vitest';
import { createPicoGK, PicoGkError, type SdfExpression } from '../src/index.ts';
import { compileSdfExpression } from '../src/tape.ts';

// ── encoding ──

test('leaves and unary/binary ops encode to the pinned opcode words', () => {
  // sin(x) - 0.4  →  X, SIN, CONST, SUB
  const tape = compileSdfExpression(['-', ['sin', 'x'], 0.4]);
  expect(Array.from(tape.instructions)).toEqual([
    1, 0, // 0: X
    11, 0, // 1: SIN a=0
    0, 0, // 2: CONST #0
    5, 1 | (2 << 16), // 3: SUB a=1 b=2
  ]);
  expect(Array.from(tape.constants)).toEqual([0.4]);
});

test('every operator lowers; constants deduplicate', () => {
  const tape = compileSdfExpression([
    'min',
    ['max', ['mod', 'x', 3], ['pow', ['abs', 'y'], 3]],
    ['+', ['exp', ['-', 'z']], ['log', ['sqrt', ['floor', ['/', 'y', 3]]]], ['*', ['cos', 'z'], 3]],
  ]);
  // 3 appears four times but lands in the pool once.
  expect(Array.from(tape.constants)).toEqual([3]);
  const ops = Array.from(tape.instructions).filter((_, i) => i % 2 === 0);
  // Every opcode family is present: const/x/y/z, add,div,neg,abs,sqrt,cos,
  // floor,mod,min,max,pow,exp,log, mul.
  for (const op of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19]) {
    expect(ops).toContain(op);
  }
});

test("variadic '+' left-folds; '-' is unary or binary", () => {
  const sum = compileSdfExpression(['+', 'x', 'y', 'z']);
  // X, Y, ADD, Z, ADD — 5 instructions, result is the last.
  expect(sum.instructions.length / 2).toBe(5);
  const negation = compileSdfExpression(['-', 'x']);
  expect(Array.from(negation.instructions)).toEqual([1, 0, 8, 0]);
});

// ── compiler error paths ──

const compileError = (expression: unknown): PicoGkError => {
  try {
    compileSdfExpression(expression as SdfExpression);
  } catch (error) {
    expect(error).toBeInstanceOf(PicoGkError);
    return error as PicoGkError;
  }
  throw new Error('expected compileSdfExpression to throw');
};

test('compiler rejects malformed expressions with actionable errors', () => {
  expect(compileError(['spin', 'x']).message).toContain("unknown operator 'spin'");
  expect(compileError(['abs', 'x', 'y']).message).toContain("'abs' takes 1 operand");
  expect(compileError(['mod', 'x']).message).toContain("'mod' takes 2 operands");
  expect(compileError(['min', 'x']).message).toContain("'min' takes 2+ operands");
  expect(compileError(['-', 'x', 'y', 'z']).message).toContain("'-' takes 1 or 2 operands");
  expect(compileError(Number.NaN).message).toContain('non-finite constant');
  expect(compileError('w').message).toContain('unrecognised node');
  expect(compileError([]).message).toContain('unrecognised node');
  expect(compileError({ op: 'add' }).message).toContain('unrecognised node');
});

test('compiler enforces the u16 instruction ceiling', () => {
  // n leaves + (n-1) folds; 33000 operands crosses 65536 instructions.
  const operands = Array.from({ length: 33000 }, () => 'x' as const);
  expect(() => compileSdfExpression(['+', ...operands])).toThrow(/more than 65536 operations/);
});

// ── runtime: tape ≡ JS callback on the same session ──

const GYROID_SCALE = (2 * Math.PI) / 10;
export const gyroidExpression: SdfExpression = [
  '-',
  ['abs', ['+',
    ['*', ['sin', ['*', 'x', GYROID_SCALE]], ['cos', ['*', 'y', GYROID_SCALE]]],
    ['*', ['sin', ['*', 'y', GYROID_SCALE]], ['cos', ['*', 'z', GYROID_SCALE]]],
    ['*', ['sin', ['*', 'z', GYROID_SCALE]], ['cos', ['*', 'x', GYROID_SCALE]]],
  ]],
  0.4,
];
export const gyroidFunction = (x: number, y: number, z: number): number =>
  Math.abs(
    Math.sin(x * GYROID_SCALE) * Math.cos(y * GYROID_SCALE) +
      Math.sin(y * GYROID_SCALE) * Math.cos(z * GYROID_SCALE) +
      Math.sin(z * GYROID_SCALE) * Math.cos(x * GYROID_SCALE),
  ) - 0.4;

test('tape gyroid is exactly the JS-callback gyroid: volume, counts, STL bytes', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: gyroidExpression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: gyroidFunction });
    expect(fromTape.volume).toBe(fromCallback.volume);
    const tapeMesh = fromTape.toMesh();
    const callbackMesh = fromCallback.toMesh();
    expect(tapeMesh.vertexCount).toBe(callbackMesh.vertexCount);
    expect(tapeMesh.triangleCount).toBe(callbackMesh.triangleCount);
    expect(Buffer.from(tapeMesh.toStl()).equals(Buffer.from(callbackMesh.toStl()))).toBe(true);
  } finally {
    pk.dispose();
  }
});

test('an all-operator expression matches its JS twin exactly', async () => {
  const expression: SdfExpression = [
    'min',
    ['-', ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]], 6],
    ['max',
      ['-', ['abs', ['mod', 'x', 3]], 1],
      ['*', ['floor', ['/', 'y', 4]], ['exp', ['-', ['log', ['+', ['abs', 'z'], 1]]]]],
    ],
  ];
  const twin = (x: number, y: number, z: number): number =>
    Math.min(
      Math.sqrt(x ** 2 + y ** 2 + z ** 2) - 6,
      Math.max(
        Math.abs(x - 3 * Math.floor(x / 3)) - 1,
        Math.floor(y / 4) * Math.exp(-Math.log(Math.abs(z) + 1)),
      ),
    );
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-8, -8, -8] as const, boundsMax: [8, 8, 8] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: twin });
    expect(fromTape.volume).toBe(fromCallback.volume);
    expect(fromTape.toMesh().triangleCount).toBe(fromCallback.toMesh().triangleCount);
  } finally {
    pk.dispose();
  }
});

test('a z-independent expression matches its JS twin exactly (TP7a: result register hoists out of the voxel loop)', async () => {
  // Infinite cylinder sqrt(x²+y²)−8: the whole tape is x/y-only, so the
  // leveled evaluator computes the result register once per (x,y) row and the
  // per-voxel level list is EMPTY — the value must still reach every voxel.
  const expression: SdfExpression = ['-', ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2]]], 8];
  const twin = (x: number, y: number, _z: number): number => Math.sqrt(x ** 2 + y ** 2) - 8;
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -6] as const, boundsMax: [12, 12, 6] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: twin });
    expect(fromTape.volume).toBe(fromCallback.volume);
    expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(true);
  } finally {
    pk.dispose();
  }
});

test('a constant-free expression renders (empty constant pool marshals)', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    // x+y+z = 0 plane through the box — no constants anywhere in the tape.
    const plane = pk.createVoxels({
      shape: 'implicit',
      boundsMin: [-4, -4, -4],
      boundsMax: [4, 4, 4],
      sdf: ['+', 'x', 'y', 'z'],
    });
    expect(plane.volume).toBeGreaterThan(0);
  } finally {
    pk.dispose();
  }
});

// ── runtime: TP6 interval pruning must be invisible ──
//
// The fill classifies leaf-aligned blocks with conservative interval
// arithmetic: proven-outside blocks are skipped, proven-interior leaves become
// -background tiles, ambiguous blocks run a branch-shortened tape. All of it
// must be unobservable next to the dense JS-callback path — same active
// voxels, same values, same csg behaviour.

test('pruned interior keeps its sign through csg: tape sphere ∩ inner sphere ≡ callback sphere ∩ inner sphere', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const sphereExpression: SdfExpression = [
      '-', ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]], 10.5,
    ];
    const sphereFunction = (x: number, y: number, z: number): number =>
      Math.sqrt(x ** 2 + y ** 2 + z ** 2) - 10.5;
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: sphereExpression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: sphereFunction });
    expect(fromTape.volume).toBe(fromCallback.volume);

    // The inner sphere sits entirely inside the big one — in the region the
    // pruned fill covers with -background tiles instead of dense inactive
    // leaves. csgIntersection reads the interior SIGN there: were a tile
    // missing (background reads as +outside), this intersection would come
    // back empty.
    const inner = pk.createVoxels({ shape: 'sphere', radius: 4 });
    const tapeCore = fromTape.intersect(inner);
    const callbackCore = fromCallback.intersect(inner);
    expect(tapeCore.isEmpty).toBe(false);
    expect(tapeCore.volume).toBe(callbackCore.volume);
    // Deep inside, max(-background, inner) = inner: the core IS the inner sphere.
    expect(tapeCore.volume).toBe(inner.volume);
  } finally {
    pk.dispose();
  }
});

test('a min-fold sphere lattice matches its JS twin exactly (decided branches shorten the tape)', async () => {
  const centers: [number, number, number][] = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) centers.push([i * 5, j * 5, k * 5]);
  const expression: SdfExpression = [
    'min',
    ...centers.map(
      ([cx, cy, cz]): SdfExpression => [
        '-',
        ['sqrt', ['+', ['pow', ['-', 'x', cx], 2], ['pow', ['-', 'y', cy], 2], ['pow', ['-', 'z', cz], 2]]],
        3,
      ],
    ),
  ];
  // Math.min(...) reduces left-to-right — value-identical to the compiler's
  // left fold (no NaNs here, and x−x is always +0, so no -0 ties either).
  const twin = (x: number, y: number, z: number): number =>
    Math.min(...centers.map(([cx, cy, cz]) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - 3));
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-10, -10, -10] as const, boundsMax: [10, 10, 10] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: twin });
    expect(fromTape.volume).toBe(fromCallback.volume);
    expect(
      Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl())),
    ).toBe(true);
  } finally {
    pk.dispose();
  }
});

test('a NaN-producing domain is never pruned: sqrt(x)-1 matches its JS twin', async () => {
  // For x < 0 the SDF is NaN, which upstream stores as ACTIVE voxels — the
  // interval evaluator must flag the possibility and refuse to classify those
  // blocks, falling back to the dense loop.
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-6, -6, -6] as const, boundsMax: [6, 6, 6] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: ['-', ['sqrt', 'x'], 1] });
    const fromCallback = pk.createVoxels({
      shape: 'implicit',
      ...bounds,
      sdf: (x: number): number => Math.sqrt(x) - 1,
    });
    // volume may legitimately be NaN here; toBe (Object.is) treats NaN === NaN.
    expect(fromTape.volume).toBe(fromCallback.volume);
  } finally {
    pk.dispose();
  }
});

test('withImplicit stays function-only — expressions are for createVoxels', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
    // The tape fill requires a fresh empty target, so the derive-style implicit
    // methods only take callbacks; a non-function hits the trampoline guard.
    expect(() =>
      sphere.withImplicit({
        boundsMin: [-4, -4, -4],
        boundsMax: [4, 4, 4],
        sdf: gyroidExpression as never,
      }),
    ).toThrow(/must be a function/);
  } finally {
    pk.dispose();
  }
});

test('a malformed expression neither renders nor leaks the target voxels', async () => {
  const pk = await createPicoGK({ voxelSize: 0.5 });
  try {
    const before = pk.allocated.voxels;
    expect(() =>
      pk.createVoxels({
        shape: 'implicit',
        boundsMin: [-4, -4, -4],
        boundsMax: [4, 4, 4],
        sdf: ['spin', 'x'] as never,
      }),
    ).toThrow(PicoGkError);
    expect(pk.allocated.voxels).toBe(before);
  } finally {
    pk.dispose();
  }
});
