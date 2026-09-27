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
import { createPico, PicoError, type SdfExpression, type Voxels } from '../src/index.ts';
import { compileSdfExpression } from '../src/tape.ts';
import { gyroidExpression, gyroidFunction } from './helpers.ts';

// ── encoding ──

test('leaves and unary/binary ops encode to the pinned opcode words', () => {
  // sin(x) - 0.4  →  X, SIN, CONST, SUB
  const tape = compileSdfExpression(['-', ['sin', 'x'], 0.4]);
  expect(Array.from(tape.instructions)).toEqual([
    1,
    0, // 0: X
    11,
    0, // 1: SIN a=0
    0,
    0, // 2: CONST #0
    5,
    1 | (2 << 16), // 3: SUB a=1 b=2
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

const compileError = (expression: unknown): PicoError => {
  try {
    compileSdfExpression(expression as SdfExpression);
  } catch (error) {
    expect(error).toBeInstanceOf(PicoError);
    return error as PicoError;
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

test('tape gyroid is exactly the JS-callback gyroid: volume, counts, STL bytes', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
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
    [
      'max',
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
  const pk = await createPico({ voxelSize: 0.5 });
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
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -6] as const, boundsMax: [12, 12, 6] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: twin });
    expect(fromTape.volume).toBe(fromCallback.volume);
    expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(
      true,
    );
  } finally {
    pk.dispose();
  }
});

test('a constant-free expression renders (empty constant pool marshals)', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
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
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const sphereExpression: SdfExpression = [
      '-',
      ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]],
      10.5,
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
  for (const i of [-1, 1])
    for (const j of [-1, 1]) for (const k of [-1, 1]) centers.push([i * 5, j * 5, k * 5]);
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
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-10, -10, -10] as const, boundsMax: [10, 10, 10] as const };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: twin });
    expect(fromTape.volume).toBe(fromCallback.volume);
    expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(
      true,
    );
  } finally {
    pk.dispose();
  }
});

test('a NaN-producing domain is never pruned: sqrt(x)-1 matches its JS twin', async () => {
  // For x < 0 the SDF is NaN, which upstream stores as ACTIVE voxels — the
  // interval evaluator must flag the possibility and refuse to classify those
  // blocks, falling back to the dense loop.
  const pk = await createPico({ voxelSize: 0.5 });
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

// ── R9: compose-into-existing tape variants ≡ their serial callback twins ──
//
// Identity here is SEMANTIC: upstream's own Voxels_bIsEqual, the mesh-roundtrip
// properties() volume, and STL bytes. The raw fast `.volume` approximation is
// deliberately NOT compared across paths — it integrates representation
// bookkeeping (allocated-inactive values the serial dense loop and csg
// node-stealing leave behind, which the pruned fill legitimately omits), the
// same reason it is documented "approximate after booleans".

test('withImplicit(expression) composes into NON-empty voxels exactly like the callback', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const base = pk.createVoxels({ shape: 'sphere', center: [10, 0, 0], radius: 6 });
    const fromTape = base.withImplicit({ ...bounds, sdf: gyroidExpression });
    const fromCallback = base.withImplicit({ ...bounds, sdf: gyroidFunction });
    expect(fromTape.isEmpty).toBe(false);
    expect(fromTape.equals(fromCallback)).toBe(true);
    expect(fromTape.properties().volume).toBe(fromCallback.properties().volume);
    expect(Buffer.from(fromTape.toMesh().toStl()).equals(Buffer.from(fromCallback.toMesh().toStl()))).toBe(
      true,
    );
    // And the compose genuinely united: more material than either input alone.
    expect(fromTape.properties().volume).toBeGreaterThan(base.properties().volume);
  } finally {
    pk.dispose();
  }
});

test('withImplicit(expression) on EMPTY voxels equals the fresh-grid tape fill', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const composed = pk.createVoxels({ shape: 'empty' }).withImplicit({ ...bounds, sdf: gyroidExpression });
    const fresh = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: gyroidExpression });
    expect(composed.equals(fresh)).toBe(true);
    expect(composed.properties().volume).toBe(fresh.properties().volume);
    expect(Buffer.from(composed.toMesh().toStl()).equals(Buffer.from(fresh.toMesh().toStl()))).toBe(true);
  } finally {
    pk.dispose();
  }
});

