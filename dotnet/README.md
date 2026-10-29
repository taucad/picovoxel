# Dual-runtime build inputs

This directory owns the private .NET build path. It does not change the npm
engine, exports or geometry fixtures. The archive builder validates its inputs; host and package integration follow
separately.

## Qualified workload identity

Use SDK `11.0.100-rc.3.26522.148` with runtime/workload packs
`11.0.0-rc.3.26522.148`. `global.json` prevents SDK roll-forward. Roslyn 5.9.0
input assemblies have explicit SHA-256 pins in `inputs.json`. The browser-only
Roslyn checksum patch is a separate build step, not applied by this validator.

**Package name and compiler version differ.** The selected workload's package is
named `Microsoft.NET.Runtime.Emscripten.6.0.2.*`, but MSBuild resolves compiler
**6.0.3**, revision `6ea9c28c38cdd40c1032fa04400c9d16230ee180`. The compiler
executable and Mono's `wasm-props.json` report that same identity. Use the compiler
from this workload for the private archive. A separate emsdk 6.0.2 build does not
meet this check. This does not upgrade the npm toolchain.

The validator queries MSBuild, runs the selected compiler, checks the runtime's
compiler version/revision, and hashes SDK, runtime, AOT tooling, reference and
compiler files. Current live qualification is serial `osx-arm64`; other platforms
and threaded packs need their own successful run. No browser conformance or
geometry parity follows from a successful input check.

## Record and verify

Run from the repository root. Create a local configuration outside tracked source:

```json
{
  "purpose": "inputs",
  "comparator": "picovoxel-browser",
  "nativeRid": "osx-arm64",
  "execution": "serial",
  "dotnet": "/absolute/sdk/dotnet",
  "nuget": "/absolute/nuget/packages",
  "sources": {
    "picovoxel": "/absolute/picovoxel",
    "PicoGK": "/absolute/pristine/PicoGK",
    "ShapeKernel": "/absolute/pristine/ShapeKernel",
    "HelixHeatX": "/absolute/pristine/HelixHeatX"
  },
  "files": {
    "managed-patches": "/absolute/patch-input-directory"
  },
  "flags": ["-ffp-contract=off", "-fwasm-exceptions"]
}
```

```sh
node dotnet/validate-inputs.mjs record build/dotnet/config.json build/dotnet/inputs.json
node dotnet/validate-inputs.mjs verify build/dotnet/config.json build/dotnet/inputs.json
pnpm nx run picovoxel:test:dotnet-inputs
```

`record` creates a new receipt exclusively; it never overwrites an existing one.
`verify` re-reads actual bytes and fails on any changed receipt field. Do not
re-record to hide unexpected input drift. Paths in the configuration are resolved
from the invoking working directory; receipts contain logical names and hashes.
Only files enumerated in a source receipt may be staged from that checkout.
Ignored generated files are not source inputs. Explicitly list all additional
patches, staged source trees and configuration under `files`.

Comparator identities are `leap-shipped`, `tau-native`, `picovoxel-native`, and
`picovoxel-browser`. Keep separate receipts for each and specify the native RID,
execution mode and build flags. These labels identify the comparison; they do not
prove a binary's origin or establish parity.

## Cached browser archives

A browser configuration with `purpose: "link"` requires `browserArtifacts`:

```json
{
  "engine": {
    "path": "/absolute/engine.a",
    "metadata": "/absolute/engine.metadata.json",
    "inputs": "/absolute/producer-inputs.json"
  }
}
```

Each archive producer writes metadata with `schemaVersion: 1`, `execution`,
`emscripten`, `emscriptenRevision`, `runtime`, `sha256` of the archive and
`inputsSha256` of its producer receipt bytes. Validation checks the bytes, mode,
compiler, runtime, producer source identities, staged inputs and flags. Validate an archive with the same engine-input configuration its producer used; host-only inputs belong in a separate receipt. Producers must build directly
from verified inputs; this is cache-integrity evidence, not a signed attestation
of an arbitrary pre-existing binary. Do not relabel the old spike archive.

The archive builder records and revalidates its inputs, and links a native core
witness. Host builders must admit those archives through `purpose: "link"` before
consuming them. An `inputs` receipt alone does not claim archive or host acceptance.

## Desktop compatibility and callback bridge

Run the explicit desktop target with the pristine pinned PicoGK checkout, a fresh
output directory, the selected SDK executable and `osx-arm64`:

