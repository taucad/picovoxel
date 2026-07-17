import { defineConfig } from 'vitest/config';

// Normative shape per the quality-infrastructure doc: forks pool so the GC-integration
// suite gets --expose-gc (harmless where unused); coverage thresholds are staged here
// and enforced from R24 on ("test" script gains --coverage then).
// vitest 4 note: execArgv is a top-level test option now (poolOptions was vitest 3).
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,mjs}'],
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/picogk.mjs', 'src/raw.generated.ts'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      reporter: ['text', 'lcov'],
    },
  },
});
