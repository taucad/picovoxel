// The pager through the facade: identity with it forced on at a tiny budget (I1,
// I3, I4), the default, the memory footprint (I6b), the options, the runtime
// wiring, and the D16 audit of the facade's own cleanup paths.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';
import createSerialGlue from '../src/pico.mjs';
import { openPicoRuntime, type Pico, type PicoGlueFactory } from '../src/session.ts';
import { createFakeRegistry, fnv1a, gyroidExpression, hexFloat } from './helpers.ts';

const serialGlue = createSerialGlue as PicoGlueFactory;
const FORCED = { budgetBytes: 0, minParkBytes: 0 } as const;
const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

/** A model that keeps several grids alive across operations, so a zero budget parks and restores them all. */
function model(pk: Pico) {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 12 });
  const bore = pk.createVoxels({ shape: 'beam', start: [0, 0, -14], end: [0, 0, 14], radius: 4 });
  const lattice = pk.createLattice();
  lattice.addBeam({ start: [-12, -12, -12], end: [12, 12, 12], radius: 1.5 });
  const struts = pk.createVoxels({ shape: 'empty' }).withLattice(lattice);
  const gyroid = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-10, -10, -10],
    boundsMax: [10, 10, 10],
    sdf: gyroidExpression,
  });
  const body = sphere.subtract(bore).offset({ distance: 1 });
  const result = body
    .union(struts)
    .intersect(gyroid.offset({ distance: 2 }))
    .smoothen({ distance: 0.5 });
  const stl = result.toMesh().toStl(pk.lane === 'exact' ? {} : { acceptLane: 'fast' });
  // Every input is used again after the result, so each one is restored once more.
  const inputs = [sphere, bore, struts, gyroid, body].map((v) => v.gridHash().hash).join();
  return { stl: fnv1a(stl), hash: result.gridHash().hash, volume: hexFloat(result.volume), inputs };
}

