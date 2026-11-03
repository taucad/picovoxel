// The tape operations the browser host's IL lift emits (`dotnet/managed/SdfIlTape.cs`): float
// rounding, the three comparisons, select, and the checked render and intersect entries that
// abandon a fill when a sample is nonfinite.
//
// The npm expression compiler never emits these, so `src/tape.ts`'s own pins stay as they were.
// They are driven here through the raw ABI, against a JS twin that evaluates the same tape in
// doubles the way `dEvalOne` does: the grid hash includes every active value, so an interval
// rule that prunes a block it must not, or a lane of the f64x2 evaluator that differs from the
// scalar one, moves the hash.
import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bindPicoRaw, type PicoRaw } from '../src/raw.ts';
import { createPico, type Pico, type Voxels } from '../src/index.ts';

let pk: Pico;
let raw: PicoRaw;

beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
  raw = bindPicoRaw(pk.module);
});
afterAll(() => pk.dispose());

// Opcodes, mirrored from src/pico-tape.cpp. Renumbering one must fail here.
const OP = {
  const: 0,
  x: 1,
  y: 2,
  z: 3,
  add: 4,
  sub: 5,
  mul: 6,
  div: 7,
  sqrt: 10,
  sin: 11,
  min: 15,
  max: 16,
  f32: 20,
  lt: 21,
  le: 22,
  eq: 23,
  select: 24,
  pair: 25,
} as const;

/** One SSA instruction: [op, a | (b << 16)]. */
const word = (op: number, a = 0, b = 0): [number, number] => [op, a | (b << 16)];

interface Tape {
  words: number[];
  constants: number[];
}

/** Builds a tape, returning the register of each emitted instruction. */
class Build {
  readonly words: number[] = [];
  readonly constants: number[] = [];
  private readonly pool = new Map<number, number>();

  emit(op: number, a = 0, b = 0): number {
    const register = this.words.length / 2;
    this.words.push(...word(op, a, b));
    return register;
  }

  constant(value: number): number {
    const existing = this.pool.get(value);
    if (existing !== undefined) return existing;
    const index = this.constants.length;
    this.constants.push(value);
    const register = this.emit(OP.const, index);
    this.pool.set(value, register);
    return register;
  }

  select(condition: number, whenTrue: number, whenFalse: number): number {
    return this.emit(OP.select, condition, this.emit(OP.pair, whenTrue, whenFalse));
  }

  get tape(): Tape {
    return { words: this.words, constants: this.constants };
  }
}

/** Evaluates a tape in doubles exactly as dEvalOne does, rounding the last register to float once. */
function evaluate(tape: Tape, x: number, y: number, z: number): number {
  const count = tape.words.length / 2;
  const r = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const op = tape.words[2 * i]!;
    const operands = tape.words[2 * i + 1]!;
    const a = operands & 0xffff;
    const b = operands >>> 16;
    switch (op) {
      case OP.const:
        r[i] = tape.constants[a]!;
        break;
      case OP.x:
        r[i] = x;
        break;
      case OP.y:
        r[i] = y;
        break;
      case OP.z:
        r[i] = z;
        break;
      case OP.add:
        r[i] = r[a]! + r[b]!;
        break;
      case OP.sub:
        r[i] = r[a]! - r[b]!;
        break;
      case OP.mul:
        r[i] = r[a]! * r[b]!;
        break;
      case OP.div:
        r[i] = r[a]! / r[b]!;
        break;
      case OP.sqrt:
        r[i] = Math.sqrt(r[a]!);
        break;
      case OP.sin:
        r[i] = Math.sin(r[a]!);
        break;
      // std::min/max: the first operand on an unordered or equal comparison.
      case OP.min:
        r[i] = r[b]! < r[a]! ? r[b]! : r[a]!;
        break;
      case OP.max:
        r[i] = r[a]! < r[b]! ? r[b]! : r[a]!;
        break;
      case OP.f32:
        r[i] = Math.fround(r[a]!);
        break;
      case OP.lt:
        r[i] = r[a]! < r[b]! ? 1 : 0;
        break;
      case OP.le:
        r[i] = r[a]! <= r[b]! ? 1 : 0;
        break;
      case OP.eq:
        r[i] = r[a]! === r[b]! ? 1 : 0;
        break;
      case OP.select: {
        const pair = tape.words[2 * b + 1]!;
        r[i] = r[a]! !== 0 ? r[pair & 0xffff]! : r[pair >>> 16]!;
        break;
      }
      case OP.pair:
        r[i] = 0;
        break;
      default:
        throw new Error(`unknown opcode ${op}`);
    }
  }
  return Math.fround(r[count - 1]!);
}

