import { defineConfig } from 'tsdown';

// ESM-only build (L12): one entry per subpath, unbundled so every source module
// keeps a stable, unhashed .js/.d.ts name, minified, with declarations from the
// build tsconfig. `platform: 'neutral'` keeps the .js/.d.ts extensions consumers
// and Tau's type extractor read. The Emscripten glue and wasm are COPIED assets,
// never bundled: the glue locates its wasm and pthread script via
// import.meta.url, which bundling breaks. The three modules that import a glue
// (index, multi, raw) sit at the src/ root, so unbundling emits them at the dist/
// root beside the copies and the './pico.mjs' specifier keeps resolving.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    latticelibrary: 'src/latticelibrary.ts',
    multi: 'src/multi.ts',
    numerics: 'src/numerics.ts',
    raw: 'src/raw.ts',
    shapekernel: 'src/shapekernel.ts',
    slicing: 'src/slicing.ts',
    three: 'src/three.ts',
    // Own entry so dist/dispose.js exists at a stable path package.json's
    // sideEffects list can name — the shim must survive tree shaking.
    dispose: 'src/dispose.ts',
  },
  clean: true,
  format: 'esm',
  platform: 'neutral',
  unbundle: true,
  minify: true,
  sourcemap: false,
  dts: true,
  tsconfig: 'tsconfig.build.json',
  exports: false,
  // The build is the circular-import check: a runtime import cycle fails it.
  // Declaration graphs may cycle (type-only imports are erased), so those
  // reports are dropped before failOnWarn applies.
  checks: { circularDependency: true, pluginTimings: false },
  failOnWarn: true,
  suppressWarnings: /Circular dependency: \S+\.d\.ts /,
  // package.json#sideEffects names the dist path; rolldown would read it as
  // making src/dispose.ts side-effect-free and drop the entries' shim import.
  treeshake: { moduleSideEffects: (id) => id.endsWith('/src/dispose.ts') || undefined },
  deps: { neverBundle: [/pico(-multi)?\.mjs$/, 'three'] },
  copy: [
    { from: 'src/pico.mjs', to: 'dist' },
    { from: 'src/pico.wasm', to: 'dist' },
    { from: 'src/pico-multi.mjs', to: 'dist' },
    { from: 'src/pico-multi.wasm', to: 'dist' },
    // The `require` export condition: a clear ESM-only diagnostic, ahead of
    // `default`, so require(esm) on Node >=22.12 never loads the graph silently,
    // and `never` types so a CommonJS TypeScript consumer fails to compile.
    { from: 'src/cjs-error.cjs', to: 'dist' },
    { from: 'src/cjs-error.d.cts', to: 'dist' },
  ],
});
