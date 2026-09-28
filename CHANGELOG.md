# Changelog

Release entries are generated from Nx Version Plans. The first release is 0.1.0.

## 0.1.0 (2026-09-28)

### 🚀 Features

- First release: the PicoGK voxel and implicit geometry kernel on OpenVDB, compiled to WebAssembly with Emscripten 5.0.1 behind a typed TypeScript API. `picovoxel` is the serial build and `picovoxel/multi` the pthreads build of the same API. ([#8](https://github.com/taucad/picovoxel/pull/8))

  The other entries are `picovoxel/latticelibrary`, `picovoxel/numerics`, `picovoxel/raw`, `picovoxel/shapekernel`, `picovoxel/slicing` and `picovoxel/three`. Both wasm modules are built in CI from pinned sources, and the relocatable assets ship on their own subpaths (`picovoxel/wasm`, `picovoxel/glue`, `picovoxel/multi/wasm`, `picovoxel/multi/worker`) for hosts that supply `locateFile`, `mainScriptUrlOrBlob` or `instantiateWasm`. The package is ESM-only, and `require()` fails with an ESM-only diagnostic. It needs Node 22.14.0 or later, and the multi entry needs cross-origin isolation in browsers.

  Every session has a lane. An `exact` session reproduces the reference results byte for byte, a `fast` session allows faster algorithms that change values slightly, and exports stamp or refuse fast-lane geometry as `docs/lanes.md` describes. Both builds are wasm32 with a 4 GiB heap. `compatibility.md` lists the supported hosts, each with its CI job, and the known issues.

- `Mesh.measure()` returns a mesh's enclosed volume and surface area, integrated over its triangles with no voxels involved. The area is the sum ShapeKernel's `Measure.fGetSurfaceArea(Mesh)` computes; the volume is new. Use `voxels.toMesh().measure()` to cross-check `Voxels.properties()`, which fills a sealed cavity, or one whose openings are about two voxels wide or narrower, as PicoGK's `CalculateProperties` does; [memory and limits](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md#known-limits) describes the limitation. ([#19](https://github.com/taucad/picovoxel/pull/19))

### 🩹 Fixes

- `createPico({ wasm })` and `createPicoRuntime({ wasm })` on both entries accept the exported `PicoWasmOverrides` type (`locateFile`, `mainScriptUrlOrBlob`, `instantiateWasm`, `wasmBinary`), so the documented forms typecheck under strict TypeScript and a misspelt key is a compile error. ([#22](https://github.com/taucad/picovoxel/pull/22))

### ❤️ Thank You

- Richard Fontein @rifont
