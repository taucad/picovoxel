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

## Memory

PicoGK's data lives in WebAssembly memory (up to 4 GB), which the JavaScript garbage
collector cannot see — a 100-byte wrapper can pin a multi-hundred-MB voxel grid.
picogk-js handles this for you:

- **Ordinary use needs no cleanup.** Every wrapper is registered with a
  `FinalizationRegistry`; when it is collected, its native handle is freed.
  Fluent chains (`a.union(b).subtract(c)`) drop intermediates immediately and
  minor GC cycles reclaim them.
- **`session.dispose()` frees everything at once** — the deterministic teardown.
  "Create session → work → dispose session" is the complete story.
- **`dispose()` exists on every object** for tight loops and power users; it is
  idempotent and optional. `using` works too — picogk-js self-shims
  `Symbol.dispose` on engines that lack it (Safari 16.4–18.3).
- **A one-time warning** fires if PicoGK-owned memory crosses 1 GiB
  (`createPicoGK({ memoryWarningBytes })` to raise or `0` to disable) — the GC has
  no idea native memory is piling up, so we refuse to fail silently at 4 GB.

## License

Apache-2.0, matching upstream PicoGK, whose compiled runtime this package embeds.