const BOUNDS = [-6, -6, -6, 6, 6, 6] as const;

/** Copies the tape and a bounds box into wasm memory for one call, then frees them. */
function withTape<T>(
  tape: Tape,
  body: (pointers: { instructions: number; constants: number; bounds: number }) => T,
): T {
  const instructions = pk.module._malloc(Math.max(tape.words.length, 1) * 4);
  pk.module.HEAPU32.set(tape.words, instructions >>> 2);
  const constants = pk.module._malloc(Math.max(tape.constants.length, 1) * 8);
  pk.module.HEAPF64.set(tape.constants, constants >>> 3);
  const bounds = pk.module._malloc(24);
  pk.module.HEAPF32.set(BOUNDS, bounds >>> 2);
  try {
    return body({ instructions, constants, bounds });
  } finally {
    for (const pointer of [instructions, constants, bounds]) pk.module._free(pointer);
  }
}

/** Renders a tape into a fresh field; `checked` selects the entry the IL lift uses. */
function render(tape: Tape, options: { checked?: boolean } = {}): { voxels: Voxels; status: number } {
  const voxels = pk.createVoxels({ shape: 'empty' });
  const status = withTape(tape, ({ instructions, constants, bounds }) => {
    const count = tape.words.length / 2;
    const pool = tape.constants.length;
    if (options.checked) {
      return raw.Voxels_RenderImplicitTapeChecked(
        pk.handle,
        voxels.handle,
        bounds,
        instructions,
        count,
        constants,
        pool,
      );
    }
    raw.Voxels_RenderImplicitTape(pk.handle, voxels.handle, bounds, instructions, count, constants, pool);
    return 0;
  });
  return { voxels, status };
}

/** Renders the same field through the JS callback, which is the oracle for every tape below. */
function renderTwin(tape: Tape): Voxels {
  return pk.createVoxels({
    shape: 'implicit',
    boundsMin: [BOUNDS[0], BOUNDS[1], BOUNDS[2]],
    boundsMax: [BOUNDS[3], BOUNDS[4], BOUNDS[5]],
    sdf: (x: number, y: number, z: number): number => evaluate(tape, x, y, z),
  });
}

function expectSameAsCallback(tape: Tape, label: string): void {
  const { voxels } = render(tape);
  const twin = renderTwin(tape);
  assert.equal(
    voxels.gridHash().hash,
    twin.gridHash().hash,
    `${label}: the tape fill differs from the callback fill`,
  );
  assert.equal(voxels.equals(twin), true, `${label}: the fields are not equal`);
}

test('F32 rounds each sample to float, in the scalar and the vector evaluator', () => {
  // f32(sin(x * 7) * 1e-7) is a value whose double and float forms differ at nearly every sample,
  // added to a sphere so the result crosses the band. The second term mixes z with x, which is what
  // reaches the f64x2 evaluator; the first is z-only, which is cached per layer.
  const b = new Build();
  const x = b.emit(OP.x);
  const y = b.emit(OP.y);
  const z = b.emit(OP.z);
  const radius = b.constant(4);
  const tiny = b.constant(1e-7);
  const seven = b.constant(7);
  const squared = b.emit(
    OP.add,
    b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
    b.emit(OP.mul, z, z),
  );
  const sphere = b.emit(OP.sub, b.emit(OP.sqrt, squared), radius);
  const zOnly = b.emit(OP.f32, b.emit(OP.mul, b.emit(OP.sin, b.emit(OP.mul, z, seven)), tiny));
  const mixed = b.emit(OP.f32, b.emit(OP.mul, b.emit(OP.mul, x, z), tiny));
  b.emit(OP.f32, b.emit(OP.add, b.emit(OP.add, sphere, zOnly), mixed));
  expectSameAsCallback(b.tape, 'F32');
});

