---
picovoxel: patch
---

`createPico({ wasm })` and `createPicoRuntime({ wasm })` type their Emscripten overrides as the exported `PicoWasmOverrides` (`locateFile`, `mainScriptUrlOrBlob`, `instantiateWasm`, `wasmBinary`) instead of `object`, so the documented forms typecheck under strict TypeScript and a misspelt key is a compile error.
