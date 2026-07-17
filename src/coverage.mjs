// R14 — Tier-2 coverage: binds every core export from the generated ABI manifest and
// records which ones actually get called.
//
// The point is that coverage is MEASURED against what upstream exports, not asserted
// in prose. A new upstream export appears here as an uncovered function; a renamed one
// fails to bind. Both are things a hand-maintained list would hide.

import abi from './abi.json' with { type: 'json' };
import createPicoGKModule from './picogk.mjs';

/** Binds all 140 core exports, counting calls per name. */
export async function loadInstrumented(options = {}) {
  const module = await createPicoGKModule(options);
  const calls = new Map();
  const fns = {};

  const core = abi.functions.filter((f) => !f.viewer);
  for (const fn of core) {
    // Callback-taking exports need addFunction, not a plain cwrap arg; bind them with
    // the pointer as a plain i32 and let callers supply the function-table index.
    const argTypes = fn.args.map((a) => (a.cwrap === null ? 'number' : a.cwrap));
    let bound;
    try {
      bound = module.cwrap(fn.name, fn.cwrapReturn, argTypes);
    } catch (error) {
      throw new Error(`coverage: failed to bind ${fn.name}(${argTypes.join(',')}): ${error.message}`);
    }
    calls.set(fn.name, 0);
    fns[fn.name] = (...args) => {
      calls.set(fn.name, calls.get(fn.name) + 1);
      return bound(...args);
    };
  }

  // The bulk TU's additions (R11 exports + R8 imports) are ours, not in upstream's
  // header — bind them explicitly so the gate covers them too.
  for (const [name, ret, args] of [
    ['Mesh_GetVertices', 'number', ['bigint', 'bigint', 'number', 'number']],
    ['Mesh_GetTriangles', 'number', ['bigint', 'bigint', 'number', 'number']],
    ['Mesh_AddVertices', 'number', ['bigint', 'bigint', 'number', 'number']],
    ['Mesh_AddTriangles', 'number', ['bigint', 'bigint', 'number', 'number']],
  ]) {
    const bound = module.cwrap(name, ret, args);
    calls.set(name, 0);
    fns[name] = (...a) => { calls.set(name, calls.get(name) + 1); return bound(...a); };
  }

  return {
    module,
    fns,
    abi: core,
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
