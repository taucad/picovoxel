// The park TU (src/pico-park.cpp) on the real module: K15 §7's eight tests and
// K17 §7's five. Raw exports, a JS array as the far store, and sessions with the
// pager off, so each test sets the arena and mode itself (K7 state is per module).
//
// Threaded runs above 64 proxy units are not bitwise reproducible (D17, pre-existing,
// paging on or off); every grid here is far below that, so identity is exact.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as serialEntry from '../src/index.ts';
import * as multiEntry from '../src/multi.ts';
import { bindPicoRaw, type PicoRaw } from '../src/raw.generated.ts';
import type { Pico, Voxels } from '../src/index.ts';
import { fnv1a, gyroidExpression } from './helpers.ts';

type Mode = 0 | 1 | 2;
const MODES: Mode[] = [0, 1, 2];
const LZ4 = 1;
const TRANSFORM = 4;
const DESTRUCTIVE = 1;

interface Harness {
  pk: Pico;
  raw: PicoRaw;
  /** Parks `handle`; the sink fails with `failWith` once `failAfter` frames were taken. */
  park(
    handle: bigint,
    options?: { codec?: number; flags?: number; block?: number; failAfter?: number; failWith?: number },
  ): {
    result: number;
    lastError: number;
    image: Uint8Array;
  };
  /** Restores from `image`, served in chunks of `chunk` bytes. */
  restore(image: Uint8Array, chunk?: number): { handle: bigint; lastError: number };
  arena(slots: number, block: number, reserveMiB: number, mode: Mode): number;
  hash(handle: bigint): string;
  dispose(): void;
}

async function harness(entry: typeof serialEntry | typeof multiEntry): Promise<Harness> {
  const pk = await entry.createPico({ voxelSize: 0.5, pager: false });
  const { module } = pk;
  const raw = bindPicoRaw(module);
  let frames: Uint8Array[] = [];
  let failAfter = Number.POSITIVE_INFINITY;
  let failWith = 1;
  const heap = () => {
    const memory = module.wasmMemory;
    return memory ? new Uint8Array(memory.buffer) : module.HEAPU8;
  };
  const sink = module.addFunction((pointer: number, bytes: number) => {
    if (frames.length >= failAfter) return failWith;
    frames.push(heap().slice(pointer >>> 0, (pointer >>> 0) + bytes));
    return 0;
  }, 'iii');
  let source: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let chunkBytes = 1 << 20;
  const sourceFn = module.addFunction((pointer: number, capacity: number) => {
    const take = Math.min(capacity, chunkBytes, source.length - offset);
    heap().set(source.subarray(offset, offset + take), pointer >>> 0);
    offset += take;
    return take;
  }, 'iii');
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) out.set(part, (at += part.length) - part.length);
    return out;
  };
  return {
    pk,
    raw,
    park(handle, options = {}) {
      frames = [];
      failAfter = options.failAfter ?? Number.POSITIVE_INFINITY;
      failWith = options.failWith ?? 1;
      const result = Number(
        raw.K7_nPark(
          pk.handle,
          handle,
          TRANSFORM,
          options.codec ?? LZ4,
          1,
          options.block ?? 512,
          options.flags ?? 0,
          sink,
        ),
      );
      return { result, lastError: raw.K7_nLastError(), image: concat(frames) };
    },
    restore(image, chunk = 1 << 20) {
      source = image;
      offset = 0;
      chunkBytes = chunk;
      const handle = raw.K7_hRestore(pk.handle, sourceFn);
      return { handle, lastError: raw.K7_nLastError() };
    },
    arena: (slots, block, reserveMiB, mode) => Number(raw.K7_nArena(slots, block, reserveMiB, mode)),
    hash: (handle) => gridHashOf(pk, handle),
    dispose() {
      raw.K7_nArena(0, 512, 0, 0);
      module.removeFunction(sink);
      module.removeFunction(sourceFn);
      pk.dispose();
    },
  };
}

/** gridHash of a raw handle, through a throwaway copy wrapped by the facade. */
function gridHashOf(pk: Pico, handle: bigint): string {
  const raw = bindPicoRaw(pk.module);
  const scratch = pk.createVoxels({ shape: 'empty' });
  raw.Voxels_BoolAdd(pk.handle, scratch.handle, handle);
  const { hash } = scratch.gridHash();
  scratch.dispose();
  return hash;
}

