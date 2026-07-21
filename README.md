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

The same wasm pair serves both. In node (≥ 20) it just works. In the browser, serve `pico.wasm` next to `pico.mjs` (both ship in `dist/`) with `Content-Type: application/wasm`; no COOP/COEP headers are needed — the build is single-threaded by design (PicoGK's implicit loop is serial, so JS SDF callbacks are exact, not racy).

**Bundlers**: the Emscripten glue locates `pico.wasm` via `import.meta.url`. If your bundler inlines the glue, copy `pico.wasm` next to your bundle output — that is the whole integration.

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
bash scripts/fetch-deps.sh        # sha256-pinned sources into vendor/ (+ emsdk on first run)
bash scripts/build-deps-wasm.sh   # OpenVDB + oneTBB wasm prefix (~5 min cold)
bash scripts/build-pico-module.sh  # -> src/pico.{mjs,wasm}
npm ci && npm test                # vitest, 100% coverage enforced
npm run test:browser              # Playwright: chromium + webkit + firefox
npm run bench                     # refuses loaded machines by design
```

Upstream PicoGKRuntime is consumed **pristine** — no patch queue. The only C++ this repo owns is one translation unit adding four bulk mesh-transfer exports.

## License

Apache-2.0, matching upstream PicoGK, whose compiled runtime this package embeds.
