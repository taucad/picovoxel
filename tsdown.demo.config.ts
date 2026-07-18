import { defineConfig } from 'tsdown';

// Bundles the demo page module (demo/main.ts) with the wasm pair beside it —
// same shape as tsdown.gate.config.ts, plus three (a peerDependency, so
// auto-external for library builds) bundled in because the page has no resolver.
export default defineConfig({
  entry: { main: 'demo/main.ts' },
  outDir: 'demo/dist',
  format: 'esm',
  platform: 'neutral',
  dts: false,
  exports: false,
  deps: { alwaysBundle: [/^three/] },
  plugins: [
    {
      // The glues must stay external AND resolve as siblings of the emitted bundle
      // (the copy below puts them there) — a source-relative path would escape outDir.
      name: 'glue-as-sibling',
      resolveId(id: string) {
        if (id.endsWith('picogk-multi.mjs')) return { id: './picogk-multi.mjs', external: true };
        return id.endsWith('picogk.mjs') ? { id: './picogk.mjs', external: true } : null;
      },
    },
  ],
  copy: [
    { from: 'src/picogk.mjs', to: 'demo/dist' },
    { from: 'src/picogk.wasm', to: 'demo/dist' },
    { from: 'src/picogk-multi.mjs', to: 'demo/dist' },
    { from: 'src/picogk-multi.wasm', to: 'demo/dist' },
  ],
});