/** A leafy grid: a gyroid shell clipped to a box (thousands of leaves, tiles inside). */
function gyroid(pk: Pico, size = 24): Voxels {
  return pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-size, -size, -size],
    boundsMax: [size, size, size],
    sdf: gyroidExpression,
  });
}

/** The leaf count from a park's header frame: {kind, raw, comp, check} then magic, transform, codec, level, block, background, u64 leaves. */
function leafCount(raw: PicoRaw, pk: Pico, handle: bigint): number {
  const { module } = pk;
  let header: Uint8Array | undefined;
  const sink = module.addFunction((pointer: number, bytes: number) => {
    header ??= (module.wasmMemory ? new Uint8Array(module.wasmMemory.buffer) : module.HEAPU8).slice(
      pointer >>> 0,
      (pointer >>> 0) + bytes,
    );
    return 2; // stop after the header: a non-destructive park leaves the grid alone
  }, 'iii');
  raw.K7_nPark(pk.handle, handle, TRANSFORM, LZ4, 1, 512, 0, sink);
  module.removeFunction(sink);
  return Number(new DataView(header!.buffer).getBigUint64(16 + 24, true));
}

/** Fills the wasm heap to its ceiling with _malloc blocks around `body` (errors.test.ts's helper). */
function withExhaustedHeap<T>(pk: Pico, body: () => T): T {
  const { module } = pk;
  const held: number[] = [];
  try {
    for (const size of [64 << 20, 1 << 20, 64 << 10, 1 << 10, 64]) {
      for (let pointer = module._malloc(size); pointer !== 0; pointer = module._malloc(size))
        held.push(pointer);
    }
    return body();
  } finally {
    for (const pointer of held) module._free(pointer);
  }
}

// ── K15 §7 ──────────────────────────────────────────────────────────────────

test('K15-1 / K17-1 (I3): frames are byte-identical across serial, pooled and pipelined, any slot count', async () => {
  // One baseline per shape and block across both builds: the serial and multi frames must agree too.
  const references = new Map<string, number>();
  for (const entry of [serialEntry, multiEntry]) {
    const h = await harness(entry);
    try {
      const shapes: Array<[string, Voxels]> = [
        ['gyroid', gyroid(h.pk)],
        ['union', gyroid(h.pk, 12).union(h.pk.createVoxels({ shape: 'sphere', radius: 9 }))],
        ['empty', h.pk.createVoxels({ shape: 'empty' })],
        ['one leaf', h.pk.createVoxels({ shape: 'sphere', radius: 0.6 })],
        ['tiles', h.pk.createVoxels({ shape: 'sphere', radius: 30 })], // interior tiles
      ];
      for (const [name, voxels] of shapes) {
        const leaves = leafCount(h.raw, h.pk, voxels.handle);
        // Blocks below, equal to and above the slot count, and a leaf count off any multiple.
        for (const block of [7, Math.max(1, Math.ceil(leaves / 4)), 512]) {
          const key = `${name} block ${block}`;
          for (const slots of [1, 2, 4]) {
            for (const mode of MODES) {
              assert.ok(h.arena(slots, block, 8, mode) > 0);
              const { result, image } = h.park(voxels.handle, { block });
              assert.equal(result, image.length, `${name}: park reports the bytes it wrote`);
              const digest = fnv1a(image);
              if (!references.has(key)) references.set(key, digest);
              assert.equal(digest, references.get(key), `${key} slots ${slots} mode ${mode}`);
            }
          }
        }
      }
    } finally {
      h.dispose();
    }
  }
});

test('K15-2: round trip — gridHash after park and restore, every mode and both codecs, destructive or not', async () => {
  for (const entry of [serialEntry, multiEntry]) {
    const h = await harness(entry);
    try {
      for (const mode of MODES) {
        h.arena(4, 64, 8, mode);
        for (const codec of [0, 1]) {
          for (const flags of [0, DESTRUCTIVE]) {
            const voxels = gyroid(h.pk);
            const before = voxels.gridHash().hash;
            const copy = h.raw.Voxels_hCreateCopy(h.pk.handle, voxels.handle);
            const { result, image } = h.park(copy, { codec, flags, block: 64 });
            assert.ok(result > 0);
            h.raw.Voxels_Destroy(h.pk.handle, copy);
            const { handle, lastError } = h.restore(image, 4093); // odd chunks: frames straddle pulls
            assert.equal(lastError, 0);
            assert.equal(h.hash(handle), before, `mode ${mode} codec ${codec} flags ${flags}`);
            h.raw.Voxels_Destroy(h.pk.handle, handle);
            voxels.dispose();
          }
        }
      }
    } finally {
      h.dispose();
    }
  }
});

