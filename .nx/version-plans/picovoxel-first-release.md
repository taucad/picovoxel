---
picovoxel: minor
---

First release: the PicoGK voxel and implicit geometry kernel on OpenVDB, compiled to WebAssembly with Emscripten 5.0.1 behind a typed TypeScript API. `picovoxel` is the serial build and `picovoxel/multi` the pthreads build of the same API.

The other entries are `picovoxel/latticelibrary`, `picovoxel/numerics`, `picovoxel/raw`, `picovoxel/shapekernel`, `picovoxel/slicing` and `picovoxel/three`. Both wasm modules are built in CI from pinned sources, and the relocatable assets ship on their own subpaths (`picovoxel/wasm`, `picovoxel/glue`, `picovoxel/multi/wasm`, `picovoxel/multi/worker`) for hosts that supply `locateFile`, `mainScriptUrlOrBlob` or `instantiateWasm`. The package is ESM-only, and `require()` fails with an ESM-only diagnostic. It needs Node 22.14.0 or later, and the multi entry needs cross-origin isolation in browsers.

Every session has a lane. An `exact` session reproduces the reference results byte for byte, a `fast` session allows faster algorithms that change values slightly, and exports stamp or refuse fast-lane geometry as `docs/lanes.md` describes. Both builds are wasm32 with a 4 GiB heap. `compatibility.md` lists the supported hosts, each with its CI job, and the known issues.
