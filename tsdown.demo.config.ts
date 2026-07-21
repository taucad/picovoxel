import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

// The demo pulls in the examples/, which import the package by name
// ('picovoxel/shapekernel', …). Resolve those self-references straight to the
// src entries so the whole page — core + examples — bundles from ONE source
// graph (no dist build, no dual-instance session-identity hazard).
const src = (rel: string) => fileURLToPath(new URL(`./src/${rel}`, import.meta.url));
const SELF_REFERENCE: Record<string, string> = {
  'picovoxel': src('index.ts'),
  'picovoxel/multi': src('multi.ts'),
  'picovoxel/three': src('three.ts'),
  'picovoxel/shapekernel': src('shapekernel.ts'),
  'picovoxel/latticelibrary': src('latticelibrary.ts'),
  'picovoxel/numerics': src('numerics.ts'),
  'picovoxel/raw': src('raw.ts'),
  'picovoxel/slicing': src('slicing.ts'),
};

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
      name: 'pico-self-reference',
      resolveId: (id: string) => SELF_REFERENCE[id] ?? null,
    },
    {
      // The glues must stay external AND resolve as siblings of the emitted bundle
      // (the copy below puts them there) — a source-relative path would escape outDir.
      name: 'glue-as-sibling',
      resolveId(id: string) {
        if (id.endsWith('pico-multi.mjs')) return { id: './pico-multi.mjs', external: true };
        return id.endsWith('pico.mjs') ? { id: './pico.mjs', external: true } : null;
      },
    },
  ],
  copy: [
    { from: 'src/pico.mjs', to: 'demo/dist' },
    { from: 'src/pico.wasm', to: 'demo/dist' },
    { from: 'src/pico-multi.mjs', to: 'demo/dist' },
    { from: 'src/pico-multi.wasm', to: 'demo/dist' },
  ],
});
