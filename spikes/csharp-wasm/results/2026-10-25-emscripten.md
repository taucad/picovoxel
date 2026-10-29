# Results, 2026-10-25: Emscripten 3.1.56 against 6.0.2

## The runtime alone

One set of PicoGK runtime sources, built with picovoxel's own scripts and the same flags under each Emscripten,
driven by picovoxel's TypeScript HeatX port (`ts/em-ab.mts`) in Node 24 on the 4-core container. Runs are
interleaved. The 3.1.56 modules are relinked with `-sWASM_BIGINT`, which 5.x enables by default and picovoxel's
glue relies on. Raw output: `emscripten-ab.txt`.

| HeatX task                     | 3.1.56           | 5.0.1            | 6.0.2          |
| ------------------------------ | ---------------- | ---------------- | -------------- |
| serial, 1.0 mm                 | 50.2 s           | 51.2 to 51.4 s   | not run        |
| serial, 0.5 mm                 | 332.8 to 333.0 s | 335.7 to 339.9 s | not run        |
| threaded with mimalloc, 0.5 mm | 83.9 to 84.7 s   | not built        | 77.2 to 77.3 s |

Every build writes the same STL bytes. Single-threaded, a newer compiler gains nothing (3.1.56 is even 1% ahead): the hot code
is OpenVDB's C++, and V8 compiles the wasm either way. Threaded, 6.0.2 is 9% faster, which points at its
pthreads and mimalloc runtime rather than at code generation.

## The C# app on .NET 11

.NET 11 RC3 (`11.0.100-rc.3.26522.148`) pins Emscripten 6.0.2. `NET=11 build.sh` rebuilds the runtime with it and
links the same C#. Raw output: `net11.txt`.

| HeatX at 0.5 mm                    | .NET 10, Emscripten 3.1.56 | .NET 11, Emscripten 6.0.2 |
| ---------------------------------- | -------------------------- | ------------------------- |
| single thread, Node, task          | 401 to 403 s               | 362 s                     |
| threads, Chromium, task            | 165 to 168 s               | 181 to 184 s              |
| threads, Chromium, volume and mesh | 18.3 to 18.4 s             | 23.2 to 23.5 s            |

The STL is byte-identical on both. .NET 11 is 10% faster single-threaded and 10% slower threaded. The runtime
alone is faster threaded on 6.0.2, so the threaded loss is on the .NET side.

## What the move needed

- Mono is still .NET 11's browser runtime, but a `Microsoft.NET.Sdk` project no longer infers it:
  `UseMonoRuntime`, `SelfContained` and `PublishTrimmed` are set, and the bundle needs the
  `Microsoft.NET.Sdk.WebAssembly` SDK.
- .NET 11 links the standard (exnref) wasm exception format, so the runtime is built with
  `-sWASM_LEGACY_EXCEPTIONS=0`. That format needs Safari 18.4; picovoxel's legacy format supports Safari 15.2+.
- The threaded runtime no longer resolves the page's `runMain()` promise, so the host prints an `exit` line that
  the page watches.
- SkiaSharp 3.119's wasm archive still links.
- For picovoxel's own threaded entry on 6.0.2: Emscripten's `PThread.runningWorkers` is gone (workers are in
  `PThread.pthreads`), which `src/session.ts`'s warm-up loop reads.
