// R14 — Tier-2 coverage: wraps the GENERATED raw layer (R9) and records which
// bindings actually get called.
//
// The point is that coverage is MEASURED against what upstream exports, not asserted
// in prose. A new upstream export appears here as an uncovered function; a renamed one
// fails to bind. Both are things a hand-maintained list would hide. Routing through
// raw.generated.ts means the gate also proves every generated binding is callable.

import { loadPicoGkRaw } from '../src/raw.ts';

/** Binds all 144 exports (140 core + 4 bulk TU), counting calls per name. */
export async function loadInstrumented(options = {}) {
  const { module, raw } = await loadPicoGkRaw(options);
  const calls = new Map();
  const fns = {};

  for (const [name, bound] of Object.entries(raw)) {
    calls.set(name, 0);
    fns[name] = (...args) => {
      calls.set(name, calls.get(name) + 1);
      return bound(...args);
    };
  }

  return {
    module,
    fns,
    /** Names never called — the coverage gap, listed rather than counted. */
    uncovered: () => [...calls.entries()].filter(([, n]) => n === 0).map(([name]) => name),
    covered: () => [...calls.entries()].filter(([, n]) => n > 0).length,
    total: calls.size,
    report() {
      const missing = this.uncovered();
      const byFamily = {};
      for (const name of missing) {
        const family = name.split('_')[0];
        (byFamily[family] ??= []).push(name);
      }
      return { covered: this.covered(), total: this.total, missing, byFamily };
    },
  };
}
