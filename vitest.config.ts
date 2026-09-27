import { defineConfig } from 'vitest/config';

// The forks pool gives the GC-integration suite --expose-gc (harmless where
// unused). vitest 4: execArgv is a top-level test option (poolOptions was vitest 3).
export default defineConfig({
  test: {
    include: [
      'test/**/*.test.{ts,mjs}',
      'prose-quality.test.ts',
      'readme-shape.test.ts',
      'docs-links.test.ts',
    ],
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      // The measured domain: everything that ships, plus the pure-logic modules
      // the gates rely on (the raw-binding generator, benchmark statistics and
      // the identity record math).
      include: [
        'src/**/*.ts',
        'scripts/generate-raw.mjs',
        'bench/stats.mjs',
        'bench/g0-compare.mjs',
        'bench/stl-multiset.mjs',
      ],
      // Audited exclusions, each with its reason:
      exclude: [
        // Generated from src/abi.json; test/generate-raw.test.ts holds it
        // byte-equal to the generator, and R14 calls every binding.
        'src/raw.generated.ts',
        // Pure re-export barrels with no statements of their own (they would
        // report 0/0); test/barrels.test.ts proves every binding they export.
        'src/latticelibrary.ts',
        'src/numerics.ts',
        'src/shapekernel.ts',
      ],
      // Not measured by design, and exercised as whole processes instead: the
      // browser gate (scripts/browser-gate.mjs, the `browser` CI job), the
      // benchmark driver and drift canary (bench/run.mjs, bench/check-drift.mjs,
      // bench.yml), and the geometry drivers of the identity harness
      // (bench/g0-identity.mjs, bench/stl-identity.mjs; g0Record runs in
      // test/g0-gate.test.ts).
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ['text', 'lcov'],
    },
  },
});
