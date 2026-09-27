---
picovoxel: patch
---

`createPico({ wasm })` and `createPicoRuntime({ wasm })` on both entries accept the exported `PicoWasmOverrides` type (`locateFile`, `mainScriptUrlOrBlob`, `instantiateWasm`, `wasmBinary`), so the documented forms typecheck under strict TypeScript and a misspelt key is a compile error.
