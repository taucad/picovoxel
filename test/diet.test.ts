// Disposing intermediates: `{ consume: true }` on the boolean and offset
// families, and `pico.scope()`. Each consuming call must return the bytes of
// its pure twin while leaving one fewer grid alive; a scope must free exactly
// what its callback created and did not return.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, expectTypeOf, test } from 'vitest';
import {
  createPico,
  PicoError,
  type ConsumeOptions,
  type Mesh,
  type OffsetOptions,
  type Pico,
  type Voxels,
} from '../src/index.ts';
import { bindPicoRaw } from '../src/raw.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.4 });
});
afterAll(() => pk.dispose());

const sphere = (radius: number, center: [number, number, number] = [0, 0, 0]) =>
  pk.createVoxels({ shape: 'sphere', radius, center });

const disposedError = (error: unknown) => error instanceof PicoError && error.code === 'PICO_DISPOSED';

test('consuming offsets reuse the receiver grid and match the pure result', async () => {
  const fast = await createPico({ voxelSize: 0.4, lane: 'fast' });
  try {
    for (const session of [pk, fast]) {
      const runs: [string, (v: Voxels, consume: boolean) => Voxels][] = [
        ['offset', (v, consume) => v.offset({ distance: 1.2, consume })],
        ['offset fastSweeping', (v, consume) => v.offset({ distance: -0.8, fastSweeping: true, consume })],
        ['doubleOffset', (v, consume) => v.doubleOffset({ first: 1, second: -1.5, consume })],
        ['smoothen', (v, consume) => v.smoothen({ distance: 0.8, consume })],
        ['fillet', (v, consume) => v.fillet({ rounding: 1, consume })],
        ['shell', (v, consume) => v.shell({ offset: -1, consume })],
        ['shell two-offset', (v, consume) => v.shell({ inner: -1, outer: 0.5, consume })],
      ];
      for (const [name, run] of runs) {
        const source = session.createVoxels({ shape: 'sphere', radius: 6 });
        const pure = run(source, false);
        const copy = source.clone();
        const before = session.allocated.voxels;
        const consumed = run(copy, true);
        assert.equal(consumed.gridHash().hash, pure.gridHash().hash, `${name}: the pure call's grid`);
        assert.equal(consumed.lane, pure.lane, `${name}: the pure call's lane`);
        assert.ok(session.allocated.voxels <= before, `${name}: no grid is added`);
        assert.throws(() => copy.volume, disposedError, `${name}: the receiver is disposed`);
        copy.dispose(); // still idempotent
        for (const v of [source, pure, consumed]) v.dispose();
      }
    }
  } finally {
    fast.dispose();
  }
});

test('an in-place offset hands the grid over: same native handle, no copy', () => {
  const a = sphere(6);
  const handle = a.handle;
  const before = pk.allocated.voxels;
  const grown = a.offset({ distance: 1, consume: true });
  assert.equal(grown.handle, handle, 'the result owns the receiver grid');
  assert.equal(pk.allocated.voxels, before, 'not one grid allocated');
  grown.dispose();
  assert.equal(pk.allocated.voxels, before - 1);
});

test('consuming booleans dispose the receiver once the result exists', () => {
  const b = sphere(5, [5, 0, 0]);
  const c = sphere(4, [0, 5, 0]);
  const runs: [string, (v: Voxels, options?: ConsumeOptions) => Voxels][] = [
    ['union', (v, options) => (options ? v.union(b, c, options) : v.union(b, c))],
    ['subtract', (v, options) => (options ? v.subtract(b, c, options) : v.subtract(b, c))],
    ['intersect', (v, options) => v.intersect(b, options)],
  ];
  for (const [name, run] of runs) {
    const a = sphere(7);
    const pure = run(a);
    const before = pk.allocated.voxels;
    const consumed = run(a, { consume: true });
    assert.equal(consumed.gridHash().hash, pure.gridHash().hash, `${name}: the pure call's grid`);
    assert.equal(pk.allocated.voxels, before, `${name}: one grid in, one grid out`);
    assert.throws(() => a.isEmpty, disposedError);
    assert.equal(b.isEmpty, false, `${name}: operands are never consumed`);
    pure.dispose();
    consumed.dispose();
  }
  // No operands: the receiver's grid passes to the result uncopied.
  const a = sphere(7);
  const handle = a.handle;
  const same = a.union({ consume: true });
  assert.equal(same.handle, handle);
  assert.throws(() => a.union(), disposedError);
  // A receiver that is also an operand still reads it before it is freed.
  const d = sphere(6);
  const self = d.union(d, { consume: true });
  assert.equal(self.gridHash().hash, sphere(6).gridHash().hash);
  // { consume: false } is the pure call.
  const e = sphere(6);
  e.union(b, { consume: false }).dispose();
  assert.equal(e.isEmpty, false);
});

test('a consuming call that throws still disposes its receiver and keeps its own error', () => {
  const dead = sphere(3);
  dead.dispose();
  for (const run of [
    (v: Voxels) => v.union(dead, { consume: true }),
    (v: Voxels) => v.intersect(dead, { consume: true }),
    (v: Voxels) => v.offset({ distance: Number.NaN, consume: true }),
    (v: Voxels) => v.shell({ inner: 1, consume: true }),
  ]) {
    const a = sphere(5);
    const before = pk.allocated.voxels;
    assert.throws(
      () => run(a),
      (error: unknown) => error instanceof PicoError && error.code !== 'PICO_DISPOSED',
      'the operation reports its own failure',
    );
    assert.throws(() => a.volume, disposedError);
    assert.equal(pk.allocated.voxels, before - 1, 'the receiver grid is freed');
  }
  // A native failure inside an in-place offset frees the half-mutated grid.
  const raw = sphere(5);
  const handle = raw.handle;
  const before = pk.allocated.voxels;
  bindPicoRaw(pk.module).Voxels_Destroy(pk.handle, handle); // the grid vanishes under the wrapper
  assert.throws(() => raw.offset({ distance: 1, consume: true }), /PICO_INVALID_HANDLE|does not know/u);
  assert.equal(pk.allocated.voxels, before - 1);
});

