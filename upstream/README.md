# Staged upstream contributions — DRAFTS, NOT POSTED

Per the picovoxel charter, outward actions (issues, PRs) require explicit
maintainer sign-off. These texts are ready to post to leap71/PicoGK and
leap71/PicoGKRuntime once approved. Line references are against PicoGK
@ 389d4d9 / PicoGKRuntime 26.2, the port's review baseline. PicoGK was
re-checked at 0e6cf6b6 on 2026-09-27: B2 (b54aef8c) and B5 (0e6cf6b6) are fixed
there and are not to be filed; see `MIGRATING-FROM-CSHARP.md` for B6.

## Two homes for patches, and the difference

| Directory | What lives there | Applied to our build? |
| --- | --- | --- |
| `patches/<dep>/*.patch` | Changes we **need** in the vendored tree to build or to ship a measured win, and which are also upstreamable | **Yes** — `scripts/fetch-deps.sh` applies every file in `patches/<dep>/` with `patch -p1` right after extraction, and folds their hash into the extraction stamp |
| `upstream/*.patch` | **Proposals.** Code we ship some other way (a sibling TU, a direct binding) shaped as a diff for the upstream repo, so the offer is a real patch and not prose | **No** — nothing in `upstream/` is ever applied locally. Adding a file here cannot change our build |

Consequence: never move a proposal into `patches/` to "tidy up". `patches/` is
build input; a file dropped there changes every artifact and invalidates every
byte pin. And never leave an upstreamable that we have already implemented as
prose only — if it is implemented, it can be a patch, and a patch is what a
maintainer can actually apply.

The ledger of what we owe upstream is `MIGRATING-FROM-CSHARP.md` §"Upstreamable
spikes ledger" (rows U1–U25). **Every patch file in either directory must be
cited by its exact path from its U-row, in the same change that lands the
patch.**

## Inventory

Dry-runs below were re-verified with `patch -p1 --dry-run --fuzz=0` against a
freshly extracted pristine tree (and, for the PicoGKRuntime proposals, the
`patches/PicoGKRuntime/`-applied tree) on 2026-09-27; every row is OK. U24
targets emscripten main rather than 5.0.1 since that date. Reproduce with
`scripts/fetch-deps.sh`-style extraction (`tar -xzf … --strip-components=1`)
plus the command in each row.

### Proposals (`upstream/` — not applied locally)

| Patch | Row | Target tree | Dry-run |
| --- | --- | --- | --- |
| `emscripten-cwrap-bigint.patch` | U16 | emscripten 5.0.1 (`vendor/emsdk/upstream/emscripten`), `src/lib/libccall.js` sha256 `0cad844a…` | `patching file 'src/lib/libccall.js'` — **OK**, 0 fuzz |
| `emscripten-heap-index-signed-shift.patch` | U24 | emscripten main @ `887305e6` (2026-09-26), `src/lib/libwebgl.js` `cce23f36…` + `libwebgl2.js` `3546fc3b…` | `patching file 'src/lib/libwebgl.js'` / `'src/lib/libwebgl2.js'` — **OK**, 0 fuzz (regenerated 2026-09-27; the 5.0.1 revision no longer applied to main) |
| `picogkruntime-bulk-mesh-abi.patch` | U4 | leap71/PicoGKRuntime @ `0f26321c` (pristine tarball) | `patching file 'API/PicoGK.h'` / `'Source/PicoGKLibrary.cpp'` — **OK**, 0 fuzz; also applies onto the `patches/PicoGKRuntime/` -applied tree |
| `picogkruntime-bulk-lattice-abi.patch` | U17 | leap71/PicoGKRuntime @ `0f26321c` | same two files — **OK**, 0 fuzz, and **OK** applied after the mesh patch |
| `picogkruntime-tubecomplex-lattice.patch` | U5 | leap71/PicoGKRuntime @ `0f26321c` | `patching file 'Source/PicoGKVdbVoxels.h'` — **OK**, 0 fuzz; also **OK** onto the `patches/PicoGKRuntime/` -applied tree. `0003-lattice-parameter-accessors.patch` is a **compile-time prerequisite** (it applies without it, it does not build without it); `0004` is optional. Verified beyond dry-run: the composed tree builds warning-clean, and the native HeatX fixture runs **2.53×** faster on the whole fixture wall (geometric mean, 30 runs per arm over six voxel sizes, `bench/results/native/BEST-CASE.md`; the single build-check run was 2.77×, `PATCHED-NATIVE.md`) |
| `picogkruntime-offset-renorm-scheme.patch` | U22 (ask 2) | leap71/PicoGKRuntime @ `0f26321c` | `patching file 'Source/PicoGKVdbVoxels.h'` — **OK**, 0 fuzz; also **OK** onto the `patches/PicoGKRuntime/` -applied tree |
| `picogkruntime-intersect-implicit-band.patch` | U1 | leap71/PicoGKRuntime @ `0f26321c` | `patching file 'Source/PicoGKVdbVoxels.h'` — **OK**, 0 fuzz; also **OK** onto the `patches/PicoGKRuntime/` -applied tree |
| `picogkruntime-zslice-seal-units.patch` | U2 | leap71/PicoGKRuntime @ `0f26321c` | `patching file 'Source/PicoGKVdbVoxels.h'` — **OK**, 0 fuzz; also **OK** onto the `patches/PicoGKRuntime/` -applied tree |