```sh
pnpm nx run picovoxel:test:dotnet-desktop --args="build/csharp-wasm-net11/src/PicoGK build/desktop-check /absolute/sdk/dotnet osx-arm64"
```

The target builds pristine and target-conditionally patched C# consumers against
the shipped LEAP runtime. It compares public API signatures, geometry, STL and
field results. A third build enables the browser handle/callback branch on native
CoreCLR to check nested callbacks, concurrency, original exception recovery and
subsequent successful calls. This third build tests bridge semantics; it does not
qualify wasm/AOT. The fixture requires no native Skia renderer.

The four callback operations are synchronous on the calling thread. A per-call
managed context and stack-scoped native frame preserve nested calls. Managed
exceptions become native status before being rethrown; a failed mutation can
leave partial geometry and has no rollback guarantee. The bridge does not imply
that callbacks from arbitrary worker threads are supported.

## Geometry parity

`tests/parity/GeometryParityFixture.cs` runs the pinned original gyroid and HeatX
examples against the hosted library. The fixture and [comparison gate](tests/parity/README.md)
check native, precompiled browser and dynamically loaded C# output. They preserve
the historical pins as well as requiring current byte equality; matching bad
output on all three paths still fails.

Apply `patches/stl-normal-canonicalization.patch` during source staging on both
comparison targets. It preserves the historical `0xffc00000` encoding for NaN
face normals after float storage. Finite normals, vertices, the STL header and
triangle order are unchanged. A NaN-only difference is diagnosed but never
accepted by the byte comparator.

Input receipts and source identity remain mandatory. The fixture does not infer
a binary's provenance from its file name or from matching geometry alone.

### The matched native comparator

I1 compares the browser against a native build of the same engine sources, so
`build-native-comparator.mjs` stages exactly what the archive build stages — the
pinned runtime, OpenVDB, oneTBB and c-blosc trees with their vendor patches and
the caller's `Runtime.browser.patch` — and compiles it with the host toolchain:

```sh
node dotnet/build-native-comparator.mjs /absolute/adapter/native build/comparator --jobs 4
```

The output directory must be fresh. The engine links as one shared library beside
a shared-float-trigonometry library, which is interposed (`LD_PRELOAD`, or
`DYLD_INSERT_LIBRARIES` on macOS) rather than linked in, so both sides round the
same way. `src/pico-tape.cpp` is not built: it is a wasm translation unit, and its
two exports are excluded from the comparator's symbol requirement. The build then
runs the adapter's own C++ corpus against the library before writing its receipt.

`run-parity-native.mjs` produces the reference captures that gate reads:

```sh
node dotnet/run-parity-native.mjs /absolute/sdk/dotnet /composed/PicoGK.csproj build/comparator gyroid build/native-gyroid
```

It fetches the pinned author trees, verifies them against the pins' recorded Git
blobs, compiles them unchanged beside the fixture, and runs the subject against
the comparator. Its `author-sources.json` is I2's evidence.

### Invariant reporting

`tests/invariants.mjs` reads the evidence one CI run produced and reports I1 to I5
as `passed`, `failed` or `unproven`; anything but five passes is a failure, so a
check that did not run can never read as a pass. `tests/npm-contract.mjs` is I4's
own check: it compares the program's commits against their merge base and fails if
they touch the byte-locked fixtures or the surface manifest.

## Private archive builds

The builder takes a configuration and a new output directory. It never invokes
the npm builder or installs another Emscripten compiler:

```sh
node dotnet/prepare-archive.mjs /absolute/sdk/dotnet /absolute/nuget/packages /absolute/tau-adapter serial build/archive-inputs
bash dotnet/build-archive.sh build/archive-inputs/configuration.json build/archive-first
bash dotnet/build-archive.sh build/archive-inputs/configuration.json build/archive-second
node dotnet/verify-archives.mjs build/archive-first build/archive-second
```

The adapter directory belongs to the consuming application. It supplies
`Runtime.browser.patch`, `browser-callbacks.cpp`, `required-symbols.json` and
`tests/browser-core.cpp`. Tau keeps those inputs in its PicoGK plugin; they are
not copied into this repository. The patch must retain the geometry translation
unit under `PICOGK_HEADLESS` while excluding the native Viewer. The builder stages
only admitted source files, applies patches with zero fuzz, checks all required
symbols, rejects native Viewer symbols, and links the core witness with every
required export retained.

`prepare-archive.mjs` downloads checksummed engine/dependency sources and restores
the exact selected runtime. The threaded Mono runtime is restored to the NuGet
cache on this SDK, whereas the serial runtime is supplied as an SDK pack. Both
must pass the same compiler/version checks. Use `threaded` in a separate input
configuration and output directory for the pthread archive.