test('scope disposes what the callback created, except its result', () => {
  const outside = sphere(4);
  const before = pk.allocated.voxels;
  const meshesBefore = pk.allocated.meshes;
  let inner: Voxels | undefined;
  const result = pk.scope(() => {
    inner = sphere(6);
    const grown = inner.offset({ distance: 1 });
    const cut = grown.subtract(outside);
    return cut.toMesh();
  });
  assert.equal(pk.allocated.voxels, before, 'every grid made inside is freed');
  assert.equal(pk.allocated.meshes, meshesBefore + 1, 'the returned mesh survives');
  assert.ok(result.triangleCount > 0);
  assert.throws(() => inner!.volume, disposedError);
  assert.equal(outside.isEmpty, false, 'objects from outside the scope are untouched');

  // Arrays and plain objects keep their direct members.
  const [a, b] = pk.scope(() => [sphere(3), sphere(2), sphere(1)].slice(0, 2));
  assert.equal(a!.isEmpty || b!.isEmpty, false);
  assert.equal(pk.allocated.voxels, before + 2);
  const kept = pk.scope(() => ({ body: sphere(3), mesh: sphere(2).toMesh(), size: 3 }));
  assert.equal(kept.body.isEmpty, false);
  assert.ok(kept.mesh.triangleCount > 0);
  assert.equal(pk.allocated.voxels, before + 3);
  // A class instance is kept as a value, not searched.
  class Holder {
    readonly voxels: Voxels;
    constructor(voxels: Voxels) {
      this.voxels = voxels;
    }
  }
  const holder = pk.scope(() => new Holder(sphere(3)));
  assert.throws(() => holder.voxels.volume, disposedError);
  // Non-object results keep nothing.
  assert.equal(
    pk.scope(() => sphere(3).volume > 0),
    true,
  );
  assert.equal(
    pk.scope(() => null),
    null,
  );
  assert.equal(pk.allocated.voxels, before + 3);
  for (const v of [a!, b!, kept.body, kept.mesh, result]) v.dispose();
});

test('scopes nest: an inner result belongs to the outer scope', () => {
  const before = pk.allocated.voxels;
  const outer = pk.scope(() => {
    const fromInner = pk.scope(() => sphere(5).offset({ distance: 1 }));
    assert.equal(pk.allocated.voxels, before + 1, 'the inner scope freed its intermediate');
    const scratch = sphere(2);
    void scratch;
    return fromInner.union(sphere(3, [6, 0, 0]));
  });
  assert.equal(pk.allocated.voxels, before + 1, 'the outer scope freed the inner result it did not return');
  outer.dispose();
});

test('a throwing scope disposes everything it created and rethrows', () => {
  const before = pk.allocated.voxels;
  const failure = new Error('design rule violated');
  assert.throws(
    () =>
      pk.scope(() => {
        sphere(5).offset({ distance: 1 });
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(pk.allocated.voxels, before);
});

test('scope refuses an asynchronous callback, after disposing what it made', () => {
  const before = pk.allocated.voxels;
  assert.throws(
    () =>
      pk.scope(async () => {
        sphere(4);
        await Promise.resolve();
      }),
    (error: unknown) => error instanceof PicoError && error.code === 'PICO_INVALID_ARGUMENT',
  );
  assert.equal(pk.allocated.voxels, before);
  // oxlint-disable-next-line unicorn/no-thenable -- a foreign thenable is exactly what scope() must refuse
  assert.throws(() => pk.scope(() => ({ then: () => {} })), /synchronous/u);
});

test('scope on a disposed session throws PICO_DISPOSED', async () => {
  const session = await createPico({ voxelSize: 1 });
  session.dispose();
  assert.throws(() => session.scope(() => 1), disposedError);
});

test('a grid metadata wrapper is owned by its grid, not by the scope', () => {
  const kept = pk.scope(() => {
    const v = sphere(3);
    void v.metadata; // created inside the scope, owned by v
    return v;
  });
  assert.equal(typeof kept.metadata.count, 'number');
  kept.dispose();
});

test('diet consumer shapes', () => {
  const a = sphere(3);
  const b = sphere(2);
  expectTypeOf(a.union(b, { consume: true })).toEqualTypeOf<Voxels>();
  expectTypeOf(sphere(3).subtract(b, b, { consume: true })).toEqualTypeOf<Voxels>();
  expectTypeOf(sphere(3).intersect(b, { consume: true })).toEqualTypeOf<Voxels>();
  expectTypeOf(sphere(3).offset({ distance: 1, consume: true })).toEqualTypeOf<Voxels>();
  expectTypeOf(pk.scope(() => sphere(1).toMesh())).toEqualTypeOf<Mesh>();
  expectTypeOf(pk.scope(() => [sphere(1), 2] as const)).toEqualTypeOf<readonly [Voxels, 2]>();
  expectTypeOf<OffsetOptions>().toHaveProperty('consume');
  // Misuse the compiler refuses; never called.
  const misuse = () => {
    // @ts-expect-error -- options trail the operands; they cannot lead them
    a.union({ consume: true }, b);
    // @ts-expect-error -- consume is a boolean
    a.offset({ distance: 1, consume: 'yes' });
    // @ts-expect-error -- scope takes a callback, not the value
    pk.scope(a);
  };
  assert.equal(typeof misuse, 'function');
});
