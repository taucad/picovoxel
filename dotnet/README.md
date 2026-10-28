# Dual-runtime build inputs

This directory owns the private .NET build path. It does not change the npm
engine, exports or geometry fixtures. The archive and host builders are subsequent
implementation steps; this first step validates their inputs.

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

The future archive/host build commands must call `verify` before consuming the
listed inputs and pass only validated archives to the linker. No production link
command exists yet in this directory. The current `inputs` receipt intentionally
does not claim archive or host acceptance.

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
