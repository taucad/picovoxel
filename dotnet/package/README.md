# PicoVoxel.PicoGK

One restorable identity for a PicoGK build that runs the same C# on a desktop
native runtime and in browser WebAssembly. It is consumed from a local
directory feed inside one build and is never published.

## What the package binds

A browser host needs seven things to agree: the .NET SDK, the WebAssembly
workload, the C# compiler it compiles author source with, the framework
reference assemblies it compiles against, the patched managed library, the
signed-distance generator and the native engine archives. Staging them
separately makes each one correct only by hand. This package carries them
under one `manifest.json`, which records every payload byte's digest together
with the toolchain identity the archives were built by.

| Payload                              | What it is                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `manifest.json`                      | Every payload digest, the pinned identities, and the engine receipts       |
| `base/source/`                       | The managed PicoGK library at the commit the manifest records              |
| `base/patches/`                      | This package's build-time patches against that source                      |
| `base/managed/`                      | `BrowserCallbacks.cs` and `SdfTape.cs`, the browser boundary's own sources |
| `base/PicoGK.csproj`                 | The library project; one project for either target                         |
| `base/compose.mjs`                   | Composes the three into a fresh tree at an explicit patch order            |
| `browser/`                           | The authoring-retention props a trimmed browser build needs                |
| `generator/`                         | `PicoVoxel.Sdf.Generator.dll`, which lifts liftable implicits to a tape    |
| `roslyn/`                            | The adapted C# compiler the host compiles author source with               |
| `toolchain/`                         | The qualified input validator and its pins                                 |
| `engine/serial/`, `engine/threaded/` | The native archives and their receipts                                     |
| `build/`                             | The props and targets NuGet imports into a consumer                        |

The JS runtime a browser consumer ends up serving is not carried: it is
produced by the publish, from the runtime and Emscripten revision the manifest
pins, so the host's own asset manifest digests it.

## Consuming it

Restore it from a local feed whose `nuget.config` clears every other source.
The imported props expose each payload directory as an MSBuild property, and
the imported targets refuse a consumer whose SDK is not the qualified one
before any compilation reaches the engine.

```sh
node "$(dotnet msbuild -getProperty:PicoVoxelPicoGKCompose …)" <fresh tree> \
  --patch <your patch applied first> \
  --patch <package>/base/patches/browser-handles.patch \
  --patch <your patch applied last>
```

The patch order is the consumer's, because a consumer's own patches interleave
with this package's. Omitting this package's patch is refused, so the order is
a choice and never an omission.

## Reproducing it

`node dotnet/build-package.mjs <dotnet> <NuGet cache> <PicoGK source> <serial
archive> <threaded archive> <generator assembly> <fresh output>` verifies every
input against `dotnet/inputs.json` and the archive receipts, refuses an archive
pair built from different source, stages the payload and packs it.