test('compose writes solid-interior tiles that csg ops read correctly', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    // A big implicit sphere composed into a small off-center seed: deep inside
    // the big sphere the pruned compose writes -background tiles; intersecting
    // there must recover the probe exactly (a missing tile reads +outside).
    const bounds = { boundsMin: [-12, -12, -12] as const, boundsMax: [12, 12, 12] as const };
    const bigSphere: SdfExpression = [
      '-',
      ['sqrt', ['+', ['pow', 'x', 2], ['pow', 'y', 2], ['pow', 'z', 2]]],
      10.5,
    ];
    const seed = pk.createVoxels({ shape: 'sphere', center: [11, 0, 0], radius: 2 });
    const composed = seed.withImplicit({ ...bounds, sdf: bigSphere });
    const probe = pk.createVoxels({ shape: 'sphere', radius: 3 });
    const core = composed.intersect(probe);
    expect(core.isEmpty).toBe(false);
    expect(core.volume).toBe(probe.volume);
  } finally {
    pk.dispose();
  }
});

test('maskedByImplicit(expression) is exactly the callback gyroid-in-sphere', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
    const fromTape = sphere.maskedByImplicit({ sdf: gyroidExpression });
    const fromCallback = sphere.maskedByImplicit({ sdf: gyroidFunction });
    expect(fromTape.isEmpty).toBe(false);
    expect(fromTape.equals(fromCallback)).toBe(true);
    expect(fromTape.properties().volume).toBe(fromCallback.properties().volume);
    const tapeMesh = fromTape.toMesh();
    const callbackMesh = fromCallback.toMesh();
    expect(tapeMesh.vertexCount).toBe(callbackMesh.vertexCount);
    expect(tapeMesh.triangleCount).toBe(callbackMesh.triangleCount);
    expect(Buffer.from(tapeMesh.toStl()).equals(Buffer.from(callbackMesh.toStl()))).toBe(true);
    // The mask genuinely intersected: strictly less material than the sphere.
    expect(fromTape.properties().volume).toBeLessThan(sphere.properties().volume);
  } finally {
    pk.dispose();
  }
});

test('maskedByImplicit(expression) on empty voxels stays empty', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const empty = pk.createVoxels({ shape: 'empty' });
    expect(empty.maskedByImplicit({ sdf: gyroidExpression }).isEmpty).toBe(true);
  } finally {
    pk.dispose();
  }
});

test('a malformed expression on the compose paths neither renders nor leaks', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
    const before = pk.allocated.voxels;
    expect(() =>
      sphere.withImplicit({
        boundsMin: [-4, -4, -4],
        boundsMax: [4, 4, 4],
        sdf: ['spin', 'x'] as never,
      }),
    ).toThrow(PicoError);
    expect(() => sphere.maskedByImplicit({ sdf: ['spin', 'x'] as never })).toThrow(PicoError);
    expect(pk.allocated.voxels).toBe(before);
  } finally {
    pk.dispose();
  }
});

test('a malformed expression neither renders nor leaks the target voxels', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const before = pk.allocated.voxels;
    expect(() =>
      pk.createVoxels({
        shape: 'implicit',
        boundsMin: [-4, -4, -4],
        boundsMax: [4, 4, 4],
        sdf: ['spin', 'x'] as never,
      }),
    ).toThrow(PicoError);
    expect(pk.allocated.voxels).toBe(before);
  } finally {
    pk.dispose();
  }
});

// ── bounding boxes that clip solid interior ──
//
// When the render box cuts through the SDF's interior deeper than the narrow
// band, -background voxels meet untouched +background with no active band in
// between. The per-voxel definition (upstream's loop, and the tape) keeps that
// cut voxel for voxel. The callback fill's terminal prune once signed each such
// node by its first voxel and flipped whole 8³, 128³ and 4096³ regions: the
// grid hash, volume and triangle count could not see it, but equals() and
// every later boolean could.

const clippedSphere = (
  radius: number,
): { expression: SdfExpression; callback: (x: number, y: number, z: number) => number } => ({
  expression: ['-', ['sqrt', ['+', ['*', 'x', 'x'], ['*', 'y', 'y'], ['*', 'z', 'z']]], radius],
  callback: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - radius,
});

