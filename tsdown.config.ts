import { defineConfig } from 'tsdown';

// ESM-only build (L12): one entry per subpath, .d.ts alongside. The Emscripten glue
// and wasm are COPIED assets, never bundled — the glue locates picogk.wasm via
// import.meta.url, which bundling breaks. All entry chunks land at dist/ root, so
// the './picogk.mjs' specifier keeps resolving after the copy.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    raw: 'src/raw.mjs',
    slicing: 'src/slicing.ts',
    three: 'src/three.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  exports: false,
  deps: { neverBundle: [/picogk\.mjs$/, 'three'] },
  copy: [
    { from: 'src/picogk.mjs', to: 'dist' },
    { from: 'src/picogk.wasm', to: 'dist' },
  ],
});
