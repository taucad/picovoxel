// picovoxel/multi — the pthread entry. Structural proof (shared heap), the
// threads-actually-engaged gate (oneTBB serializes silently when its workers
// never launch — the warmup in createPico exists exactly for that), a
// serial-differential on real geometry, and the drop-in surface guarantee.
import { expect, test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';
import { gyroidExpression } from './tape.test.ts';

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
    expect(Buffer.from(multiTape.toMesh().toStl()).equals(Buffer.from(serialTape.toMesh().toStl()))).toBe(true);

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
    expect(
      Buffer.from(multiMasked.toMesh().toStl()).equals(Buffer.from(serialMasked.toMesh().toStl())),
    ).toBe(true);
  } finally {
    multi.dispose();
    serial.dispose();
  }
});
