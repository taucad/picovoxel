# Native HelixHeatX harness

A native C# harness for LEAP 71's HelixHeatX fixture. It measures native PicoGK on the same machine as
picovoxel's wasm benchmarks, so wasm-versus-native statements rest on one machine instead of a published
table from different hardware. It also measured the parallel lattice patch that picovoxel offers upstream
(`upstream/picogkruntime-tubecomplex-lattice.patch`). It is committed so anyone with the same setup can
rerun those numbers; it is not part of the package, the test suite or CI.

| File                                                    | Role                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeHeatX.csproj`                                    | Compiles PicoGK, ShapeKernel and HelixHeatX from sibling source checkouts and copies the osx-arm64 runtime dylibs beside the app         |
| `Program.cs`                                            | One timed run per process: `Library.Go(voxelSize, HelixHeatX.Task)` as upstream's tutorial runs it, one JSONL record per run             |
| `Cutaway.cs`                                            | `--view`: an interactive cutaway of the fixture; never timed                                                                             |
| `run-sweep.sh`                                          | Round-robin sweep, 1.0 → 0.5 mm, 5 passes by default; `LABEL`, `PICOGK_DYLIB`, `ALLOC_DYLIB`, `ALLOC_LABEL`, `IDLE_LIMIT` select the arm |
| `summarize.mjs`, `compare-arms.mjs`, `compare-best.mjs` | Tables over the recorded JSONL (bootstrap medians from `bench/stats.mjs`)                                                                |
| `compare-stl.mjs`                                       | Streaming binary-STL parity (volume, area, bounds) between two arms                                                                      |

## Recorded evidence

`bench/results/native/` holds one `.jsonl` (a record per run: voxel size, task and process seconds, STL
bytes, runtime build, allocator, host load) and one runner `.log` per arm, all recorded on 2026-08-09 on
an Apple M2 Pro (12 cores, 32 GiB, macOS 26.5.2, .NET 9.0.16), 5 runs per voxel size.

| Arm                            | Runtime                                                                                    | Median at 1.0 mm / 0.5 mm   |
| ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------- |
| `published`                    | The prebuilt dylib LEAP 71 ships in `PicoGK/native/osx-arm64` (PicoGK 2.2.0)               | 19.79 s / 65.36 s           |
| `pristine-ourbuild`            | PicoGKRuntime `0f26321` built here: Release, `USE_BLOSC=OFF`, Homebrew TBB 12.18 and Boost | 19.52 s / 64.45 s           |
| `patched`                      | The same build with `patches/PicoGKRuntime/` and `patches/openvdb/` applied                | 19.48 s / 63.94 s           |
| `u5`                           | The patched build plus `upstream/picogkruntime-tubecomplex-lattice.patch`                  | 6.87 s / 28.75 s            |
| `mimalloc`, `tbbproxy`, `best` | Allocator variants inserted with `DYLD_INSERT_LIBRARIES`; `best` is `u5` plus mimalloc     | within 2% of their base arm |

Every exact arm writes byte-identical STL files at every voxel size. The `u5` arm's files differ from them
by at most 652 of 3.31 million triangles (at 0.8 mm), with volume and area within 0.01% and identical
bounds (`compare-stl.mjs`).
The oneTBB patch is left out of every native arm because each of its hunks is inside `#if __EMSCRIPTEN__`.
Regenerate the tables with `node bench/native-heatx/summarize.mjs`, `compare-arms.mjs` and `compare-best.mjs`.

The native task also requests ten screenshots and viewer previews and waits twice for 0.1 s; the TypeScript
port in `examples/helixheatx/` leaves those out. Comparisons with the wasm build therefore favour the wasm
build, most at coarse voxel sizes.

## Constraints

- **macOS on Apple silicon only.** The project copies
  `PicoGK/native/osx-arm64/*.dylib`; `run-sweep.sh` reads `sysctl`, `pmset`
  and `top -l`, and inserts allocators with `DYLD_INSERT_LIBRARIES` on the real
  dotnet host (the Homebrew `dotnet` wrapper script would strip it).
- **.NET 9** from Homebrew (`brew --prefix dotnet@9`), plus the SkiaSharp
  3.119.0 NuGet package the project restores.
- **Sibling upstream checkouts.** `$(UpstreamRoot)` defaults to three levels
  up (the directory that contains this repository) and must hold `PicoGK`,
  `LEAP71_ShapeKernel` and `LEAP71_HelixHeatX`; `run-sweep.sh` also reads
  `PicoGKRuntime` for the log header. The revisions the recorded evidence used
  are in the header of `NativeHeatX.csproj`. Nothing is written into those
  checkouts.
- **Patched arms need your own runtime build**: build `PicoGKRuntime` at
  `0f26321` in Release with `USE_BLOSC=OFF`, apply `patches/PicoGKRuntime/`
  and `patches/openvdb/` (and, for the `u5` arm, the upstream patch), then
  pass the dylib as `PICOGK_DYLIB` with a `LABEL`.
- **Disk**: each run writes an STL of up to about 500 MB plus ten
  screenshots into a scratch directory that is wiped between runs.
- `bin/`, `obj/` and `imgui.ini` are build and viewer output and are ignored.

It stays out of CI and out of the coverage domain (`src/**/*.ts`) for these
reasons: it needs macOS arm64, .NET, and the sibling upstream checkouts.

## Run

```bash
dotnet build -c Release bench/native-heatx/NativeHeatX.csproj
bash bench/native-heatx/run-sweep.sh 5
node bench/native-heatx/summarize.mjs
```