type Vec3 = [number, number, number];
test.each<{ label: string; voxelSize: number; boundsMin: Vec3; boundsMax: Vec3; radius: number }>([
  { label: 'centred box, 0.5 mm', voxelSize: 0.5, boundsMin: [-5, -5, -5], boundsMax: [5, 5, 5], radius: 50 },
  {
    label: 'centred box, 1 mm',
    voxelSize: 1,
    boundsMin: [-20, -20, -20],
    boundsMax: [20, 20, 20],
    radius: 100,
  },
  { label: 'offset box, 0.4 mm', voxelSize: 0.4, boundsMin: [-3, -9, 1], boundsMax: [7, 2, 5], radius: 50 },
  { label: 'one-octant box, 0.3 mm', voxelSize: 0.3, boundsMin: [2, 2, 2], boundsMax: [9, 9, 9], radius: 50 },
  { label: 'small box, 0.25 mm', voxelSize: 0.25, boundsMin: [-2, -2, -2], boundsMax: [2, 2, 2], radius: 30 },
  // Surface on one side of the box, clipped interior on the other: the mesh
  // matches either way, the inside set did not.
  {
    label: 'surface on one side, 0.5 mm',
    voxelSize: 0.5,
    boundsMin: [-4, -4, -4],
    boundsMax: [20, 20, 20],
    radius: 10,
  },
])(
  'a box clipping solid interior renders the same through the callback and the tape ($label)',
  async ({ voxelSize, boundsMin, boundsMax, radius }) => {
    const pk = await createPico({ voxelSize });
    try {
      const { expression, callback } = clippedSphere(radius);
      const bounds = { boundsMin, boundsMax };
      const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
      const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: callback });
      expect(fromCallback.equals(fromTape)).toBe(true);
      expect(fromCallback.gridHash()).toEqual(fromTape.gridHash());

      // The per-voxel definition: the whole box is interior, so each of its
      // corners is inside, and a point two voxels past the band is outside.
      const beyond = 5 * voxelSize;
      for (const [cx, cy, cz] of [0, 1, 2, 3, 4, 5, 6, 7].map((n) => [n & 1, (n >> 1) & 1, (n >> 2) & 1])) {
        const corner: Vec3 = [
          cx ? boundsMax[0] : boundsMin[0],
          cy ? boundsMax[1] : boundsMin[1],
          cz ? boundsMax[2] : boundsMin[2],
        ];
        if (Math.hypot(...corner) >= radius) continue; // the surface side of the last case
        expect(fromCallback.isInside(corner)).toBe(true);
        expect(fromCallback.isInside([corner[0] + (cx ? beyond : -beyond), corner[1], corner[2]])).toBe(
          false,
        );
      }

      // The compose path (min(sdf, existing) into live voxels) prunes the same way.
      const seed = (): Voxels => pk.createVoxels({ shape: 'sphere', radius: 1 });
      expect(
        seed()
          .withImplicit({ ...bounds, sdf: callback })
          .equals(seed().withImplicit({ ...bounds, sdf: expression })),
      ).toBe(true);
    } finally {
      pk.dispose();
    }
  },
);

test('a clipped callback render carves and unions like the tape render', async () => {
  const pk = await createPico({ voxelSize: 0.5 });
  try {
    const { expression, callback } = clippedSphere(50);
    const bounds = { boundsMin: [-5, -5, -5] as Vec3, boundsMax: [5, 5, 5] as Vec3 };
    const fromTape = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: expression });
    const fromCallback = pk.createVoxels({ shape: 'implicit', ...bounds, sdf: callback });
    const cavities = pk
      .createVoxels({ shape: 'sphere', center: [-3, -3, -3], radius: 1.5 })
      .union(pk.createVoxels({ shape: 'sphere', center: [3, 3, 3], radius: 1.5 }));

    // Both cavities sit in solid interior, so carving leaves both behind.
    const carvedTape = fromTape.subtract(cavities);
    const carvedCallback = fromCallback.subtract(cavities);
    expect(carvedCallback.equals(carvedTape)).toBe(true);
    expect(carvedCallback.toMesh().triangleCount).toBe(carvedTape.toMesh().triangleCount);
    expect(carvedCallback.properties().volume).toBe(carvedTape.properties().volume);
    expect(carvedCallback.isInside([-3, -3, -3])).toBe(false);
    expect(carvedCallback.isInside([3, 3, 3])).toBe(false);
    expect(carvedCallback.isInside([0, 0, 0])).toBe(true);

    // And the interior swallows both spheres: the union has no surface at all.
    const joinedCallback = fromCallback.union(cavities);
    expect(joinedCallback.equals(fromTape.union(cavities))).toBe(true);
    expect(joinedCallback.toMesh().triangleCount).toBe(0);
  } finally {
    pk.dispose();
  }
});
