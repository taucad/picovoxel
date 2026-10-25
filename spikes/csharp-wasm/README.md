# C# PicoGK in the browser (spike)

This spike runs LEAP 71's unmodified `Ex_ImplicitGyroidSphere.cs`, with the real PicoGK C# library and all of
ShapeKernel, in the browser. It compiles the C# with .NET 10's browser-wasm toolchain (Mono AOT) and links the
PicoGK runtime, with picovoxel's own exports, statically into the same wasm module. Every
`[DllImport("picogk.26.2")]` then resolves to a direct wasm call.

## Result

The meshes are byte-identical to the same C# on native .NET against a native runtime built from the same sources.
Single-threaded, the kernel and the SDF callbacks run at native single-core speed, and meshing is about 12% slower.
The full numbers are in [`results/2026-10-24.md`](results/2026-10-24.md).

The same build runs LEAP 71's unmodified Helix heat exchanger (`heatx`). It writes a 503 MB STL that is
byte-identical in Node, Chromium and native .NET. Single-threaded, it takes 392 s in Chromium, 326 s on one native
core and 135 s on four. Matching bytes needs one shared implementation of float trigonometry on both sides
(`libm/float-trig.c`), because .NET's `MathF` trigonometry comes from the platform C library, and glibc and musl
differ in the last bit. See [`results/2026-10-25-heatx.md`](results/2026-10-25-heatx.md).

## What changes and what does not

- The example and ShapeKernel compile as published.
- `prepare.sh` drops the GLFW `Viewer` from the PicoGK C# library. `patch-callbacks.py` then applies two wasm32
  portability fixes. It declares the three `IntPtr` handle types as `long`, matching the runtime's 64-bit
  handles, and it replaces the bound-delegate implicit callbacks with an `[UnmanagedCallersOnly]` trampoline.
- `host/` stands in for the desktop pieces. `WebViewer.cs` has the `Viewer` surface and records what a program
  shows. `Program.cs` registers the globals `Library.Go` registers and runs the task on the main thread.
- `host/FastPath.cs` calls picovoxel's band-corrected and tape exports from C#. They are in the same module, so a
  plain `DllImport` reaches them.

## Build and run

```sh
bash scripts/fetch-deps.sh                 # vendor/ sources
# .NET 10 SDK with `dotnet workload install wasm-tools`, and an emsdk with 3.1.56 activated
EMSDK_NET=/path/to/emsdk-3.1.56 bash spikes/csharp-wasm/build.sh
cd build/csharp-wasm/app/bin/Release/net10.0/browser-wasm/AppBundle
node main.mjs 0.5 3                        # voxel size, runs, then gyroid (default), heatx or math
node main.mjs 0.5 1 heatx
node ../../../../../../../../spikes/csharp-wasm/browser-run.mjs . 0.5 1 heatx   # headless Chromium (PW=<playwright path>)
```

`NATIVE=1` also builds the native linux-x64 baseline in `build/csharp-wasm/native-host`; run it with
`LD_PRELOAD=build/csharp-wasm/native-linux/float-trig.so` to compare bytes. The `ts/` scripts time
picovoxel's TypeScript port of the same example from this checkout.

The runtime must be built with the Emscripten version that .NET's workload pins, which is 3.1.56 for .NET 10. The
Mono archives that .NET links are built with it, and picovoxel's 5.0.1 objects do not link against them.
