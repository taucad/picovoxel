// picogk-js/multi — the pthread entry. Structural proof (shared heap), the
// threads-actually-engaged gate (oneTBB serializes silently when its workers
// never launch — the warmup in createPicoGK exists exactly for that), a
// serial-differential on real geometry, and the drop-in surface guarantee.
import { expect, test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';

test('multi entry exports the same surface as the base entry (drop-in specifier swap)', () => {
  expect(Object.keys(multiEntry).sort()).toEqual(Object.keys(serialEntry).sort());
});

test('multi session: shared heap, engaged worker pool, serial-identical geometry', async () => {
  const multi = await multiEntry.createPicoGK({ voxelSize: 0.5 });
  const serial = await serialEntry.createPicoGK({ voxelSize: 0.5 });
  try {
    expect(multi.name).toBe('PicoGK Core Library');
    // Pthread build marker: the wasm heap is a SharedArrayBuffer view.
    expect(multi.module.HEAPF32.buffer.constructor.name).toBe('SharedArrayBuffer');
    expect(serial.module.HEAPF32.buffer.constructor.name).toBe('ArrayBuffer');
    // The createPicoGK warmup must leave TBB workers running; a zero here is
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
  } finally {
    multi.dispose();
    serial.dispose();
  }
});