test('LT, LE and EQ produce 0 or 1 and gate a SELECT, decided and undecided', () => {
  // Three selects: one the interval pass decides for whole blocks (x < 0 away from the plane), one it
  // cannot (|sin| against a constant), and one on equality, which is decided only where the operand
  // intervals cannot overlap.
  const b = new Build();
  const x = b.emit(OP.x);
  const y = b.emit(OP.y);
  const z = b.emit(OP.z);
  const zero = b.constant(0);
  const half = b.constant(0.5);
  const inner = b.constant(2);
  const outer = b.constant(4.5);
  const squared = b.emit(
    OP.add,
    b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
    b.emit(OP.mul, z, z),
  );
  const distance = b.emit(OP.sqrt, squared);
  const byHalfSpace = b.select(
    b.emit(OP.lt, x, zero),
    b.emit(OP.sub, distance, inner),
    b.emit(OP.sub, distance, outer),
  );
  const wave = b.emit(OP.sin, b.emit(OP.mul, b.emit(OP.add, x, z), b.constant(3)));
  const byWave = b.select(b.emit(OP.le, wave, half), byHalfSpace, b.emit(OP.add, byHalfSpace, half));
  const byEquality = b.select(b.emit(OP.eq, y, zero), b.emit(OP.sub, byWave, b.constant(0.25)), byWave);
  b.emit(OP.f32, byEquality);
  expectSameAsCallback(b.tape, 'comparisons and selects');
});

test('a SELECT whose operands are NaN or infinite is not pruned away', () => {
  // The taken arm is finite, but both arms are evaluated in interval arithmetic: an arm that can be
  // NaN (sqrt of a negative) or infinite (1/0) must block the block's classification, so the dense
  // loop runs where it would otherwise have been skipped.
  const b = new Build();
  const x = b.emit(OP.x);
  const y = b.emit(OP.y);
  const z = b.emit(OP.z);
  const zero = b.constant(0);
  const one = b.constant(1);
  const squared = b.emit(
    OP.add,
    b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
    b.emit(OP.mul, z, z),
  );
  const sphere = b.emit(OP.sub, b.emit(OP.sqrt, squared), b.constant(3));
  const nan = b.emit(OP.sqrt, b.emit(OP.sub, zero, b.emit(OP.mul, x, x)));
  const infinite = b.emit(OP.div, one, zero);
  const withNan = b.select(b.emit(OP.lt, x, b.constant(-1000)), nan, sphere);
  b.emit(OP.f32, b.select(b.emit(OP.lt, y, b.constant(-1000)), infinite, withNan));
  expectSameAsCallback(b.tape, 'nonfinite select arms');
});

test('a tape that is NaN over part of the box renders those samples, like the callback', () => {
  // sqrt(x) is NaN for x < 0, and a NaN sample is an ACTIVE voxel upstream. The select keeps it on a
  // reachable path, so it must survive the interval pass and the dense loop.
  const b = new Build();
  const x = b.emit(OP.x);
  const y = b.emit(OP.y);
  const sqrtX = b.emit(OP.sqrt, x);
  b.emit(OP.f32, b.select(b.emit(OP.lt, y, b.constant(3)), b.emit(OP.sub, sqrtX, b.constant(1)), sqrtX));
  expectSameAsCallback(b.tape, 'a NaN region behind a select');
});

test('the checked render renders a finite tape exactly as the plain one, and refuses a nonfinite sample', () => {
  const finite = new Build();
  {
    const b = finite;
    const x = b.emit(OP.x);
    const y = b.emit(OP.y);
    const z = b.emit(OP.z);
    const squared = b.emit(
      OP.add,
      b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
      b.emit(OP.mul, z, z),
    );
    b.emit(OP.f32, b.emit(OP.sub, b.emit(OP.sqrt, squared), b.constant(3)));
  }
  const plain = render(finite.tape);
  const checked = render(finite.tape, { checked: true });
  expect(checked.status).toBe(0);
  expect(checked.voxels.gridHash().hash).toBe(plain.voxels.gridHash().hash);
  expect(checked.voxels.isEmpty).toBe(false);

  // A trap, as the lift encodes one: select(condition, 0/0, value). The condition holds for part of
  // the box, so the render is abandoned and the target is left untouched.
  const trapped = new Build();
  {
    const b = trapped;
    const x = b.emit(OP.x);
    const y = b.emit(OP.y);
    const z = b.emit(OP.z);
    const zero = b.constant(0);
    const squared = b.emit(
      OP.add,
      b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
      b.emit(OP.mul, z, z),
    );
    const sphere = b.emit(OP.sub, b.emit(OP.sqrt, squared), b.constant(3));
    const nan = b.emit(OP.div, zero, zero);
    b.emit(OP.f32, b.select(b.emit(OP.lt, b.constant(2), x), nan, sphere));
  }
  const abandoned = render(trapped.tape, { checked: true });
  expect(abandoned.status).toBe(1);
  expect(abandoned.voxels.isEmpty).toBe(true);

  // The plain entry renders the same tape, NaN voxels and all: the checked entry is the only one
  // that refuses, which is what lets the callback path reproduce the author's exception.
  const kept = render(trapped.tape);
  expect(kept.voxels.isEmpty).toBe(false);
});

