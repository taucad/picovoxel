# Changelog

Release entries are generated from Nx Version Plans. The first release is 0.1.0.

## 0.2.1 (2026-10-26)

### 🩹 Fixes

- Build with Emscripten 6.0.2, restore the wasmBinary and mainScriptUrlOrBlob overrides, and preserve runningWorkers as a live compatibility getter. Retain fixed-length memory buffers for browser TextDecoder compatibility. ([9204819](https://github.com/taucad/picovoxel/commit/9204819))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.2.0 (2026-10-25)

### 🚀 Features

- `voxels.toMesh({ adaptivity, relax })` meshes adaptively through OpenVDB: `adaptivity` in [0, 1) merges near-coplanar cells into fewer triangles, `relax` runs OpenVDB's relax pass on them, and both default off, so `toMesh()` writes the same bytes as before. An adaptive mesh is `fast`, and an exact-lane session refuses it. ([#33](https://github.com/taucad/picovoxel/pull/33))

  The offset family (`offset`, `doubleOffset`, `smoothen`, `fillet`, `shell`) takes an opt-in `fastSweeping: true`, a fast-sweeping offset engine whose result is `fast`; a fillet through it keeps every beam of the lattice it closes. `raycastBatch({ subVoxel: true })` returns hits at their fractional position instead of truncated to whole voxels.

  Faster with the same output: the tape fills hoist y-only and z-only work out of the voxel loop and square with `a*a`; `maskedByImplicit` evaluates only where the mask stores something; `properties()` measures once; contour stitching is linear; millimetre STL export skips the float32 transform chain; the adaptive merge in OpenVDB takes an exact fast path.

  Fixes: the multi-threaded entry refreshes its heap views after a worker grows memory; `mesh.vertices` and `mesh.triangles` return copies, so editing them no longer changes later exports; an empty mesh exports as a valid GLB; out-of-range mesh indices throw instead of storing a dangling index; a scalar field built from voxels holds only the requested value; a zero-length flat-capped lattice beam renders nothing instead of NaN. A native allocation that fails at the 4 GiB heap limit throws `PICO_OUT_OF_MEMORY` instead of `PICO_INVALID_HANDLE`.

### ❤️ Thank You

- Richard Fontein @rifont

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
