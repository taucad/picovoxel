import { defineConfig } from 'tsdown';

// ESM-only build (L12): one entry per subpath, .d.ts alongside. The Emscripten glue
// and wasm are COPIED assets, never bundled — the glue locates pico.wasm via
// import.meta.url, which bundling breaks. All entry chunks land at dist/ root, so
// the './pico.mjs' specifier keeps resolving after the copy.
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
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: false,
  deps: { neverBundle: [/pico(-multi)?\.mjs$/, 'three'] },
  copy: [
    { from: 'src/pico.mjs', to: 'dist' },
    { from: 'src/pico.wasm', to: 'dist' },
    { from: 'src/pico-multi.mjs', to: 'dist' },
    { from: 'src/pico-multi.wasm', to: 'dist' },
  ],
});