### Applied to the vendored build (`patches/` — upstreamable as-is)

| Patch | Row | Target tree | Dry-run |
| --- | --- | --- | --- |
| `patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch` | U19 | PicoGKRuntime @ `0f26321c` | `'Source/PicoGKMesh.h'` / `'Source/PicoGKVdbVoxels.h'` — **OK** |
| `patches/PicoGKRuntime/0002-post-fill-prune.patch` | U21 | PicoGKRuntime @ `0f26321c`, after the flatten patch | `'Source/PicoGKVdbVoxels.h'` — **OK** |
| `patches/PicoGKRuntime/0003-lattice-parameter-accessors.patch` | U5 (U18-adjacent) | PicoGKRuntime @ `0f26321c` | `'Source/PicoGKLattice.h'` — **OK** |
| `patches/PicoGKRuntime/0004-lattice-beam-value-storage.patch` | U18 (ingest half) | PicoGKRuntime @ `0f26321c`, after 0001/0002 | `'Source/PicoGKLattice.h'` / `'Source/PicoGKVdbVoxels.h'` — **OK** (verified by full fetch-deps replay, byte-identical tree) |
| `patches/openvdb/0001-flat-quad-output.patch` | U19 / U10 | AcademySoftwareFoundation/openvdb @ `7c03e1f0` | `'openvdb/openvdb/tools/VolumeToMesh.h'` — **OK** |
| `patches/oneTBB/0001-wasm-substrate-edges.patch` | U13 (hunk 1) / U14 (hunk 2) / U15 (hunk 3) | uxlfoundation/oneTBB @ `06ce6212` | `'include/oneapi/tbb/detail/_machine.h'` / `'src/tbb/governor.cpp'` / `'cmake/compilers/Clang.cmake'` — **OK** |

Patch order is the numeric prefix: `fetch-deps.sh` globs `patches/<dep>/*.patch`
alphabetically, and since 2026-07-27 every series is uniquely numbered
(0001…000N) so the ordering is explicit rather than a name tiebreak. Patches
apply with `--fuzz=0`: an approximate context match is a hard conflict, never
a silent application.

### Issue and PR texts

| Document | Target | Row |
| --- | --- | --- |
| `issue-b1-mesh-transform-scale.md` | leap71/PicoGK | B1 |
| `issue-b2-mm-to-voxels.md` | leap71/PicoGK | B2 — **fixed upstream in `b54aef8c` (2026-08-22); do not file** |
| `issue-b3-addbeam-overloads.md` | leap71/PicoGK | B3 |
| `issue-b4-voxshell-discarded-results.md` | leap71/PicoGK | B4 |
| `pr-bulk-mesh-transfer.md` | leap71/PicoGKRuntime (+ the C# half in leap71/PicoGK) | U4 — the C ABI half is now `picogkruntime-bulk-mesh-abi.patch`; this text carries the rationale and the C#-side change, which targets the other repo |
| `pr-offset-renorm-default.md` | leap71/PicoGKRuntime | U22 (ask 2) — the ready-to-post body for `picogkruntime-offset-renorm-scheme.patch`; ask 1 (settings parameter) deliberately offered as a follow-up, not diffed |

## What a PR should ship with

Under the geometry-parity regime (`NON-DETERMINISM.md`), the evidence a
picovoxel patch carries is stronger than a byte diff and should be offered as
such: the G0 identity tuple (canonical grid hash, volume as hex float64,
active-voxel and triangle/vertex counts, order-invariant mesh multiset hash) as
run-to-run triples and single≡multi differentials at fine cells (≤0.7 mm), plus
the SK-0.8-shaped tolerance gates with `tools::checkLevelSet` EMPTY as a hard
boolean wherever the patch is allowed to change values. Say which class the
change is (0 = byte-identical, 1 = same geometry different order, 2 = bounded
numeric drift) and show the oracle that establishes it.
