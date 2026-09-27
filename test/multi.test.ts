// picovoxel/multi — the pthread entry. Structural proof (shared heap), the
// threads-actually-engaged gate (oneTBB serializes silently when its workers
// never launch — the warmup in createPico exists exactly for that), a
// serial-differential on real geometry, and the drop-in surface guarantee.
import { expect, test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';
import { gyroidExpression } from './helpers.ts';

test('multi entry exports the same surface as the base entry (drop-in specifier swap)', () => {
  expect(Object.keys(multiEntry).sort()).toEqual(Object.keys(serialEntry).sort());
});

test('multi session: shared heap, engaged worker pool, serial-identical geometry', async () => {
  const multi = await multiEntry.createPico({ voxelSize: 0.5 });
  const serial = await serialEntry.createPico({ voxelSize: 0.5 });
  try {
    expect(multi.name).toBe('PicoGK Core Library');
    // Pthread build marker: the wasm heap is a SharedArrayBuffer view.
    expect(multi.module.HEAPF32.buffer.constructor.name).toBe('SharedArrayBuffer');
    expect(serial.module.HEAPF32.buffer.constructor.name).toBe('ArrayBuffer');
    // The createPico warmup must leave TBB workers running; a zero here is
    // the silent-serialization failure mode and would go invisible otherwise.
    expect(multi.module.PThread?.runningWorkers.length).toBeGreaterThan(0);

    // Differential: identical model on both variants — bit-identical volume and
    // counts (hex-float discipline: compare exact values, not tolerances).
    const shape = (pk: typeof multi) => {
      const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
      const bore = pk.createVoxels({ shape: 'beam', start: [0, 0, -10], end: [0, 0, 10], radius: 3 });
      return sphere.subtract(bore);
    };
    const multiShape = shape(multi);
    const serialShape = shape(serial);
    expect(multiShape.volume).toBe(serialShape.volume);
    const multiMesh = multiShape.toMesh();
    const serialMesh = serialShape.toMesh();
    expect(multiMesh.triangleCount).toBe(serialMesh.triangleCount);
    expect(multiMesh.vertexCount).toBe(serialMesh.vertexCount);

    // Tape differential: the parallel fill partitions work across TBB workers
    // (serial build: same code, one thread). Values are pure per-voxel and the
    // merge is coordinate-indexed node-stealing, so the grids — and their STL
    // bytes — must be identical regardless of thread count.
    const tape = (pk: typeof multi) =>
      pk.createVoxels({
        shape: 'implicit',
        boundsMin: [-12, -12, -12],
        boundsMax: [12, 12, 12],
        sdf: gyroidExpression,
      });
    const multiTape = tape(multi);
    const serialTape = tape(serial);
    expect(multiTape.volume).toBe(serialTape.volume);
    expect(Buffer.from(multiTape.toMesh().toStl()).equals(Buffer.from(serialTape.toMesh().toStl()))).toBe(
      true,
    );

    // R9 compose differentials: every applied voxel is written by exactly one
    // thread and is a pure function of coordinate + frozen input grid, so the
    // composed grids must also be thread-count independent.
    const composed = (pk: typeof multi) =>
      pk
        .createVoxels({ shape: 'sphere', center: [10, 0, 0], radius: 6 })
        .withImplicit({ boundsMin: [-12, -12, -12], boundsMax: [12, 12, 12], sdf: gyroidExpression });
    const multiComposed = composed(multi);
    const serialComposed = composed(serial);
    expect(multiComposed.volume).toBe(serialComposed.volume);
    expect(
      Buffer.from(multiComposed.toMesh().toStl()).equals(Buffer.from(serialComposed.toMesh().toStl())),
    ).toBe(true);

    const masked = (pk: typeof multi) =>
      pk.createVoxels({ shape: 'sphere', radius: 10 }).maskedByImplicit({ sdf: gyroidExpression });
    const multiMasked = masked(multi);
    const serialMasked = masked(serial);
    expect(multiMasked.volume).toBe(serialMasked.volume);
    expect(Buffer.from(multiMasked.toMesh().toStl()).equals(Buffer.from(serialMasked.toMesh().toStl()))).toBe(
      true,
    );
  } finally {
    multi.dispose();
    serial.dispose();
  }
});

// SKv2-0 V0.4 — the fast lane's offset family: a fastRenorm session on the MT
// artifact must be G0-identical to the same session on the serial artifact
// (thread-count AND allocator independent — multi links mimalloc since V0.3),
// and the SK-0.8 hard health boolean must hold on the fast-lane output.
test('fastRenorm session on the MT artifact: single≡multi G0 identity, healthy level set', async () => {
  const multi = await multiEntry.createPico({ voxelSize: 0.4, fastRenorm: true });
  const serial = await serialEntry.createPico({ voxelSize: 0.4, fastRenorm: true });
  try {
    const body = (pk: typeof multi) =>
      pk
        .createVoxels({ shape: 'sphere', radius: 8 })
        .union(pk.createVoxels({ shape: 'beam', start: [-2, -2, -2], end: [12, 2, 2], radius: 2 }));
    const diagnose = (pk: typeof multi, handle: bigint): string => {
      const bDiagnose = pk.module.cwrap('Voxels_bDiagnose', 'boolean', ['bigint', 'bigint', 'number']) as (
        l: bigint,
        h: bigint,
        p: number,
      ) => boolean;
      const p = pk.module._malloc(255);
      try {
        bDiagnose(pk.handle, handle, p);
        return pk.module.UTF8ToString(p);
      } finally {
        pk.module._free(p);
      }
    };
    const ops: [string, (v: ReturnType<typeof body>) => ReturnType<typeof body>][] = [
      ['offset', (v) => v.offset({ distance: 2 })],
      ['doubleOffset', (v) => v.doubleOffset({ first: 2, second: -2 })],
      ['smoothen', (v) => v.smoothen({ distance: 1 })],
      ['fillet', (v) => v.fillet({ rounding: 2 })],
      ['shell', (v) => v.shell({ inner: -1, outer: 1 })],
    ];
    for (const [label, run] of ops) {
      const m = run(body(multi));
      const s = run(body(serial));
      // Full G0 record equality: hash + active/inside counts, not just the digest.
      expect(m.gridHash(), `${label}: fast-lane multi drifted from serial`).toEqual(s.gridHash());
      expect(diagnose(multi, m.handle), `${label}: fast-lane level set unhealthy`).toBe('');
      m.dispose();
      s.dispose();
    }
  } finally {
    multi.dispose();
    serial.dispose();
  }
});