test('K15-3 (D13): on a full heap the park runs on the reserve, and the restore matches', async () => {
  const h = await harness(serialEntry);
  try {
    h.arena(1, 512, 8, 0);
    const voxels = gyroid(h.pk);
    const before = voxels.gridHash().hash;
    const { result, lastError, image } = withExhaustedHeap(h.pk, () =>
      h.park(voxels.handle, { flags: DESTRUCTIVE }),
    );
    assert.ok(result > 0, `park on a full heap: result ${result}, error ${lastError}`);
    h.raw.Voxels_Destroy(h.pk.handle, voxels.handle);
    assert.equal(h.raw.K7_nRearm(), 1, 'the reserve is taken back once the grid is freed');
    const { handle } = h.restore(image);
    assert.equal(h.hash(handle), before);
  } finally {
    h.dispose();
  }
});

test('K15-4: with reserve 0 on a full heap the park is out of memory or complete — never a trap or a damaged grid', async () => {
  const h = await harness(serialEntry);
  try {
    h.arena(1, 512, 0, 0);
    const voxels = gyroid(h.pk);
    const before = voxels.gridHash().hash;
    const { result, lastError } = withExhaustedHeap(h.pk, () =>
      h.park(voxels.handle, { flags: DESTRUCTIVE }),
    );
    if (result < 0) {
      assert.deepEqual([result, lastError], [-2, 1], 'out of memory, grid intact');
      assert.equal(voxels.gridHash().hash, before, 'the grid is intact and usable after freeing');
    } else {
      assert.equal(lastError, 0); // this layout needed nothing beyond the arena
    }
  } finally {
    h.dispose();
  }
});

test('K15-5: a restore on a full heap is out of memory, and the image restores once memory is back', async () => {
  const h = await harness(serialEntry);
  try {
    h.arena(1, 512, 8, 0);
    const voxels = gyroid(h.pk);
    const before = voxels.gridHash().hash;
    const { image } = h.park(voxels.handle);
    const failed = withExhaustedHeap(h.pk, () => h.restore(image));
    assert.deepEqual([failed.handle, failed.lastError], [0n, 1]);
    const { handle } = h.restore(image);
    assert.equal(h.hash(handle), before);
  } finally {
    h.dispose();
  }
});

// Serial build only: on picovoxel/multi, mimalloc traps (memory access out of bounds) on a
// small allocation once the heap is at its ceiling, before any pager code runs; that is the
// shipped multi allocator's behaviour with the pager on or off.
test('K15-6 (D16): a boolean that exhausts the heap inside a pager scope rejects PICO_OUT_OF_MEMORY', async () => {
  for (const entry of [serialEntry]) {
    const pk = await entry.createPico({ voxelSize: 0.5, pager: { budgetBytes: 0, minParkBytes: 0 } });
    try {
      const a = gyroid(pk);
      const b = pk.createVoxels({ shape: 'sphere', radius: 20 });
      assert.ok(pk.footprint.pager!.parkedGrids >= 1, 'a parked at b’s creation');
      const error = withExhaustedHeap(pk, () => {
        try {
          a.union(b);
          return undefined;
        } catch (caught) {
          return caught;
        }
      });
      assert.ok(
        error instanceof Error && (error as { code?: string }).code === 'PICO_OUT_OF_MEMORY',
        String(error),
      );
      assert.doesNotMatch(error.message, /unwind/);
      // The instance survived the bad_alloc: the same union now succeeds.
      assert.ok(a.union(b).volume > 0);
    } finally {
      pk.dispose();
    }
  }
});

