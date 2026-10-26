# Browser authoring experiment (W0)

The page compiles original LEAP 71 source with Roslyn and loads the emitted IL into a prebuilt AOT host. No server compiles the author source. The experiment uses .NET 11 RC3 and matching Emscripten 6.0.2, on picovoxel main v0.2.1 plus the original C# spike.

Build the baseline with `NET=11 EMSDK_NET=<6.0.2 emsdk> bash spikes/csharp-wasm/build.sh`, with the .NET 11 SDK and `wasm-tools` on PATH. Then, from the repository root:

```sh
python3 spikes/csharp-wasm/authoring/prepare.py build/csharp-wasm-net11/app build/csharp-wasm-net11/authoring --profiled-base
dotnet publish build/csharp-wasm-net11/authoring/gyroid.csproj -c Release -p:Net=11
python3 spikes/csharp-wasm/authoring/bundle.py build/csharp-wasm-net11/authoring <dotnet-sdk-install-root>
PW=<playwright-module-path> node spikes/csharp-wasm/browser-run.mjs build/csharp-wasm-net11/authoring/bin/Release/net11.0/publish/wwwroot 0.5 3 gyroid
```

`prepare.py` refuses to overwrite an existing experiment. Use a fresh output directory for a new preparation. Its generated project retains the base assembly and IL, since newly loaded code can call APIs and generic instantiations that static trimming cannot see. It uses Roslyn 4.14.0. SkiaSharp 3.119.0 fails the retained-base link with missing `saveSetjmp`/`testSetjmp`; SkiaSharp 4.153.1 (`--skia-version 4.153.1`) also selects its 3.1.56 archive and has the same failure. `--profiled-base` instead retains the known gyroid/HeatX call graph via an inactive runtime branch. This is a restricted experiment, not general API retention; the full-base failure remains unresolved.

Programs:

- `gyroid`: original example compiled in the page, calling AOT ShapeKernel SDFs.
- `gyroid-sdf`: original example plus original `ImplicitUtility.cs` compiled in the page. Both source files remain unchanged; the local SDF definitions supersede the referenced base definitions for this compilation. This measures interpreted author SDF callbacks.
- `heatx`: all original HeatX source files compiled in the page.

The compiler supplies the same implicit global usings as the SDK project. Reference DLLs come from the target SDK's reference pack plus the untrimmed base and SkiaSharp assemblies. The page records runtime startup, source/reference transfer, Roslyn preparation/compile/load time and runtime jiterpreter options. The existing host records task, geometry and callback/tape timings. The runner fails unless the expected historical digests and `exit 0` appear.

The hand-written tape is approximate: do not use its result as an I1 success or an exact-lane replacement. Whole-base retention is an experiment, not a claim that every desktop API works in the browser. Record link failures and runtime failures alongside successes.

Measure manifest-listed boot assets and compiler references with `node spikes/csharp-wasm/authoring/measure.mjs <wwwroot>`. It reports raw and per-file Brotli quality 11 bytes, excluding stale publish outputs and satellite cultures.

Observed W0 result: gyroid passes both historical mesh digests. Browser-authored and AOT HeatX both produce STL digest `960fc22690a4fb69`, differing from the historical required `b9dac944dc434a69`; the runner correctly exits nonzero. Mesh digest, volume bits and triangle count match history. The cause of the STL divergence remains unresolved; do not update the expected digest.