test('the checked intersect applies a finite mask and leaves the target untouched on a nonfinite one', () => {
  const inside = new Build();
  inside.constant(-10);
  const nonfinite = new Build();
  {
    const b = nonfinite;
    const zero = b.constant(0);
    const x = b.emit(OP.x);
    b.emit(OP.f32, b.select(b.emit(OP.lt, b.constant(1), x), b.emit(OP.div, zero, zero), b.constant(-10)));
  }
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 3 });
  const hash = sphere.gridHash().hash;

  const masked = sphere.clone();
  const applied = withTape(inside.tape, ({ instructions, constants }) =>
    raw.Voxels_IntersectImplicitTapeChecked(pk.handle, masked.handle, instructions, 1, constants, 1),
  );
  expect(applied).toBe(0);
  expect(masked.equals(sphere)).toBe(true);

  const refused = sphere.clone();
  const status = withTape(nonfinite.tape, ({ instructions, constants }) =>
    raw.Voxels_IntersectImplicitTapeChecked(
      pk.handle,
      refused.handle,
      instructions,
      nonfinite.words.length / 2,
      constants,
      nonfinite.constants.length,
    ),
  );
  expect(status).toBe(1);
  expect(refused.gridHash().hash).toBe(hash);
});

test('Tape_EvaluatePoints returns the fill’s own value at each point, and validates its input', () => {
  const b = new Build();
  const x = b.emit(OP.x);
  const y = b.emit(OP.y);
  const z = b.emit(OP.z);
  const squared = b.emit(
    OP.add,
    b.emit(OP.add, b.emit(OP.mul, x, x), b.emit(OP.mul, y, y)),
    b.emit(OP.mul, z, z),
  );
  b.emit(OP.f32, b.emit(OP.sub, b.emit(OP.sqrt, squared), b.constant(3)));
  const tape = b.tape;

  const points = [0, 0, 0, 1.5, -2.25, 0.5, -6, 6, 6, 1e-20, 0, 0];
  const count = points.length / 3;
  const pointer = pk.module._malloc(points.length * 4);
  pk.module.HEAPF32.set(points, pointer >>> 2);
  const values = pk.module._malloc(count * 4);
  try {
    withTape(tape, ({ instructions, constants }) =>
      raw.Tape_EvaluatePoints(
        instructions,
        tape.words.length / 2,
        constants,
        tape.constants.length,
        pointer,
        count,
        values,
      ),
    );
    for (let index = 0; index < count; index++) {
      // The points are read back from the heap, so the comparison uses the float32 the call saw.
      const px = pk.module.HEAPF32[(pointer >>> 2) + 3 * index]!;
      const py = pk.module.HEAPF32[(pointer >>> 2) + 3 * index + 1]!;
      const pz = pk.module.HEAPF32[(pointer >>> 2) + 3 * index + 2]!;
      expect(pk.module.HEAPF32[(values >>> 2) + index]).toBe(evaluate(tape, px, py, pz));
    }
    // A malformed tape is rejected before anything is written, as the render entries reject one.
    expect(() =>
      withTape({ words: [...word(OP.x), ...word(26, 0)], constants: [] }, ({ instructions, constants }) =>
        raw.Tape_EvaluatePoints(instructions, 2, constants, 0, pointer, count, values),
      ),
    ).toThrow();
  } finally {
    pk.module._free(pointer);
    pk.module._free(values);
  }
});