test('K15-7 / K17-3: corrupt and truncated images fail the restore cleanly, in every mode, mid-ring included', async () => {
  for (const entry of [serialEntry, multiEntry]) {
    const h = await harness(entry);
    try {
      const voxels = gyroid(h.pk);
      for (const mode of MODES) {
        h.arena(4, 16, 8, mode); // small blocks: many frames, so a late frame sits deep in the ring
        const { image } = h.park(voxels.handle, { block: 16 });
        let seed = 7 + mode;
        const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
        for (let round = 0; round < 60; round++) {
          const bad = image.slice();
          if (round % 3 === 0) {
            const { handle, lastError } = h.restore(bad.subarray(0, next() % bad.length));
            assert.deepEqual([handle, lastError], [0n, 2], 'truncated');
            continue;
          }
          // A late byte (beyond the topology) lands in a leaf frame inside the ring.
          const at =
            round % 3 === 1 ? bad.length - 1 - (next() % Math.floor(bad.length / 3)) : next() % bad.length;
          bad[at]! ^= 1 << (next() % 8);
          const { handle, lastError } = h.restore(bad);
          assert.deepEqual([handle, lastError], [0n, 2], `flip at ${at} of ${bad.length}, mode ${mode}`);
        }
        const { handle } = h.restore(image);
        assert.equal(h.hash(handle), voxels.gridHash().hash, 'the module is still sound');
        h.raw.Voxels_Destroy(h.pk.handle, handle);
      }
    } finally {
      h.dispose();
    }
  }
});

test('K15-8: an unsupported codec fails the configuration check as the "other" error, grid intact', async () => {
  const h = await harness(serialEntry);
  try {
    h.arena(1, 512, 8, 0);
    const voxels = gyroid(h.pk, 8);
    const before = voxels.gridHash().hash;
    for (const codec of [2, 3, 7, -1]) {
      const { result, lastError, image } = h.park(voxels.handle, { codec, flags: DESTRUCTIVE });
      assert.deepEqual([result, lastError, image.length], [-1, 2, 0]);
    }
    assert.equal(voxels.gridHash().hash, before);
  } finally {
    h.dispose();
  }
});

// ── K17 §7 ──────────────────────────────────────────────────────────────────

test('K17-2: a park that runs out partway in mode 2 reports it, drains every task, and the module parks again', async () => {
  const h = await harness(multiEntry);
  try {
    h.arena(4, 16, 8, 2);
    const reference = gyroid(h.pk);
    const before = reference.gridHash().hash;
    // Non-destructive: the store fills after 5 frames; nothing was freed, so -2.
    let attempt = h.park(reference.handle, { block: 16, failAfter: 5, failWith: 1 });
    assert.deepEqual([attempt.result, attempt.lastError], [-2, 1]);
    assert.equal(reference.gridHash().hash, before, 'grid intact');
    // Destructive: blocks were already freed when the store filled, so the grid is damaged (-3).
    const doomed = h.raw.Voxels_hCreateCopy(h.pk.handle, reference.handle);
    attempt = h.park(doomed, { block: 16, flags: DESTRUCTIVE, failAfter: 12, failWith: 1 });
    assert.deepEqual([attempt.result, attempt.lastError], [-3, 1]);
    h.raw.Voxels_Destroy(h.pk.handle, doomed);
    // An I/O failure is the "other" error.
    attempt = h.park(reference.handle, { block: 16, failAfter: 3, failWith: 2 });
    assert.deepEqual([attempt.result, attempt.lastError], [-1, 2]);
    // No task outlived the failures: the next park and restore are whole.
    const { result, image } = h.park(reference.handle, { block: 16 });
    assert.ok(result > 0);
    assert.equal(h.hash(h.restore(image).handle), before);
  } finally {
    h.dispose();
  }
});

test('K17-4: one thread falls back from pipelined, with the same frames', async () => {
  // The serial build has no pool; a one-slot arena has no ring on picovoxel/multi.
  for (const [entry, slots] of [
    [serialEntry, 4],
    [multiEntry, 1],
  ] as const) {
    const h = await harness(entry);
    try {
      const voxels = gyroid(h.pk);
      h.arena(slots, 64, 8, 0);
      const serial = fnv1a(h.park(voxels.handle, { block: 64 }).image);
      h.arena(slots, 64, 8, 2);
      const { result, image } = h.park(voxels.handle, { block: 64 });
      assert.ok(result > 0);
      assert.equal(fnv1a(image), serial);
      assert.equal(h.hash(h.restore(image).handle), voxels.gridHash().hash);
    } finally {
      h.dispose();
    }
  }
});

