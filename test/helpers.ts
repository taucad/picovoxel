// Shared test utilities (disposal-facade doc, test strategy).

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
