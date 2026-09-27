---
picovoxel: minor
---

First release: `picovoxel` 0.1.0, the PicoGK voxel and implicit geometry kernel on OpenVDB compiled to WebAssembly with Emscripten 5.0.1, behind a typed TypeScript API. `picovoxel` is the serial build and `picovoxel/multi` the pthreads build of the same surface, with `picovoxel/latticelibrary`, `picovoxel/numerics`, `picovoxel/raw`, `picovoxel/shapekernel`, `picovoxel/slicing` and `picovoxel/three` beside them. Both wasm artifacts are built in CI from pinned sources, and the relocatable assets ship on their own subpaths (`picovoxel/wasm`, `picovoxel/glue`, `picovoxel/multi/wasm`, `picovoxel/multi/worker`) for hosts that supply `locateFile`, `mainScriptUrlOrBlob` or `instantiateWasm`. The package is ESM-only, and `require()` fails with an ESM-only diagnostic. It needs Node 22.14.0 or later, and the multi entry needs cross-origin isolation in browsers.