test('K17-5: 1,000 pipelined park and restore cycles keep the grid exact (native TSan run: not in this suite)', async () => {
  const h = await harness(multiEntry);
  try {
    h.arena(4, 8, 8, 2);
    const voxels = gyroid(h.pk, 6);
    const before = voxels.gridHash().hash;
    let handle = h.raw.Voxels_hCreateCopy(h.pk.handle, voxels.handle);
    for (let cycle = 0; cycle < 1000; cycle++) {
      const { result, image } = h.park(handle, { block: 8, flags: DESTRUCTIVE });
      assert.ok(result > 0, `cycle ${cycle}`);
      h.raw.Voxels_Destroy(h.pk.handle, handle);
      h.raw.K7_nRearm();
      handle = h.restore(image, 1 + (cycle % 5000)).handle;
      assert.notEqual(handle, 0n, `cycle ${cycle}`);
    }
    assert.equal(h.hash(handle), before);
  } finally {
    h.dispose();
  }
});

// ── Failure paths of the park TU, on the serial build ───────────────────────

/** XXH32 (seed = the image magic), so a test can forge frames whose checksum passes. */
function xxh32(bytes: Uint8Array, seed = 0x374b5650): number {
  const P1 = 0x9e3779b1;
  const P2 = 0x85ebca77;
  const P3 = 0xc2b2ae3d;
  const P4 = 0x27d4eb2f;
  const P5 = 0x165667b1;
  const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const round = (acc: number, lane: number) =>
    Math.imul(rotl((acc + Math.imul(lane, P2)) >>> 0, 13), P1) >>> 0;
  let at = 0;
  let h: number;
  if (bytes.length >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    for (; at + 16 <= bytes.length; at += 16) {
      v1 = round(v1, view.getUint32(at, true));
      v2 = round(v2, view.getUint32(at + 4, true));
      v3 = round(v3, view.getUint32(at + 8, true));
      v4 = round(v4, view.getUint32(at + 12, true));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }
  h = (h + bytes.length) >>> 0;
  for (; at + 4 <= bytes.length; at += 4)
    h = Math.imul(rotl((h + Math.imul(view.getUint32(at, true), P3)) >>> 0, 17), P4) >>> 0;
  for (; at < bytes.length; at++) h = Math.imul(rotl((h + Math.imul(bytes[at]!, P5)) >>> 0, 11), P1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), P2) >>> 0;
  h = Math.imul(h ^ (h >>> 13), P3) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The frames of an image: offset of each 16-byte frame header, its kind and its payload. */
function framesOf(image: Uint8Array): { at: number; kind: number; payload: Uint8Array }[] {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const out = [];
  for (let at = 0; at < image.length; ) {
    const comp = view.getUint32(at + 8, true);
    out.push({ at, kind: view.getUint32(at, true), payload: image.subarray(at + 16, at + 16 + comp) });
    at += 16 + comp;
  }
  return out;
}

/** Re-seals a frame after its payload was edited, so only the decoder can notice. */
function reseal(image: Uint8Array, frame: { at: number; payload: Uint8Array }): void {
  new DataView(image.buffer, image.byteOffset).setUint32(frame.at + 12, xxh32(frame.payload), true);
}

test('the forged-checksum helper matches the TU: an untouched image re-sealed restores', async () => {
  const h = await harness(serialEntry);
  try {
    const voxels = gyroid(h.pk, 8);
    const { image } = h.park(voxels.handle, { block: 16 });
    const frames = framesOf(image);
    for (const frame of frames) reseal(image, frame);
    assert.ok(frames.some((f) => f.kind === 1));
    const { handle } = h.restore(image);
    assert.equal(h.hash(handle), voxels.gridHash().hash);
  } finally {
    h.dispose();
  }
});

test('frames that pass the checksum but do not decode fail the restore as "other", never a trap', async () => {
  const h = await harness(serialEntry);
  try {
    const voxels = gyroid(h.pk, 10);
    for (const mode of [0, 1] as const) {
      h.arena(2, 16, 8, mode);
      const { image } = h.park(voxels.handle, { block: 16 });
      const frames = framesOf(image);
      // An unsupported codec in a well-sealed header fails the slot configuration.
      const header = image.slice();
      const head = framesOf(header)[0]!;
      new DataView(header.buffer).setInt32(head.at + 16 + 8, 9, true);
      reseal(header, head);
      assert.deepEqual(Object.values(h.restore(header)), [0n, 2], 'codec 9');
      // A sealed header that counts one leaf more than the topology holds.
      const counted = image.slice();
      const countedHead = framesOf(counted)[0]!;
      const leaves = new DataView(counted.buffer).getBigUint64(countedHead.at + 16 + 24, true);
      new DataView(counted.buffer).setBigUint64(countedHead.at + 16 + 24, leaves + 1n, true);
      reseal(counted, countedHead);
      assert.deepEqual(Object.values(h.restore(counted)), [0n, 2], 'leaf count');
      // A truncated topology frame ends the topology stream early.
      const topology = frames.find((f) => f.kind === 0)!;
      assert.deepEqual(Object.values(h.restore(image.slice(0, topology.at + 20))), [0n, 2], 'cut topology');
      // Leaf frames: each byte position edited and re-sealed, at the start, middle and end of
      // the payload, so the block header, a leaf and the trailer are each found wanting.
      const leaf = frames.filter((f) => f.kind === 1).at(-1)!;
      const length = leaf.payload.length;
      for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, Math.floor(length / 2), length - 2, length - 1]) {
        for (const value of [0x00, 0xff, 0x80]) {
          const bad = image.slice();
          const frame = framesOf(bad).find((f) => f.at === leaf.at)!;
          if (frame.payload[offset] === value) continue;
          frame.payload[offset] = value;
          reseal(bad, frame);
          const { handle, lastError } = h.restore(bad);
          if (handle) {
            h.raw.Voxels_Destroy(h.pk.handle, handle); // an edit the codec cannot see restores a different grid
          } else {
            assert.equal(lastError, 2, `offset ${offset} value ${value}`);
          }
        }
      }
    }
    // Stored (codec none) leaf block with one aux byte more than its leaves read: every leaf
    // decodes, and the block's end check finds the byte left over.
    h.arena(2, 16, 8, 0);
    const stored = h.park(voxels.handle, { block: 16, codec: 0 }).image;
    const last = framesOf(stored)
      .filter((f) => f.kind === 1)
      .at(-1)!;
    const payload = new Uint8Array(last.payload.length + 1);
    payload.set(last.payload);
    const payloadView = new DataView(payload.buffer);
    payloadView.setUint32(4, payloadView.getUint32(4, true) + 1, true);
    const longer = new Uint8Array(stored.length + 1);
    longer.set(stored.subarray(0, last.at + 16));
    longer.set(payload, last.at + 16);
    longer.set(stored.subarray(last.at + 16 + last.payload.length), last.at + 16 + payload.length);
    const view = new DataView(longer.buffer);
    view.setUint32(last.at + 4, view.getUint32(last.at + 4, true), true);
    view.setUint32(last.at + 8, payload.length, true);
    view.setUint32(last.at + 12, xxh32(payload), true);
    assert.deepEqual(Object.values(h.restore(longer)), [0n, 2], 'a byte left over');
    assert.ok(voxels.volume > 0, 'the source grid is untouched');
  } finally {
    h.dispose();
  }
});

