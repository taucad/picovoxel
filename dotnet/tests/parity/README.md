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
with each run. Preparing the two browser app directories belongs to the host's
owner, which holds the viewer stubs and the run-time compiler.

## Running a subject

The reference side runs on the matched native comparator:

```sh
node dotnet/run-parity-native.mjs /absolute/sdk/dotnet build/PicoGK/PicoGK.csproj \
  build/comparator gyroid build/native
```

Each browser runs the same subject once per mode, against an app directory the
host's owner prepared: one with the fixture compiled into the published bundle,
one with the same source compiled by the in-browser compiler at run time.

```sh
node dotnet/run-parity-browser.mjs build/app-aot chromium gyroid build/chromium-aot
```

That driver serves the app cross-origin isolated, so the threaded host's
`SharedArrayBuffer` is available, and collects what the fixture wrote. A browser
cannot hand a file to the gate directly, so the app uploads each capture to the
origin it was served from: `PUT capture/<file name>` with the file's bytes, then
`document.title` set to `done` or `failed`. Bytes are never transformed on either
side. An upload whose name is not a bare file name is refused, a second upload of
one capture is refused, and a run that did not write the subject's whole capture
set fails rather than reporting a narrower comparison.

Gate every engine together, which writes the one report the invariant reporter
reads:

```sh
node dotnet/gate-parity.mjs gyroid build/native build/evidence \
  chromium=build/chromium-aot/captures,build/chromium-dynamic/captures \
  firefox=build/firefox-aot/captures,build/firefox-dynamic/captures \
  webkit=build/webkit-aot/captures,build/webkit-dynamic/captures
```

Use `heatx` for the large fixture. The gate checks historical native pins as well
as cross-runtime equality, so three identically regressed outputs cannot pass, and
an engine whose captures are absent or malformed fails rather than being dropped
from the report. `compare.mjs` remains runnable for one engine on its own. Reports
are created exclusively; comparisons never overwrite prior evidence.