Each build isolates Emscripten and Python caches in its output directory. Stable
file-prefix maps keep the build directory out of embedded source strings.
`native/` contains the engine, OpenVDB, oneTBB, Blosc, zlib and shared float-trig
objects. `inputs.json`, `staged-source.json`, `outputs.json` and per-file metadata
bind their actual bytes to the producer inputs. A changed input fails final
verification and no accepted output manifest is emitted. Clean-build comparison
checks actual files, metadata and source receipts, not only declared hashes.

The reusable `dotnet-archive.yml` workflow runs in the adapter-owning caller's
repository. The caller pins this repository's builder commit. Its serial/threaded
matrix builds twice and keeps private artifacts in the caller's run. It has no
publishing step and does not modify the npm candidate pipeline. Remote CI success
must be recorded separately from local archive/link acceptance.

## Browser compiler adaptation

The runtime-authoring host uses the pinned Roslyn 5.9.0 `netstandard2.0`
assembly. `tools/RoslynChecksumPatch` replaces its single source-checksum
scheduling call with eager computation, preserving a faulted task and the
original exception when computation fails. It verifies the original assembly
digest, writes a new file and never changes the NuGet cache.

Run the deterministic-output, refusal and exception checks with the selected SDK:

```sh
pnpm nx run picovoxel:test:dotnet-roslyn --args='/absolute/sdk/dotnet build/roslyn-check'
```

The output directory must be fresh. The target builds its tools and intermediate
files beneath that directory.

`build-compiler.mjs` produces the pair a package build stages. It verifies both
pinned cache assemblies, adapts `Microsoft.CodeAnalysis.dll` and stages
`Microsoft.CodeAnalysis.CSharp.dll` as the pinned bytes, which need no change:

```sh
node dotnet/build-compiler.mjs /absolute/sdk/dotnet ~/.nuget/packages build/compiler
```

## Runtime-authoring retention

A prebuilt browser host that loads newly compiled C# imports
`browser/AuthoringRetention.props` after defining its assembly name and
`browser-wasm` runtime identifier. This retains the host, PicoGK and the listed
framework APIs independently of example programs. It preserves IL after AOT,
enables reflection JSON and keeps constructor parameter names. Host types also
need their property getters retained for serialization; keeping parameter names
alone does not preserve those getters.

The props file does not add a native renderer or image library. The host still
provides matched metadata references, compiler assets and native archives, and
must verify their common build identity. Worker integration and local package
staging are separate from these retention settings.

## Local package

A browser host needs the SDK, the WebAssembly workload, the adapted C# compiler,
the framework reference assemblies, the patched managed library, the
signed-distance generator and the native engine archives to agree. Staging each
one separately makes each one correct only by hand. `package/` binds them into
`PicoVoxel.PicoGK`, a package for a local directory feed. It is never published:
nothing here pushes it to a feed, and every consumer restores it from a local
directory.

```sh
node dotnet/build-package.mjs /absolute/sdk/dotnet ~/.nuget/packages \
  build/PicoGK build/archive-serial build/archive-threaded \
  build/generator/PicoVoxel.Sdf.Generator.dll build/roslyn build/package
```

The driver verifies every input before staging it: each archive member against
its own receipt, each receipt's toolchain against the workload this install
resolves, the archive pair against each other for a common source, the managed
source against the pinned commit's Git blobs, and the adapted compiler against
the digests `inputs.json` records. It then writes `manifest.json`, which carries
every payload byte's digest beside those identities, and packs the payload.

`package/base/compose.mjs` stages the managed library into a fresh tree at a
patch order the caller gives, because a consumer's own patches interleave with
this package's. A composition that drops this package's patch is refused, so the
order is a choice and never an omission.

Qualify the result against a local-feed-only restore and the sample both targets
share:

```sh
node dotnet/test-package.mjs /absolute/sdk/dotnet build/package build/package-check
```

That restores the package with every package source cleared, compares the
restored payload to the manifest byte for byte, refuses a restored tree carrying
anything the manifest does not list, builds `samples/PicoGKSample` for desktop
and for `browser-wasm`, and asserts the browser target's generated registry
registers the sample's own implicit. Linking the headless engine needs the
viewer imports stubbed, which is a consumer patch this package does not own, so
the browser sample stops at the managed compile; the linked, trimmed and AOT
browser bundle belongs to the host that consumes this package.
