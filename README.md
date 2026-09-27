<img src="assets/logo.svg" alt="" width="88" height="88" />

# picovoxel

[PicoGK](https://github.com/leap71/PicoGK) — the voxel/implicit computational-geometry kernel on OpenVDB — compiled to WebAssembly, with an idiomatic TypeScript API. Runs in the browser and in node from a single 5.8 MB wasm module.

> ⚠️ **Unofficial & community-maintained.** `picovoxel` is an independent project — **not** affiliated with, endorsed by, or supported by LEAP 71. It binds the open-source PicoGK runtime (compiled, unmodified, to WebAssembly), but the API, packaging, and package name (`picovoxel`, not `picogk`) are ours. Please file issues [on this repo](https://github.com/taucad/picovoxel/issues), not with the PicoGK team.

```js
import { createPico } from 'picovoxel';

const pico = await createPico({ voxelSize: 0.5 });
const sphere = pico.createVoxels({ shape: 'sphere', radius: 10 });
const gyroid = sphere.maskedByImplicit({
  sdf: (x, y, z) =>
    Math.abs(Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x)) - 0.4,
});
const stl = gyroid.toMesh().toStl();   // binary STL bytes, ready to download
pico.dispose();
```

No cleanup calls in sight — that is the API contract, not an oversight (see [Memory](#memory)).

## What you get

- **The full non-viewer PicoGK surface**: voxel CSG (`union`/`subtract`/`intersect`), the offset design vocabulary (`offset`, `doubleOffset`, `smoothen`, `fillet`, `shell`, `trim`), implicit rendering and masking from plain JS SDF callbacks, meshes with bulk transfer, STL/GLB/VDB IO, lattices, polylines, scalar/vector fields, and field metadata.
- **`picovoxel/slicing`** — marching-squares vectorization of voxel slices to closed contours, SVG, and ASCII CLI (Common Layer Interface) for LPBF/SLS printers.
- **`picovoxel/three`** — `toBufferGeometry` / `meshFromBufferGeometry` bridges (`three` is an optional peer dependency).
- **`picovoxel/raw`** — the generated, typed binding for all 140 core C-ABI exports, for when you need the escape hatch.

## Browser and node

Two entries share one API: `picovoxel` is the serial build and `picovoxel/multi` is the pthreads build, so switching is a one-specifier change. Node needs 22.14.0 or later.

- **Node**: both entries work with no configuration. The multi entry spawns its pool with `worker_threads`, and idle pool workers never keep the process alive.
- **Browser, serial**: serve `pico.wasm` next to `pico.mjs` with `Content-Type: application/wasm`. No COOP/COEP headers are needed.
- **Browser, multi**: the shared wasm memory needs `SharedArrayBuffer`, so the page must be cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). `pico-multi.mjs` is also the module script of every pthread worker, so serve it and `pico-multi.wasm` from the same origin. `createPico` starts one worker per `navigator.hardwareConcurrency` before it resolves.

The relocatable assets have their own subpaths, so a host can resolve, copy or precompile them:

| Subpath | File | Loaded by |
| --- | --- | --- |
| `picovoxel/wasm` | `dist/pico.wasm` | the serial glue |
| `picovoxel/glue` | `dist/pico.mjs` | `picovoxel` (static import) |
| `picovoxel/multi/wasm` | `dist/pico-multi.wasm` | the pthreads glue |
| `picovoxel/multi/worker` | `dist/pico-multi.mjs` | `picovoxel/multi` and every pthread worker |

**Bundlers**: each glue finds its wasm, and the multi glue finds its worker script, with `new URL(file, import.meta.url)`. A bundler that emits those files as siblings needs nothing more. Otherwise pass Emscripten overrides through `createPico({ wasm })`:

```js
import { createPico } from 'picovoxel';

// Serial: tell the glue where the wasm lives.
const pico = await createPico({
  wasm: { locateFile: () => import.meta.resolve('picovoxel/wasm') },
});
```

```js
import { createPico } from 'picovoxel/multi';

// Multi: compile once, reuse the module for every session, and name the worker script.
const module = await WebAssembly.compileStreaming(fetch(import.meta.resolve('picovoxel/multi/wasm')));
const pico = await createPico({
  wasm: {
    // In Node this must be a filesystem path: fileURLToPath(import.meta.resolve('picovoxel/multi/worker')).
    mainScriptUrlOrBlob: import.meta.resolve('picovoxel/multi/worker'),
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
      return {};
    },
  },
});
```

- `locateFile(file)` receives `pico.wasm` or `pico-multi.wasm` and returns its URL (a path also works in Node). It is not consulted when `instantiateWasm` is given.
- `mainScriptUrlOrBlob` is handed to `new Worker(...)` for each pthread. Node's `worker_threads` rejects `file:` URL strings, so pass a path there.
- `instantiateWasm(imports, receive)` lets the host supply a precompiled `WebAssembly.Module`. Pass the module as the second argument: the pthread workers receive it from the main thread and never fetch the wasm themselves.

The CI consumer job exercises both overrides against the installed tarball on Node (the multi case with the path form and a module compiled from the file bytes).

**Safari**: supported from 16.4 (the wasm-SIMD floor). `Symbol.dispose` is self-shimmed on engines that lack it (Safari 16.4–18.3), so `using` in *your* transpiled code works there too. The shim assigns only when the native symbol is missing; nothing is patched on modern engines. Proven per-release by a Playwright gate that runs the full suite on Chromium, WebKit, and Firefox — pure-wasm results are bit-identical across all three.

## Memory

PicoGK's data lives in WebAssembly memory (up to 4 GB), which the JavaScript garbage
collector cannot see — a 100-byte wrapper can pin a multi-hundred-MB voxel grid.
picovoxel handles this for you:

- **Ordinary use needs no cleanup.** Every wrapper is registered with a
  `FinalizationRegistry`; when it is collected, its native handle is freed.
  Fluent chains (`a.union(b).subtract(c)`) drop intermediates immediately and
  minor GC cycles reclaim them.
- **`session.dispose()` frees everything at once** — the deterministic teardown.
  "Create session → work → dispose session" is the complete story.
- **`dispose()` exists on every object** for tight loops and power users; it is
  idempotent and optional. `using` works too — picovoxel self-shims
  `Symbol.dispose` on engines that lack it.
- **A one-time warning** fires if PicoGK-owned memory crosses 1 GiB
  (`createPico({ memoryWarningBytes })` to raise or `0` to disable) — the GC has
  no idea native memory is piling up, so we refuse to fail silently at 4 GB.
- **The leak oracle is built in**: `session.allocated` reports PicoGK's own
  per-type allocation counters.

## Performance

Numbers from the committed, harness-enforced baseline ([bench/BENCHMARKS.md](bench/BENCHMARKS.md) — Apple M2 Pro; treat ratios as the portable signal):

| What | Number |
| --- | --- |
| Module instantiate | ~10 ms |
| Sphere r=10 @ 0.5 mm | ~1 ms |
| Gyroid via **JS SDF callback** @ 0.25 mm (~1M samples) | ~130 ms (≈130 ns/sample, 3–9% over a native SDF) |
| Mesh readback | 2 ABI crossings instead of one per element (~150× at 174k vertices) |
| Facade overhead over raw cwraps | not measurable at 10k calls |
| vs native PicoGK (arm64) | ~1.95× wall clock, bit-identical geometry\* |

\*The wasm is deterministic: no threads, no relaxed-SIMD — the differential suite holds meshes byte-identical against a `-ffp-contract=off` native reference, and the browser gate holds volumes hex-float-identical across engines.

## Migrating from C# PicoGK

See [MIGRATING-FROM-CSHARP.md](MIGRATING-FROM-CSHARP.md) for the complete member-by-member mapping. The port is semantic, not verbatim: constructor overloads became named factories, mutate/copy pairs became pure methods, `out` params became `T | null` returns — and three upstream bugs are fixed here rather than ported (non-uniform mesh scaling, the mm→voxel conversion, the `AddBeam` overload footgun).

## Building from source

```sh
bash scripts/fetch-deps.sh                   # sha256-pinned sources + pinned emsdk into vendor/
bash scripts/build-deps-wasm.sh              # OpenVDB + oneTBB wasm prefix (~5 min cold)
THREADS=1 bash scripts/build-deps-wasm.sh    # the same prefix for the pthread variant
bash scripts/build-pico-module.sh            # -> src/pico.{mjs,wasm}
THREADS=1 bash scripts/build-pico-module.sh  # -> src/pico-multi.{mjs,wasm}
pnpm install && pnpm test                    # vitest, 100% coverage enforced
pnpm run build && pnpm run test:browser      # Playwright: chromium + webkit + firefox, against dist/
pnpm nx run picovoxel:quality                # build, typecheck, package shape, size budgets
pnpm run bench                               # refuses loaded machines by design
```

Neither wasm pair is committed: CI builds both from the pinned sources, and the published binaries come from that run.

Upstream PicoGKRuntime is consumed **pristine** — no patch queue. The only C++ this repo owns is one translation unit adding four bulk mesh-transfer exports.

## License

Apache-2.0, matching upstream PicoGK, whose compiled runtime this package embeds.
