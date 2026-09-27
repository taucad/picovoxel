// R14 — Tier-2 coverage: wraps the GENERATED raw layer (R9) and records which
// bindings actually get called.
//
// The point is that coverage is MEASURED against what upstream exports, not asserted
// in prose. A new upstream export appears here as an uncovered function; a renamed one
// fails to bind. Both are things a hand-maintained list would hide. Routing through
// raw.generated.ts means the gate also proves every generated binding is callable.

import { bindPicoRaw, loadPicoRaw } from '../src/raw.ts';

// PICOVOXEL_R14_ARTIFACT=multi runs the same gate against the pthread artifact
// (CI runs both; the ABI is shared, so both must reach every export).
const loadRaw = async (options) => {
  if (process.env.PICOVOXEL_R14_ARTIFACT !== 'multi') return loadPicoRaw(options);
  const { default: createPicoMultiModule } = await import('../src/pico-multi.mjs');
  const module = await createPicoMultiModule(options);
  if (!(module.HEAPU8.buffer instanceof SharedArrayBuffer))
    throw new Error('R14: expected the pthread artifact');
  return { module, raw: bindPicoRaw(module) };
};

/** Binds all 152 exports (140 core + 12 own-TU), counting calls per name. */
export async function loadInstrumented(options = {}) {
  const { module, raw } = await loadRaw(options);
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
