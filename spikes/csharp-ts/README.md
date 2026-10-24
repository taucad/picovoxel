# C# PicoGK to TypeScript on picovoxel (spike)

`cs2ts` translates C# PicoGK source to TypeScript that runs on picovoxel's wasm runtime, with no .NET in the
browser. It is the transpiling counterpart of [`../csharp-wasm`](../csharp-wasm/README.md), which compiles the C#
instead.

## How it works

- **Language, by Roslyn's semantic model** (`translator/Program.cs`). Every float32 operation is wrapped in
  `Math.fround`, so translated maths produce C#'s bits. User-defined operators become static calls
  (`Vector3.op_Subtraction`), and overloads in translated types get distinct names.
- **API, mirrored rather than mapped** (`runtime/picogk.ts`). Calls keep their C# names
  (`vox.voxIntersectImplicit(sdf)`). A runtime with PicoGK's C# surface answers them over picovoxel's raw ABI,
  so programs need no per-member mapping.
- **Fast lane, by lifting.** For each `IImplicit`, `fSignedDistance` is also lifted to a picovoxel tape
  expression. The lift is marked exact when no float32 rounding happens between the coordinate and the final
  cast, because the tape evaluates in double and truncates once. Exact lifts run as tape in the exact lane;
  the rest use the tape only in the fast lane and fall back to the callback otherwise.

## Result

The translated `Ex_ImplicitGyroidSphere.cs` in the exact lane is byte-identical to the C# on .NET, native or
wasm. Its gyroid runs as tape there, because the lift is exact. The fast lane runs both shapes as tape, which
takes 9.5 ms against 24 ms. See [`results/gyroid-sphere-node.txt`](results/gyroid-sphere-node.txt).

On all of ShapeKernel and its examples, the first-pass translator handles 500 of 715 members. The 215 gaps fall
into a few categories: base-library types (`List<T>`, `Random`, `StreamWriter`), constructor overloads,
`ref`/`out`, enums, operator declarations and delegates. See
[`results/shapekernel-coverage.txt`](results/shapekernel-coverage.txt).

## Run

```sh
dotnet run --project spikes/csharp-ts/translator -c Release -- \
  --out spikes/csharp-ts/out/gyroid-sphere.ts --runtime ../runtime/picogk.ts \
  --translate <ShapeKernel>/Examples/Ex_ImplicitGyroidSphere.cs <ShapeKernel>/ShapeKernel/Utilities/ImplicitUtility.cs \
  --context <prepared PicoGK C# sources> <ShapeKernel>/ShapeKernel
node spikes/csharp-ts/run.mts 0.5 3 exact   # or fast
```

The PicoGK C# sources and ShapeKernel come from `spikes/csharp-wasm/build.sh`, in `build/csharp-wasm/app/picogk`
and `build/csharp-wasm/src/ShapeKernel`. `run.mts` needs `src/pico.wasm` from the picovoxel build.
