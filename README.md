<img src="https://raw.githubusercontent.com/taucad/picovoxel/main/assets/logo.svg" alt="" width="88" height="88" />

# picovoxel

[![npm](https://img.shields.io/npm/v/picovoxel)](https://www.npmjs.com/package/picovoxel)
[![CI](https://github.com/taucad/picovoxel/actions/workflows/ci.yml/badge.svg)](https://github.com/taucad/picovoxel/actions/workflows/ci.yml)
[![Part of the Tau ecosystem](https://img.shields.io/badge/Tau-ecosystem-6d28d9)](https://tau.new)

[PicoGK](https://github.com/leap71/PicoGK), the voxel and implicit geometry kernel on OpenVDB, compiled to
WebAssembly with a typed TypeScript API. It runs in browsers and in Node, from a serial build or a
multithreaded one with the same API.

> **Unofficial and community-maintained.** picovoxel is an independent binding, not affiliated with,
> endorsed by, or supported by LEAP 71. It compiles the open-source PicoGK runtime with a small, documented
> patch series (listed in [NOTICE](NOTICE)); the API, packaging and package name are ours. File issues
> [on this repository](https://github.com/taucad/picovoxel/issues), not with the PicoGK team.

| I want to…                         | Start here                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install the package                | [Install](#install)                                                                                                                                             |
| Run the smallest example           | [Quick start](#quick-start)                                                                                                                                     |
| Use threads or bundle the wasm     | [docs/threads-and-isolation.md](https://github.com/taucad/picovoxel/blob/main/docs/threads-and-isolation.md)                                                    |
| Choose exact or fast results       | [docs/lanes.md](https://github.com/taucad/picovoxel/blob/main/docs/lanes.md)                                                                                    |
| Understand memory and known limits | [docs/memory-and-limits.md](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md)                                                            |
| Port C# PicoGK code                | [MIGRATING-FROM-CSHARP.md](MIGRATING-FROM-CSHARP.md)                                                                                                            |
| Choose a supported host            | [compatibility.md](compatibility.md)                                                                                                                            |
| Contribute or release              | [CONTRIBUTING.md](https://github.com/taucad/picovoxel/blob/main/CONTRIBUTING.md) / [MAINTAINER.md](https://github.com/taucad/picovoxel/blob/main/MAINTAINER.md) |

## Install

```bash
npm install picovoxel
```

```bash
pnpm add picovoxel
```

## Quick start

```js
import { createPico } from 'picovoxel';

const pico = await createPico({ voxelSize: 0.5 });
const sphere = pico.createVoxels({ shape: 'sphere', radius: 10 });
const gyroid = sphere.maskedByImplicit({
  sdf: (x, y, z) =>
    Math.abs(Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x)) - 0.4,
});
const stl = gyroid.toMesh().toStl(); // binary STL bytes
pico.dispose();
```

Objects need no per-handle cleanup: the garbage collector frees them, and `pico.dispose()` frees the whole
session at once ([memory](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md)). Replace `'picovoxel'` with `'picovoxel/multi'` for
the multithreaded build.

## What you get

| Entry                      | Contents                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `picovoxel`                | The PicoGK surface without the viewer: voxel CSG, offsets, fillets, shells and trims, implicit rendering from JavaScript SDF callbacks, meshes with bulk transfer, STL, GLB and VDB input and output, lattices, polylines, fields and metadata |
| `picovoxel/multi`          | The same API on the pthreads build ([threads](https://github.com/taucad/picovoxel/blob/main/docs/threads-and-isolation.md))                                                                                                                    |
| `picovoxel/slicing`        | Voxel slices to closed contours, SVG, and CLI (Common Layer Interface) files for powder-bed printers                                                                                                                                           |
| `picovoxel/three`          | `toBufferGeometry` and `meshFromBufferGeometry` for three.js (an optional peer dependency)                                                                                                                                                     |
| `picovoxel/numerics`       | Vectors, matrices, quaternions and frames: the System.Numerics and `PicoGK.Numerics` layer, pure TypeScript                                                                                                                                    |
| `picovoxel/shapekernel`    | A TypeScript port of LEAP 71's ShapeKernel                                                                                                                                                                                                     |
| `picovoxel/latticelibrary` | A TypeScript port of LEAP 71's LatticeLibrary                                                                                                                                                                                                  |
| `picovoxel/raw`            | The generated, typed binding for all 163 C-ABI exports (140 from PicoGKRuntime, 23 from picovoxel)                                                                                                                                             |

Every session has a lane: `exact` reproduces the reference results byte for byte, `fast` allows faster
algorithms that change values slightly and marks what they produce. See [docs/lanes.md](https://github.com/taucad/picovoxel/blob/main/docs/lanes.md).

## Browser and Node

- **Node 22.14.0 or later**: both entries work with no configuration.
- **TypeScript 5.7 or later** for the declarations: they use typed-array generics such as
  `Uint8Array<ArrayBuffer>`, which older compilers reject.
- **Browser, serial** (`picovoxel`): serve `pico.wasm` beside `pico.mjs` with `Content-Type: application/wasm`.
  No special headers.
- **Browser, multithreaded** (`picovoxel/multi`): the page must be cross-origin isolated
  (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` or
  `credentialless`), and `pico-multi.mjs` and `pico-multi.wasm` must come from the same origin.

Each glue file finds its wasm with `new URL(file, import.meta.url)`, so a bundler that copies those files
beside the output needs nothing more. A host that relocates or precompiles the assets resolves them from
their own subpaths (`picovoxel/wasm`, `picovoxel/glue`, `picovoxel/multi/wasm`, `picovoxel/multi/worker`)
and passes Emscripten overrides through `createPico({ wasm })`:

```js
import { createPico } from 'picovoxel';
// Vite's asset-URL import; other bundlers have an equivalent.
import wasmUrl from 'picovoxel/wasm?url';

const pico = await createPico({ wasm: { locateFile: () => wasmUrl } });
```

```js
import { fileURLToPath } from 'node:url';
import { createPico } from 'picovoxel';

// Node: import.meta.resolve returns a file: URL; pass the path.
const pico = await createPico({
  wasm: { locateFile: () => fileURLToPath(import.meta.resolve('picovoxel/wasm')) },
});
```

The multithreaded overrides (`mainScriptUrlOrBlob`, `instantiateWasm` with one compiled module per worker)
are in [docs/threads-and-isolation.md](https://github.com/taucad/picovoxel/blob/main/docs/threads-and-isolation.md).

## Reusing one module across sessions

`createPico()` instantiates a wasm module for every session, and on `picovoxel/multi` it also starts a
thread pool. A host that opens many sessions can pay that once:

```js
import { createPicoRuntime } from 'picovoxel/multi';

const runtime = await createPicoRuntime(); // instantiate and warm the pool once
const pico = await runtime.createPico({ voxelSize: 0.5 });
pico.dispose(); // frees this session only
runtime.dispose(); // disposes open sessions, then stops the pool
```

Each session keeps its own voxel size, lane and objects, but all of them share one heap and its 4 GiB
ceiling, while the memory warning counts one session at a time
([memory](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md#sessions-sharing-a-runtime)).

## Compatibility

See [compatibility.md](compatibility.md), including the known issues. Every check mark in that table maps
to a named job in `.github/workflows/ci.yml`.

## Performance

Measured on an Apple M2 Pro (12 cores) in July and August 2026 with LEAP 71's HelixHeatX fixture:
`picovoxel/multi` built the part in about 8.4 s at 1.0 mm and 32.9 s at 0.5 mm, where the prebuilt native
PicoGK runtime took 19.8 s and 65.4 s on the same machine. The native runs include preview and screenshot
work that the TypeScript port leaves out, which favours picovoxel at coarse voxel sizes. A native build
with the parallel lattice change that picovoxel offers upstream took 6.9 s and 28.8 s.

Methods and the harness: [bench/BENCHMARKS.md](https://github.com/taucad/picovoxel/blob/main/bench/BENCHMARKS.md) and
[bench/native-heatx](https://github.com/taucad/picovoxel/blob/main/bench/native-heatx/README.md).

## Migrating from C# PicoGK

[MIGRATING-FROM-CSHARP.md](MIGRATING-FROM-CSHARP.md) maps every C# member. The port is semantic:
constructor overloads became named factories, mutate/copy pairs became pure methods, and `out` parameters
became `T | null` returns. Upstream bugs are fixed here rather than ported; the table in that document
records each one and whether LEAP 71 has fixed it since.

## Versioning and stability

Versions follow Semantic Versioning. Before 1.0, a minor release may contain a breaking API change; each
one is recorded in [BREAKING_CHANGES.md](BREAKING_CHANGES.md). Changes to the bytes an `exact` session
produces are breaking changes.

## Security and provenance

Report vulnerabilities through GitHub private vulnerability reporting. Releases are published from the
`ci.yml` workflow with npm provenance; verify with `npm audit signatures`.

Both wasm modules are built in CI from sources pinned by commit and SHA-256 (`scripts/fetch-deps.sh`):
PicoGKRuntime, OpenVDB, oneTBB and xxHash, compiled with Emscripten 5.0.1. The build applies the patch
series in `patches/`, asserts the wasm SIMD instruction count, and fails if the build path is embedded in
the output. The published wasm is the file the tests ran against.

## Building from source

```sh
bash scripts/fetch-deps.sh                   # pinned sources and emsdk into vendor/
bash scripts/build-deps-wasm.sh              # OpenVDB + oneTBB wasm prefix (~5 min cold)
THREADS=1 bash scripts/build-deps-wasm.sh    # the same prefix for the pthreads build
bash scripts/build-pico-module.sh            # -> src/pico.{mjs,wasm,exports.ts}
THREADS=1 bash scripts/build-pico-module.sh  # -> src/pico-multi.{mjs,wasm,exports.ts}
pnpm install && pnpm test                    # vitest, 100% coverage enforced
pnpm run build && pnpm run test:browser      # Playwright: Chromium, WebKit and Firefox against dist/
pnpm nx run picovoxel:quality                # build, types, package shape, lint, prose and size gates
pnpm run bench                               # refuses loaded machines by design
```

The build tools declare Node `^22.18.0 || >=24.11.0`; CI builds on Node 26. The package itself needs Node
22.14.0. Neither wasm pair is committed: CI builds both, and the published binaries come from that run.
Each build also writes `src/<variant>.exports.ts`, the export names its glue reads; for a wasm pair copied
in from elsewhere, run `node scripts/generate-wasm-exports.mjs pico` (and `pico-multi`).
The C++ this repository owns is nine translation units in `src/` that add exports; the patches that
change PicoGKRuntime, OpenVDB and oneTBB are in `patches/`, and fixes offered upstream are in
[`upstream/`](https://github.com/taucad/picovoxel/blob/main/upstream/README.md).

## Documentation

- [Lanes and exact results](https://github.com/taucad/picovoxel/blob/main/docs/lanes.md)
- [Threads and cross-origin isolation](https://github.com/taucad/picovoxel/blob/main/docs/threads-and-isolation.md)
- [Memory and limits](https://github.com/taucad/picovoxel/blob/main/docs/memory-and-limits.md)
- [Migrating from C#](MIGRATING-FROM-CSHARP.md)
- [Changelog](CHANGELOG.md)
- [Source](https://github.com/taucad/picovoxel) and [issues](https://github.com/taucad/picovoxel/issues)

## License

Apache-2.0, matching upstream PicoGK, whose compiled runtime this package embeds. See [license](license)
and [NOTICE](NOTICE) for the bundled third-party components.

Part of the [Tau ecosystem](https://tau.new).
