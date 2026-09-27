// C++ coverage flush (close-out T3.1/D8), active only when vitest.config.ts sees
// PICOVOXEL_CPP_COVERAGE_DIR and src/pico.mjs is a COVERAGE=1 build. The module is a
// library (no main, EXIT_RUNTIME=0), so the profile runtime's atexit writer never
// runs; instead, after each test file, every instance scripts/coverage-post.js
// registered writes its raw profile into its own heap and the bytes go to disk as
// one .profraw per instance (vitest isolates files in forks, so a fork's instances
// are exactly one file's). Only instrumented glues register; the multi glue does
// too when built with THREADS=1 COVERAGE=1, and its counters include every pthread's
// increments because they live in the shared heap. llvm-profdata merges them.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';

interface CoverageModule {
  ___llvm_profile_get_size_for_buffer: () => bigint;
  ___llvm_profile_write_buffer: (pointer: number) => number;
  _malloc: (size: number) => number;
  _free: (pointer: number) => void;
  HEAPU8: Uint8Array;
}

const directory = process.env.PICOVOXEL_CPP_COVERAGE_DIR as string;
const registry = ((globalThis as { __picovoxelCoverageModules?: CoverageModule[] }).__picovoxelCoverageModules ??= []);

afterAll(() => {
  mkdirSync(directory, { recursive: true });
  const batch = randomUUID();
  for (const [index, module] of registry.splice(0).entries()) {
    const size = Number(module.___llvm_profile_get_size_for_buffer());
    const pointer = module._malloc(size);
    const status = module.___llvm_profile_write_buffer(pointer);
    if (status !== 0) throw new Error(`__llvm_profile_write_buffer returned ${status}`);
    writeFileSync(join(directory, `${batch}-${index}.profraw`), module.HEAPU8.slice(pointer, pointer + size));
    module._free(pointer);
  }
});
