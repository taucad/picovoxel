// Shared test utilities (disposal-facade doc, test strategy).

import type { SdfExpression } from '../src/index.ts';
import type { Held, HandleRegistry } from '../src/registry.ts';

export interface FakeRegistry extends HandleRegistry {
  /** Every live registration, keyed by token. */
  entries: Map<object, { wrapper: object; held: Held }>;
  registered: number;
  unregistered: number;
  /** Drives the GC callback by hand for a token, as a collection would. */
  collect(token: object): void;
}

/** Recorder registry — proves D1–D6 with zero GC involvement. */
export function createFakeRegistry(onFree: (held: Held) => void = (held) => held.free(held.lib, held.handle)): FakeRegistry {
  const fake: FakeRegistry = {
    entries: new Map(),
    registered: 0,
    unregistered: 0,
    register(wrapper, held, token) {
      fake.registered += 1;
      fake.entries.set(token, { wrapper, held });
    },
    unregister(token) {
      fake.unregistered += 1;
      return fake.entries.delete(token);
    },
    collect(token) {
      const entry = fake.entries.get(token);
      if (!entry) throw new Error('collect() on a token that is not registered');
      fake.entries.delete(token);
      onFree(entry.held);
    },
  };
  return fake;
}

/** Order-sensitive 32-bit FNV-1a over the underlying bytes — the exactness oracle. */
export function fnv1a(typedArray: Float32Array | Uint32Array | Uint8Array): number {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Hex-float rendering (%a analogue) — volumes compare exactly, never "approximately". */
export function hexFloat(value: number): string {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  return buffer.getBigUint64(0).toString(16);
}

/**
 * Loops global.gc() until `predicate` holds (bounded). The counter-oracle pattern:
 * PicoGK's own allocation counters are the ground truth for "the handle was freed".
 */
export async function gcUntil(predicate: () => boolean, iterations = 50): Promise<boolean> {
  const gc = globalThis.gc;
  if (typeof gc !== 'function') throw new Error('gcUntil needs --expose-gc (vitest forks pool provides it)');
  for (let i = 0; i < iterations; i++) {
    if (predicate()) return true;
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

// The gyroid as a tape expression and as a JS callback — shared by tape.test.ts and
// multi.test.ts. It lives here, not in a test file: importing a test file
// re-registers its tests inside the importer.
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