test('I1/I3: output is byte-identical with the pager forced on at a zero budget, RAM and disk, both builds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-pager-identity-'));
  try {
    for (const [entry, lane] of [
      [serialEntry, 'exact'],
      [multiEntry, 'fast'],
    ] as const) {
      const off = await entry.createPico({ voxelSize: 0.5, lane, pager: false });
      const reference = model(off);
      off.dispose();
      for (const store of ['ram', 'disk'] as const) {
        const on = await entry.createPico({
          voxelSize: 0.5,
          lane,
          pager: { ...FORCED, store, directory: dir },
        });
        assert.deepEqual(model(on), reference, `${lane} ${store}`);
        const stats = on.footprint.pager!;
        assert.ok(
          stats.parks > 5 && stats.restores > 5,
          `the pager worked: ${stats.parks} parks, ${stats.restores} restores`,
        );
        assert.equal(stats.store, store);
        on.dispose();
      }
      for (const mode of ['serial', 'pooled', 'pipelined'] as const) {
        const on = await entry.createPico({
          voxelSize: 0.5,
          lane,
          pager: { ...FORCED, mode, codec: 'none' },
        });
        assert.deepEqual(model(on), reference, `${lane} ${mode} codec none`);
        on.dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I4: the default pager is on at a 2 GiB budget and parks nothing on an ordinary model', async () => {
  const pk = await serialEntry.createPico({ voxelSize: 0.5 });
  const off = await serialEntry.createPico({ voxelSize: 0.5, pager: false });
  try {
    assert.deepEqual(model(pk), model(off));
    const stats = pk.footprint.pager!;
    assert.deepEqual(
      [stats.budgetBytes, stats.mode, stats.codec, stats.store, stats.parks, stats.restores, stats.farBytes],
      [2 ** 31, 'serial', 'lz4', 'ram', 0, 0, 0],
    );
    assert.ok(
      stats.arenaBytes > 8 * 2 ** 20 && stats.arenaBytes < 20 * 2 ** 20,
      `serial arena ${stats.arenaBytes}`,
    );
  } finally {
    pk.dispose();
    off.dispose();
  }
  const multi = await multiEntry.createPico({ voxelSize: 0.5 });
  try {
    assert.equal(multi.footprint.pager!.mode, 'pipelined');
  } finally {
    multi.dispose();
  }
});

test('I6b: the footprint reports heap and far bytes; the pager off reports none', async () => {
  const on = await serialEntry.createPico({ voxelSize: 0.5, pager: FORCED });
  const off = await serialEntry.createPico({ voxelSize: 0.5, pager: false });
  try {
    const kept = [1, 2, 3].map((r) => on.createVoxels({ shape: 'sphere', radius: 6 * r }));
    on.createVoxels({ shape: 'empty' }); // a safe point parks the three
    const { heapBytes, farBytes, pager } = on.footprint;
    assert.equal(heapBytes, on.module.HEAPU8.byteLength);
    assert.ok(farBytes > 0 && farBytes === pager!.farBytes);
    assert.ok(pager!.imageBytes > 0 && pager!.imageBytes <= farBytes);
    assert.equal(pager!.parkedGrids, 3);
    assert.ok(kept.every((v) => v.volume > 0));
    assert.deepEqual(off.footprint.pager, null);
    assert.equal(off.footprint.farBytes, 0);
  } finally {
    on.dispose();
    off.dispose();
  }
  assert.throws(() => on.footprint, isCode('PICO_DISPOSED'));
});

test('pager options: validated at creation; pager is a runtime option', async () => {
  await assert.rejects(
    () => serialEntry.createPico({ pager: { codec: 'zstd' as never } }),
    isCode('PICO_INVALID_ARGUMENT'),
  );
  const runtime = await serialEntry.createPicoRuntime({ pager: { budgetBytes: 2 ** 30 } });
  try {
    await assert.rejects(
      () => runtime.createPico({ pager: false } as never),
      isCode('PICO_INVALID_ARGUMENT'),
    );
    const pk = await runtime.createPico();
    assert.equal(pk.footprint.pager!.budgetBytes, 2 ** 30);
  } finally {
    runtime.dispose();
  }
});

test('a disk store that cannot open is PICO_INVALID_ARGUMENT with the cause, not a silent RAM fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picovoxel-pager-bad-'));
  try {
    const notADirectory = join(dir, 'file');
    writeFileSync(notADirectory, 'x');
    await assert.rejects(
      () => serialEntry.createPico({ pager: { store: 'disk', directory: notADirectory } }),
      (error: unknown) => isCode('PICO_INVALID_ARGUMENT')(error) && (error as Error).cause instanceof Error,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no heap for the arena: the runtime does not start, PICO_OUT_OF_MEMORY, the store is released', async () => {
  let terminated = 0;
  const starved: PicoGlueFactory = async (overrides) => {
    const module = await serialGlue(overrides);
    (module as unknown as Record<string, unknown>)['_K7_nArena'] = () => -2n;
    module.PThread = {
      runningWorkers: [],
      unusedWorkers: [],
      terminateAllThreads: () => void (terminated += 1),
    };
    return module;
  };
  await assert.rejects(() => openPicoRuntime(starved, {}), isCode('PICO_OUT_OF_MEMORY'));
  assert.equal(terminated, 1, 'the pool was joined');
});

test('paged wrappers: handle getter restores; metadata views die with a park; dispose and GC free parked grids', async () => {
  const registry = createFakeRegistry();
  const runtime = await serialEntry.createPicoRuntime({ pager: FORCED });
  const pk = await runtime.createPico({ voxelSize: 0.5, registry });
  const sibling = await runtime.createPico({ voxelSize: 0.5 });
  try {
    const a = pk.createVoxels({ shape: 'sphere', radius: 8 });
    // At a zero budget the getter's own safe point parks the grid, so the view it
    // returned is already disposed; the next read restores the grid for a fresh view.
    const view = a.metadata;
    assert.throws(() => view.count, isCode('PICO_DISPOSED'), 'a view onto the parked grid is disposed');
    const fresh = a.metadata;
    assert.notEqual(fresh, view, 'a fresh view after the restore');
    pk.createVoxels({ shape: 'empty' });
    assert.notEqual(a.handle, 0n, 'the handle getter restores');

    const b = pk.createVoxels({ shape: 'sphere', radius: 9 });
    const before = b.memUsage;
    b.densifyInterior(); // in place: re-measured
    assert.ok(b.memUsage > before);

    const parkedBefore = pk.footprint.pager!.parkedGrids;
    pk.createVoxels({ shape: 'empty' });
    a.dispose(); // parked: its image goes
    a.dispose();
    assert.ok(pk.footprint.pager!.parkedGrids <= parkedBefore);
    registry.collect(b); // GC of a paged wrapper frees through the pager
    const s = sibling.createVoxels({ shape: 'sphere', radius: 5 });
    sibling.createVoxels({ shape: 'empty' });
    pk.dispose(); // the instance's grids and images go with it
    assert.ok(s.volume > 0, 'the sibling session keeps its grids');
  } finally {
    runtime.dispose();
  }
});