test('park failures: a sink that fails after leaves were freed is -3; a bad handle is -1; block 0 is the default', async () => {
  const h = await harness(serialEntry);
  try {
    h.arena(4, 16, 8, 0);
    const voxels = gyroid(h.pk, 10);
    const copy = h.raw.Voxels_hCreateCopy(h.pk.handle, voxels.handle);
    const failed = h.park(copy, { block: 16, flags: DESTRUCTIVE, failAfter: 12, failWith: 1 });
    assert.deepEqual([failed.result, failed.lastError], [-3, 1], 'destructive park stopped by a full store');
    h.raw.Voxels_Destroy(h.pk.handle, copy);
    const other = h.park(voxels.handle, { block: 16, failAfter: 3, failWith: 2 });
    assert.deepEqual([other.result, other.lastError], [-1, 2], 'non-destructive park, store I/O failure');
    const bogus = h.park(987654321n, { block: 16 });
    assert.deepEqual([bogus.result, bogus.lastError], [-1, 2], 'an unknown handle');
    // Blocks above 65536 leaves (restore's limit) are refused before anything is sized from them.
    const huge = h.park(voxels.handle, { block: 2_097_152 });
    assert.deepEqual([huge.result, huge.lastError], [-1, 2], 'a block too large to size');
    assert.equal(h.arena(1, 65_537, 8, 0), -1, 'an arena block too large');
    assert.equal(h.arena(65, 16, 8, 0), -1, 'more than 64 slots');
    assert.ok(h.park(voxels.handle, { block: 16 }).result > 0, 'a refused arena leaves the arena as it was');
    const byDefault = h.park(voxels.handle, { block: 0 });
    assert.ok(byDefault.result > 0);
    assert.equal(
      new DataView(byDefault.image.buffer).getInt32(16 + 16, true),
      512,
      'block 0 parks in blocks of 512',
    );
    const restored = h.restore(byDefault.image);
    assert.equal(h.hash(restored.handle), voxels.gridHash().hash);
    const { handle, lastError } = (() => {
      const bad = h.raw.K7_hRestore(987654321n, 0);
      return { handle: bad, lastError: h.raw.K7_nLastError() };
    })();
    assert.deepEqual([handle, lastError], [0n, 2], 'an unknown Library instance');
  } finally {
    h.dispose();
  }
});

