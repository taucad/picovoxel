# Geometry parity fixture

Compile `GeometryParityFixture.cs` with the pinned, unchanged ShapeKernel sources,
`Examples/Ex_ImplicitGyroidSphere.cs`, and HelixHeatX `src/`. Reference the Tau
hosted PicoGK assembly composed from the qualified build-time patches. This is a
test backend; the product uses Tau's existing capture host and shared viewer.

A native or AOT entry point calls `GeometryParityFixture.Run(args)`. A dynamically
loaded assembly uses that same entry point and sources. Arguments are an output
directory and `gyroid` or `heatx`. Run each example in a fresh process or browser
runtime. The fixture unregisters its globals and restores the working directory.
It does not exercise window rendering, screenshots, or UI controls.

Gyroid writes two captures as binary STL and raw indexed meshes. HeatX writes its
own `HelixHeatX.STL`; the fixture also writes `final.mesh` from the last displayed
voxel field after the unchanged task completes. Raw meshes contain little-endian
uint32 vertex and triangle counts, float32 XYZ positions, then uint32 ABC indices.
`compareMesh` in `../../compare-files.mjs` validates the envelope, finite positions,
and index bounds before comparing every byte. `compareStl` attributes header,
normal, vertex and attribute differences without accepting a mismatch.

The historical mesh digest excludes the raw mesh's eight-byte count header and
uses the original spike's FNV offset. The unchanged gyroid pin is
`2b43725651c3733a`; HeatX's mesh pin is `2a13ca3e320a6075`, and its complete STL pin
is `b9dac944dc434a69`. These are acceptance values, never regenerated fixtures.
Same-engine native/AOT/dynamic comparisons are gates. Shipped LEAP runtime
comparisons are separate reports.

The archive and host builders must supply verified input receipts and the matched
workload compiler; this fixture does not establish provenance for arbitrary
binaries. Keep source, patch, archive, reference-assembly and driver identities
with each run. The production build/CI wiring is a subsequent program task.

Run the gate separately for each tested browser after collecting both modes:

```sh
node dotnet/tests/parity/compare.mjs gyroid build/native build/chromium-aot build/chromium-dynamic build/new-report.json
```

Use `heatx` for the large fixture. The gate checks historical native pins as well
as cross-runtime equality, so three identically regressed outputs cannot pass.
The report is created exclusively; comparisons never overwrite prior evidence.
