// R5 — the shim and registry-callback units (disposal-facade doc, test strategy).
// Wrapper-level invariants D1–D6 live in test/disposal.test.ts via the fake registry.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DISPOSE, ensureDisposeSymbol } from '../src/dispose.ts';
import { createHandleRegistry, freeHeld } from '../src/registry.ts';

test('shim branch: a symbol-less target gets the registry symbol', () => {
  const bare: { dispose?: symbol } = {};
  const got = ensureDisposeSymbol(bare);
  assert.equal(got, Symbol.for('Symbol.dispose'), 'polyfill must be the registered symbol (idempotent across copies)');
  assert.equal(bare.dispose, got, 'target must carry the assigned symbol');
});

test('native-wins branch: an existing symbol is returned untouched', () => {
  const native = Symbol('pretend-native-dispose');
  const target: { dispose?: symbol } = { dispose: native };
  assert.equal(ensureDisposeSymbol(target), native, '??= must not overwrite an existing symbol');
  assert.equal(target.dispose, native);
});

test('DISPOSE is the ambient Symbol.dispose after module load', () => {
  // On node 24 the native symbol exists, so the shim must have deferred to it.
  assert.equal(typeof Symbol.dispose, 'symbol', 'Symbol.dispose missing after importing the shim');
  assert.equal(DISPOSE, Symbol.dispose);
});

test('freeHeld frees exactly once with the held lib/handle', () => {
  const calls: Array<[bigint, bigint]> = [];
  freeHeld({ lib: 7n, handle: 42n, free: (lib, handle) => calls.push([lib, handle]) });
  assert.deepEqual(calls, [[7n, 42n]]);
});

test('freeHeld swallows a throwing free (late callback after session teardown)', () => {
  assert.doesNotThrow(() =>
    freeHeld({
      lib: 1n,
      handle: 2n,
      free: () => {
        throw new Error('instance already destroyed');
      },
    }),
  );
});

test('createHandleRegistry returns a real FinalizationRegistry satisfying the seam', () => {
  const registry = createHandleRegistry();
  assert.ok(registry instanceof FinalizationRegistry);
  const token = {};
  registry.register({}, { lib: 0n, handle: 0n, free: () => {} }, token);
  assert.equal(registry.unregister(token), true, 'unregister must find the registered token');
  assert.equal(registry.unregister(token), false, 'second unregister must be a no-op');
});
