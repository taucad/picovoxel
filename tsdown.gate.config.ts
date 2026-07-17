import { defineConfig } from 'tsdown';

// Bundles the browser-gate page module (test/browser/gate.ts) with the wasm pair
// beside it, mirroring the main build's copied-asset rule.
export default defineConfig({
  entry: { gate: 'test/browser/gate.ts' },
  outDir: 'test/browser/gate-dist',
  format: 'esm',
  platform: 'neutral',
  dts: false,
  exports: false,
  plugins: [
    {
      // The glue must stay external AND resolve as a sibling of the emitted bundle
      // (the copy below puts it there) — a source-relative path would escape outDir.
      name: 'glue-as-sibling',
      resolveId(id: string) {
        return id.endsWith('picogk.mjs') ? { id: './picogk.mjs', external: true } : null;
      },
    },
  ],
  copy: [
    { from: 'src/picogk.mjs', to: 'test/browser/gate-dist' },
    { from: 'src/picogk.wasm', to: 'test/browser/gate-dist' },
  ],
});