test('no heap but a hole: the slot table fits, a slot’s buffers do not, and nothing is left held', async () => {
  const h = await harness(serialEntry);
  try {
    const { module } = h.pk;
    const held: number[] = [];
    try {
      for (const size of [64 << 20, 1 << 20, 64 << 10, 1 << 10, 64, 16]) {
        for (let pointer = module._malloc(size); pointer !== 0; pointer = module._malloc(size))
          held.push(pointer);
      }
      module._free(held.shift()!); // the largest block: room for the slot table and a context, not
      // for a 65536-leaf slot's 128 MiB value buffer
      assert.equal(h.arena(4, 65_536, 0, 0), -2);
      const again = module._malloc(1 << 19);
      assert.notEqual(again, 0, 'the failed arena gave back what it took');
      module._free(again);
    } finally {
      for (const pointer of held) module._free(pointer);
    }
  } finally {
    h.dispose();
  }
});

test('no heap: the arena, a park and a restore outside the arena are out of memory; a restore runs out mid-leaves', async () => {
  const h = await harness(serialEntry);
  try {
    const voxels = gyroid(h.pk);
    h.arena(1, 512, 0, 0);
    const { image } = h.park(voxels.handle, { block: 64 }); // block 64: not the arena's, so a local slot
    const before = voxels.gridHash().hash;
    withExhaustedHeap(h.pk, () => {
      assert.equal(h.arena(4, 4096, 0, 0), -2, 'arena slots do not fit');
    });
    // The failed arena gave back the one it replaced: fill that too, so nothing fits now.
    withExhaustedHeap(h.pk, () => {
      assert.equal(h.arena(64, 512, 0, 0), -2, 'not even the 64-slot table fits');
      const park = h.park(voxels.handle, { block: 64 });
      assert.deepEqual([park.result, park.lastError], [-2, 1], 'the local slot does not fit');
      assert.deepEqual(Object.values(h.restore(image)), [0n, 1], 'the restore slot does not fit');
    });
    assert.equal(voxels.gridHash().hash, before);
    // With the slot in the arena and memory for the topology only, the leaf values run out part way.
    h.arena(4, 64, 0, 0);
    const { module } = h.pk;
    let outOfMemory = 0;
    let restored = 0;
    // Give back a growing number of bytes, smallest blocks first, until a restore succeeds.
    for (let target = 64 << 10; restored === 0 && target < 2 ** 31; target = Math.ceil(target * 1.25)) {
      const held: [number, number][] = [];
      try {
        for (const size of [64 << 20, 1 << 20, 64 << 10, 1 << 10]) {
          for (let pointer = module._malloc(size); pointer !== 0; pointer = module._malloc(size))
            held.push([pointer, size]);
        }
        for (let freed = 0; freed < target && held.length > 0; ) {
          const [pointer, size] = held.pop()!;
          module._free(pointer);
          freed += size;
        }
        const { handle, lastError } = h.restore(image);
        if (handle) {
          h.raw.Voxels_Destroy(h.pk.handle, handle);
          restored++;
        } else {
          assert.equal(lastError, 1);
          outOfMemory++;
        }
      } finally {
        for (const [pointer] of held) module._free(pointer);
      }
    }
    assert.ok(
      outOfMemory > 0 && restored === 1,
      `${outOfMemory} restores ran out of memory before one fitted`,
    );
    assert.equal(h.hash(h.restore(image).handle), before, 'and with memory back the image restores');
  } finally {
    h.dispose();
  }
});
