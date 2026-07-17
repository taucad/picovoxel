# picogk-js

[PicoGK](https://github.com/leap71/PicoGK) — voxel/implicit computational geometry on OpenVDB — compiled to WebAssembly, with an idiomatic TypeScript API.

> **Status: pre-release.** The wasm core is proven (byte-identical differential conformance against the native library); the TypeScript surface is under construction. See `docs` in the parent research tree for the charter.

## Quickstart

```js
import { createPicoGK } from 'picogk-js';

const picogk = await createPicoGK({ voxelSize: 0.5 });
const sphere = picogk.createVoxels({ shape: 'sphere', radius: 10 });
const mesh = sphere.toMesh();
console.log(mesh.triangleCount);
picogk.dispose();
```

No per-object cleanup is required — wrappers are reclaimed by the garbage collector. `session.dispose()` is the deterministic teardown.

## License

Apache-2.0, matching upstream PicoGK, whose compiled runtime this package embeds.