test('D16 audit: a derivation that fails on an instance that cannot free keeps its own error', async () => {
  let failDestroy = false;
  const flaky: PicoGlueFactory = async (overrides) => {
    const module = await serialGlue(overrides);
    const exports = module as unknown as Record<string, (...args: unknown[]) => unknown>;
    const destroy = exports['_Voxels_Destroy']!;
    exports['_Voxels_Destroy'] = (...args: unknown[]) => {
      if (failDestroy) throw new WebAssembly.RuntimeError('unreachable');
      return destroy(...args);
    };
    const offset = exports['_Voxels_Offset']!;
    exports['_Voxels_Offset'] = (...args: unknown[]) => {
      if (failDestroy) throw new WebAssembly.RuntimeError('memory access out of bounds');
      return offset(...args);
    };
    return module;
  };
  const runtime = await openPicoRuntime(flaky, { pager: false });
  const pk = await runtime.createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
    failDestroy = true;
    assert.throws(
      () => sphere.offset({ distance: 1 }),
      (error: unknown) => {
        return isCode('PICO_OUT_OF_MEMORY')(error) && /Voxels_Offset/.test((error as Error).message);
      },
    );
    failDestroy = false;
  } finally {
    runtime.dispose();
  }
});

/** A build that hands grids on with `consume` and frees intermediates in `pico.scope()`. */
function consumingModel(pk: Pico) {
  const result = pk.scope(() => {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 12 });
    const bore = pk.createVoxels({ shape: 'beam', start: [0, 0, -14], end: [0, 0, 14], radius: 4 });
    const cut = sphere.subtract(bore, { consume: true }); // sphere disposed; bore left to the scope
    const grown = cut.offset({ distance: 1, consume: true }); // in place: cut's grid passes to grown
    const kept = grown.union({ consume: true }); // no operands: handed over uncopied
    return kept.smoothen({ distance: 0.5, consume: true });
  });
  const stl = fnv1a(result.toMesh().toStl());
  return { result, out: { stl, hash: result.gridHash().hash, volume: hexFloat(result.volume) } };
}

test('consume and scope compose with the pager: identical bytes, and released grids leave it', async () => {
  const off = await serialEntry.createPico({ voxelSize: 0.5, lane: 'exact', pager: false });
  const reference = consumingModel(off).out;
  off.dispose();
  const pk = await serialEntry.createPico({ voxelSize: 0.5, lane: 'exact', pager: FORCED });
  try {
    const { result, out } = consumingModel(pk);
    assert.deepEqual(out, reference);
    const stats = pk.footprint.pager!;
    assert.ok(stats.parks > 0 && stats.restores > 0, `${stats.parks} parks, ${stats.restores} restores`);
    // Only the result is left: every consumed, scoped or handed-over grid left the pager.
    assert.equal(stats.parkedGrids + (stats.residentBytes > 0 ? 1 : 0), 1);
    result.dispose();
    assert.deepEqual([pk.footprint.pager!.parkedGrids, pk.footprint.pager!.residentBytes], [0, 0]);
  } finally {
    pk.dispose();
  }
});

test('D16: a consuming call that fails keeps its own error, and its grid leaves the pager', async () => {
  let fail = false;
  const flaky: PicoGlueFactory = async (overrides) => {
    const module = await serialGlue(overrides);
    const exports = module as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ['_Voxels_Offset', '_Voxels_Destroy', '_K7_nPark']) {
      const original = exports[name]!;
      exports[name] = (...args: unknown[]) => {
        if (fail) throw new WebAssembly.RuntimeError(`${name}: unreachable`);
        return original(...args);
      };
    }
    return module;
  };
  const runtime = await openPicoRuntime(flaky, { pager: { budgetBytes: 2 ** 31 } });
  const pk = await runtime.createPico({ voxelSize: 0.5 });
  try {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 5 });
    fail = true;
    assert.throws(
      () => sphere.offset({ distance: 1, consume: true }),
      (error: unknown) =>
        isCode('PICO_OUT_OF_MEMORY')(error) && /Voxels_Offset aborted/.test((error as Error).message),
    );
    fail = false;
    assert.throws(() => sphere.volume, isCode('PICO_DISPOSED'));
    assert.deepEqual([pk.footprint.pager!.parkedGrids, pk.footprint.pager!.residentBytes], [0, 0]);
  } finally {
    runtime.dispose();
  }
});
