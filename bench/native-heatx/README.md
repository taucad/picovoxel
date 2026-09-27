# Native HelixHeatX harness

The native C# harness that produced the same-machine evidence in
[`bench/results/native/`](../results/native/README.md): the published-binary
sweep, the pristine/patched control arms, the allocator arms and the U5
tube-complex arm (`upstream/picogkruntime-tubecomplex-lattice.patch`). It is
committed so the U5 numbers can be rerun by anyone with the same setup; it is
not part of the package, the test suite or CI.

| File | Role |
| --- | --- |
| `NativeHeatX.csproj` | Compiles PicoGK, ShapeKernel and HelixHeatX from sibling source checkouts and copies the osx-arm64 runtime dylibs beside the app |
| `Program.cs` | One timed run per process: `Library.Go(voxelSize, HelixHeatX.Task)` as upstream's tutorial runs it, one JSONL record per run |
| `Cutaway.cs` | `--view`: an interactive cutaway of the fixture; never timed |
| `run-sweep.sh` | Round-robin sweep, 1.0 → 0.5 mm, 5 passes by default; `LABEL`, `PICOGK_DYLIB`, `ALLOC_DYLIB`, `ALLOC_LABEL`, `IDLE_LIMIT` select the arm |
| `summarize.mjs`, `compare-arms.mjs`, `compare-best.mjs` | Tables over the recorded JSONL (bootstrap medians from `bench/stats.mjs`) |
| `compare-stl.mjs` | Streaming binary-STL parity (volume, area, bounds) between two arms |

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
  are in the header of `NativeHeatX.csproj` and in
  `bench/results/native/README.md`. Nothing is written into those checkouts.
- **Patched arms need your own runtime build**: build `PicoGKRuntime` with
  `patches/PicoGKRuntime/` (and, for the U5 arm, the upstream patch) using the
  flags in `bench/results/native/PATCHED-NATIVE.md`, then pass the dylib as
  `PICOGK_DYLIB` with a `LABEL`.
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
