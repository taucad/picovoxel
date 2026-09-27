# SK-0.10 — the "stale quad slot" defect: root cause, fix, and the mimalloc MT re-verdict

**Date**: 2026-07-27 · **Branch**: `webgpu` · **Tree under test**: `646692e` + this spike
(working tree otherwise clean apart from the three never-staged operator files)
**Closes**: SK-0.9 §5's open localization and §7.1/§7.2, `NON-DETERMINISM.md`
§11.1 (again, and this time with the mechanism), §11.2, §12.3.

## Verdict

**The defect is not in either extraction patch, not in OpenVDB, and not in the
allocator. It is one character in `src/mesh.ts`.**

```
module.HEAPU32.subarray(trianglePointer >> 2, …)     // signed
module.HEAPU32.subarray(trianglePointer >>> 2, …)    // unsigned
```

A wasm pointer at or past 2 GiB is `>= 2**31`. JS `>>` coerces its operand to
**int32** first, so `2537619456 >> 2` is `-439336960`, and
`TypedArray.subarray` **clamps** a negative start (`length + start`) instead of
throwing. The read therefore succeeds, returns an array of exactly the right
length, and is a window one to two gigabytes away from the buffer the mesh was
copied into. Triangle count, STL byte count and volume hex all come from wasm
and stay correct; only the index *contents* are somebody else's memory.

mimalloc's role is that it puts the 120 MB triangle staging buffer above 2 GiB
on this fixture and dlmalloc does not. **dlmalloc was never immune — it was
lucky about an address**, and a ballast allocation that moves the same buffer
past 2 GiB reproduces the identical corruption on the dlmalloc build (§4).

It also explains the *other* open item. SK-0.1's single-path divergence
(`0ccaa277` vs `38cad381`, identical volume hex and triangle count) was this
same defect: running the retired serial lattice lane at the historic cell on
both allocators, on the fixed tree, gives **one byte stream** (§8A).

**Consequence for the program**: with the fix, 32 runs across four
(cell, lane) combinations produce **four byte streams — exactly one each**,
with dlmalloc and mimalloc, single and multi, all agreeing.
`NON-DETERMINISM.md` §11.1 and §11.2 are both closed; the 1.208× and the SK-0.6
mesh-extraction headroom become **spendable pending the exit-baseline
measurement**. No default is flipped in this spike.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 (macOS 26.5.2) / v26.5.0 |
| Power | **AC**, `lowpowermode 0` |
| 1-min load at run starts | 2.9 – 21 (uncontrolled) |
| emcc | 5.0.1 (vendored emsdk) |

Determinism run. No wall-clock claim is made anywhere in this document; the
`taskMs` column in the raw records must not be quoted as a benchmark. Load is
not a confound: the fixed configurations returned bit-exact matches across the
whole load range that the broken ones diverged over.

## 1. Code-first hypothesis pass

Read before any build: `patches/openvdb/0001-flat-quad-output.patch`,
`patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch`, and upstream
`VolumeToMesh.h` passes `ComputeAuxiliaryData`, `LeafNodePointCount`,
`ComputePoints`, `ComputePolygons`, `constructPolygons`, `UniformPrimBuilder`.

Every site where a slot can be consumed without a guaranteed write:

| # | site | can a consumed slot be unwritten? |
| --- | --- | --- |
| 1 | `mFlatQuads` slack (`new Vec4I[sum]`, `Vec4` default-ctor does not initialise) | **No.** The consumer reads `flatQuads() + flatQuadLeafOffsets()[n]` for exactly `flatQuadLeafCounts()[n]` entries, and `mCounts[n] = mesher.done()` is the count the emitter actually reached. Slack is allocated, never read. |
| 2 | count/emit predicate disagreement (`CountUniformQuadBounds` XEDGE\|YEDGE\|ZEDGE vs `ComputeFlatQuads`' `flags & 0xE00`) | **No.** `XEDGE\|YEDGE\|ZEDGE == 0xE00`, and both loops walk the same `node.cbeginValueOn()`. The count loop is a byte-for-byte copy of the pool path's own upper bound (`VolumeToMesh.h:4123-4129`), and `constructPolygons` emits at most one quad per set edge flag. Emission ≤ bound, by construction. |
| 3 | producer/consumer offset mismatch | **No.** Both sides read the same `mFlatQuadOffsets` / `mFlatQuadCounts` vectors; there is no second epoch and no reallocation between the emit pass and `roAsMesh`. |
| 4 | `Mesh::BulkResize`'s deliberately-uninitialised `Triangle` array | **No.** The flat lambda writes `2 * anCounts[n]` triangles at `2 * anQuadBase[n]`, and `anQuadBase` is the prefix sum of the same `anCounts`. Coverage is `2 * nQuads`, which is exactly what `BulkResize` allocated. |
| 5 | upstream point-index assignment (`ComputePoints` skips a voxel whose id is already non-zero, leaving `INVALID_IDX` behind for `constructPolygons` to emit) | **Plausible on paper** — this is the only path that can put a genuine `INVALID_IDX` into a quad. But `ComputeAuxiliaryData` explicitly zero-fills every ON voxel of each freshly touched index leaf (`VolumeToMesh.h:3893-3899`), so the precondition holds. |

Three observations from SK-0.9's own numbers argued against the whole class
before a single build:

- **~92% of quads corrupt is not slack.** Slack is the difference between an
  edge-count bound and the emitted count — percent, not 92 percent.
- **`nanVertices == 0`.** If ~92% of voxels had been skipped, ~13.6 M vertex
  floats would be uninitialised, and uniformly random 32-bit words are NaN about
  1 time in 256 — ~50 k NaNs expected, zero observed. The vertex array is fully
  and correctly written, which is hard to reconcile with anything that goes
  wrong *inside* the mesher.
- **`maxIndex == 0xFFFFFFFF` is not evidence of `INVALID_IDX`.** Re-measured
  here, only 98 k – 541 k of ~27 M out-of-range indices are actually
  `0xFFFFFFFF`; the rest are float bit patterns clustered around `0xBF…`
  (≈ −0.6 … −1.4), i.e. narrow-band SDF values. SK-0.9 read a maximum as a mode.
  **That single inference is what pointed the diagnosis at OpenVDB.**

## 2. The sentinel probe — every wasm-side hypothesis falsified in one build

Rather than the chartered three-cell patch-toggle matrix (which would have cost
two clean dependency rebuilds and could only rank three hypotheses), one
instrumented build answers the prior question directly: *are any consumed slots
unwritten at all?*

`-DPICOVOXEL_SENTINEL_PROBE`, mimalloc MT:

- `VolumeToMesh.h`, immediately after `mFlatQuads.reset(new Vec4I[sum])`:
  `memset(…, 0xAB, sum * sizeof(Vec4I))`.
- `PicoGKVdbVoxels.h` `roAsMesh()`, immediately after `BulkResize`:
  `memset(aTris, 0xCD, …)`; then, before `FinalizeBulk`, scan **the ranges the
  consumer actually reads** and count sentinels, `INVALID_IDX`, and
  out-of-range values.

Both edits were reverted after the run; the openvdb one was applied to the
installed prefix header (`build/wasm-prefix-mt/include/…`) rather than to
`patches/`, so H1/H1b did not apply and no dependency rebuild was needed.

HeatX @0.5 mm, mimalloc multi, on the run that produced 27.7 M out-of-range
indices in JS:

```
[sk010] leaves=22100 points=4928264 quads=5023994 slack=0 \
        quadSentinel=0 quadInvalid=0 quadOob=0
[sk010] triIndices=30143964 triSentinel=0 triQuadSentinel=0 triOob=0
```

**Zero sentinels survive, zero `INVALID_IDX`, zero out-of-range indices — and
`slack == 0`, so the upper bound was exact for every one of the 22,100 leaves.**
Inside wasm the mesh is perfect. The corruption is entirely downstream of
`roAsMesh`, on the JS readback.

This falsifies candidates (a) flat-quad patch, (b) parallel-flatten patch,
(c) upstream `VolumeToMesh`, and (d) the oneTBB substrate *simultaneously*, which
is strictly more than the toggle matrix could have shown. The matrix was
therefore not run; the reason is recorded here rather than as a silent omission.

## 3. Root cause

`src/mesh.ts`, `wrapMesh().readAll()` — the defective lines as they stood:

```ts
const vertexPointer   = checkedMalloc(module, vertexCount * VEC3_BYTES, 'mesh vertices');
const trianglePointer = checkedMalloc(module, triangleCount * TRI_BYTES, 'mesh triangles');
raw.Mesh_GetVertices(lib, handle, vertexPointer, vertexCount);
raw.Mesh_GetTriangles(lib, handle, trianglePointer, triangleCount);
return {
  vertices:  new Float32Array(module.HEAPF32.subarray(vertexPointer >> 2,   (vertexPointer >> 2)   + vertexCount * 3)),
  triangles: new Uint32Array(module.HEAPU32.subarray(trianglePointer >> 2, (trianglePointer >> 2) + triangleCount * 3)),
};
```

Instrumenting `module._malloc` on the corrupt mimalloc run gives the whole
mechanism in two rows:

| staging buffer | bytes | pointer | `>= 2**31`? | result |
| --- | ---: | ---: | :---: | --- |
| mesh vertices | 59,139,168 | 2,139,160,576 | **no** — 7.9 MiB under the line | correct |
| mesh triangles | 120,575,856 | 2,537,619,456 | **yes** | `>> 2` → `-439336960` → `subarray` clamps → wrong window |

The clamp is `max(length + start, 0)`, so the window lands exactly
`(4 GiB − heapBytes)` **below** the real buffer — 1.38 GiB on that run
(`heapBytes = 2,810,970,112`), and a different distance on every run, which is
why four corrupt runs produced four different hashes. The length is correct
either way, so nothing downstream notices.

That is the entire "vertices intact, indices garbage" signature SK-0.9 recorded,
and the entire allocator dependence: dlmalloc placed the same buffer below 2 GiB
on this fixture, mimalloc above it. The bytes read back are narrow-band
`FloatGrid` leaf buffers, which is why the out-of-range "indices" decode as
floats near −1. Values that happen to land under `vertexCount` (mostly zeros
from untouched pages) become degenerate `(0,0,0)` facets, whose recomputed
normal is `normalize(0)` — the residual NaN records that are *not* accounted for
by out-of-range indices.

Two properties make this the worst possible failure mode and explain why five
prior spikes walked past it:

1. **It is silent.** `subarray` clamps; only `TypedArray.set` throws on a
   negative offset. So the write side (`bulkCreateMesh`, `Lattice_AddBeams`,
   the SDF tape upload) would have failed loudly with a `RangeError`; the read
   side returns plausible garbage.
2. **Every cheap invariant still passes.** Volume hex, triangle count, vertex
   count and STL byte count are all computed in wasm or from counts, and all
   match the reference bit-for-bit.

### Scope: this was never a mimalloc-only bug

The same expression is used at 39 sites across `src/`. Every one is a wasm
pointer indexing a heap view, and every one is wrong above 2 GiB. The dlmalloc
default reaches 2.2–2.8 GiB peak heap on the 0.5 mm HeatX fixture already; it is
one fixture, one voxel size, or one extra intermediate away from the same
silent corruption. **This is a live production defect that presented as a
latent, allocator-specific one.**

## 4. Sentinel probe #2 — dlmalloc is not immune, it is lucky

The chartered probe (poison dlmalloc allocations with `0xAB` via a malloc
interposer) tests the hypothesis this spike falsified in §2, so it was replaced
by the probe that tests the hypothesis that survived: *is the allocator deciding
anything except the address?*

`bench/sk010-pointer-probe.mjs` runs the real facade readback, defers `_free`
so the staging buffer survives, then materialises the **same wasm buffer** twice
— once with `>>> 2` and once with the pre-fix `>> 2` — and counts out-of-range
indices in each. `--ballast N` pre-allocates N bytes that are never freed, which
moves the staging pointer without touching anything else.

HeatX @0.5 mm multi, one run per row, on the **fixed** tree (so
`oobUnsignedShift` is what the library now returns and `oobSignedShift` is what
it returned before, from the same bytes):

| build | ballast | staging pointer | `>= 2 GiB`? | heap | OOB via `>>> 2` | OOB via `>> 2` |
| --- | ---: | ---: | :---: | ---: | ---: | ---: |
| mimalloc multi | 0 | 2,537,619,456 | **yes** | 2.62 GiB | **0** | **26,542,663** |
| dlmalloc multi | 0 | 1,834,186,936 | no (313 MB under) | 2.12 GiB | 0 | 0 |
| dlmalloc multi | 400 MiB | 2,542,764,608 | **yes** | 2.57 GiB | **0** | **29,260,593** |

Three readings:

1. **The allocator decides nothing but the address.** dlmalloc lands the 120 MB
   staging buffer 313 MB below the line on this fixture; mimalloc lands it
   390 MB above. Give dlmalloc 400 MiB of ballast and it produces the identical
   corruption — 29.3 M out-of-range indices out of 30.1 M.
2. **The chartered poisoned-dlmalloc probe would have measured the wrong
   thing.** Poisoning `malloc` tests "is a slot read before it is written",
   which §2 already answered *no* with a sentinel that survives nothing. This
   probe tests the hypothesis that survived, and it is the one that matters:
   dlmalloc's cleanliness is a property of one fixture at one voxel size, not of
   the allocator.
3. **`oobUnsignedShift == 0` in all three rows is the fix, verified against the
   defect's own instrument** — same process, same wasm buffer, two shifts, one
   of them right.


## 5. The fix

| file | pointer shifts fixed |
| --- | ---: |
| `src/voxels.ts` | 10 |
| `src/fields.ts` | 7 |
| `src/session.ts` | 7 |
| `src/mesh.ts` | 6 |
| `src/context.ts` | 3 (+ the invariant doc on `checkedMalloc`) |
| `src/lattice.ts` | 3 |
| `src/polyline.ts` | 2 |
| `src/metadata.ts` | 1 |

Every `pointer >> 2` / `pointer >> 3` in `src/` becomes `>>> 2` / `>>> 3` —
**39 shifts on 33 lines across 8 files**, no other change. `>>>` is correct for
both possible `_malloc` return conventions: `2537619456 >>> 2` and
`(-1757347840) >>> 2` are both `634404864`, so the fix does not depend on
whether emsdk returns the i32 signed or unsigned.

The same three-line change went into `spikes/webgpu/{p1-vdb-transport,
p2-tape-gpu,spike-runtime}.ts`. Those are spikes, not shipped surface — but they
are precisely the code that will stage hundred-megabyte buffers for the GPU port,
which is where this defect class gets *more* likely, not less. Fixing them costs
8 lines now and a repeat of this spike later.

Not done, deliberately:

- **No `>>> 0` normalisation in `checkedMalloc`.** The emsdk 5.0.1 export
  already returns the pointer unsigned, and `>>>` at the index site is correct
  either way, so the normalisation would be a second guard for a case the first
  one already covers. The invariant is documented on `checkedMalloc` instead,
  because that is where every library allocation funnels.
- **No helper/abstraction.** Thirty-nine call sites of `>>> 2` do not want a
  wrapper; a wrapper would only move the operator somewhere less obvious.
- **`test/`, `bench/` and `demo/` left alone.** They are harnesses over
  kilobyte allocations. The guard below covers `src/`, which is what ships.

### The regression guard

Reproducing this needs a 2.8 GiB heap and ~40 s of meshing — no unit test can
afford it, and coverage cannot see it (the line executes, it just computes the
wrong index). So the invariant is pinned at the source, in
`test/surface-manifest.test.ts` beside the other backstop coverage cannot see:
`no wasm pointer is indexed with a signed shift` walks `src/**/*.ts` and fails
on any `>> 2` / `>> 3` that is not `>>>`.

## 6. Re-verdict

All runs on the fixed tree, one run per process, oracle
`bench/stl-identity.mjs run`. Records in
`bench/results/webgpu-v2/sk-0.10-oracle.jsonl`.

### Multi-thread: mimalloc vs the dlmalloc reference

Identity is stated in `sha256` over the whole STL stream (the strongest field,
and the one directly comparable to SK-0.9's tables — the `multiset` construction
changed in §7). `nonFinite` is `nonFiniteRecords`.

| cell | build | runs | triangles | volume hex | sha256 | multiset (16) | nonFinite | distinct streams | peak heap |
| ---: | --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |
| 0.5 | dlmalloc multi | 3 | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | `5004008b41709536` | 0 | **1** | 2.13 GiB |
| 0.5 | **mimalloc multi** | **5** | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | `5004008b41709536` | 0 | **1** | 2.75 GiB |
| 0.6 | dlmalloc multi | 3 | 6,560,024 | `4121db1ee0000000` | `1a9864eae4c5…` | `5c4254592f31a9fd` | 0 | **1** | 1.62 GiB |
| 0.6 | **mimalloc multi** | **5** | 6,560,024 | `4121db1ee0000000` | `1a9864eae4c5…` | `5c4254592f31a9fd` | 0 | **1** | 2.23 GiB |
| 0.7 | dlmalloc multi | 3 | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `4f2a102033402c30` | 0 | **1** | 1.29 GiB |
| 0.7 | **mimalloc multi** | **5** | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `4f2a102033402c30` | 0 | **1** | 1.58 GiB |

Twenty-four runs, **three byte streams — one per cell**, and each is the value
SK-0.9 recorded for the dlmalloc reference (`5d9fa0ee582a…`, `1a9864eae4c5…`,
`8f2eb25972e1…`). Compare SK-0.9 §4: four mimalloc runs at 0.5 mm, four distinct
multiset hashes, 91.9% NaN records.

| question | SK-0.9 | now |
| --- | --- | --- |
| mimalloc multi byte-stable? | no — 4 runs, 4 streams @0.5 mm | **yes** — 5/5 per cell, 3 cells |
| mimalloc multi geometry-stable? | no — 4 multisets | **yes** — one multiset per cell |
| mimalloc multi *correct*? | no — 91.9% NaN @0.5 mm, trap @0.6 mm | **yes** — `nonFiniteRecords == 0` in 15/15, no trap in 15/15 |
| dlmalloc byte-identity preserved by the fix? | — | **yes** — 9/9 ≡ the SK-0.9 references at all three cells |
| is the 1.208× spendable? | no | **yes, pending the exit-baseline measurement** |

**The 0.6 mm trap did not recur** in 5 runs (SK-0.9 saw it in 1 of 2). It is not
explained by this root cause — a negative `subarray` start clamps rather than
traps, and a negative `TypedArray.set` offset raises a JS `RangeError`, not
`SIGILL`. Recorded as unreproduced rather than fixed; the honest statement is
that the configuration which produced it no longer produces it in 5 attempts,
and no wasm-side defect survived §2's probe.

### Single-thread, and the full identity picture

| cell | lane | build | runs | triangles | volume hex | sha256 | nonFinite |
| ---: | --- | --- | ---: | ---: | --- | --- | ---: |
| 0.5 | tube (default) | dlmalloc single | 1 | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | 0 |
| 0.5 | tube (default) | mimalloc single | 3 | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | 0 |
| 0.7 | tube (default) | dlmalloc single | 1 | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | 0 |
| 0.7 | tube (default) | mimalloc single | 1 | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | 0 |
| 0.5 | **serial (`PICOVOXEL_SERIAL_LATTICE=1`)** | dlmalloc single | 1 | 10,048,032 | `4121d9c600000000` | `b9ebd7b20ed1…` | 0 |
| 0.5 | **serial (`PICOVOXEL_SERIAL_LATTICE=1`)** | mimalloc single | 1 | 10,048,032 | `4121d9c600000000` | `b9ebd7b20ed1…` | 0 |

**Thirty-two runs, four byte streams — exactly one per (cell, lane).** Every
combination of {dlmalloc, mimalloc} × {single, multi} that shares a cell and a
lane produces the same bytes:

| cell | lane | runs | distinct streams |
| ---: | --- | ---: | ---: |
| 0.5 | tube | 12 (dl×4, mi×8) | **1** — `5d9fa0ee582a…` |
| 0.6 | tube | 8 (dl×3, mi×5) | **1** — `1a9864eae4c5…` |
| 0.7 | tube | 10 (dl×4, mi×6) | **1** — `8f2eb25972e1…` |
| 0.5 | serial lattice | 2 (dl×1, mi×1) | **1** — `b9ebd7b20ed1…` |

`NON-DETERMINISM.md` §11.1 is closed on the fixed tree with far more coverage
than it asked for.

## 7. Hash reconciliation with `NON-DETERMINISM.md` §14.5

`bench/stl-identity.mjs` now follows §14.5 on the two points SK-0.9 deviated on:

| §14.5 | before (SK-0.9) | now |
| --- | --- | --- |
| 36-byte vertex-only payload | 48 bytes incl. the recomputed normal | **36 bytes**, normal dropped |
| canonicalize `−0.0 → +0.0`, `NaN → 0x7fc00000` before hashing | raw f32 bits | **canonicalized** |
| 128-bit xxh3/BLAKE3 per record | SHA-256 | SHA-256 (kept — node stdlib, no dependency, strictly stronger) |
| record count folded into the hash | sibling field `triangles` | sibling field `triangles` (kept — equivalent discriminating power when the two are compared together) |

`nonFiniteRecords` stays a **separate hard health boolean**, computed from the
raw f32 before canonicalization. This is the load-bearing part of the
reconciliation: canonicalization collapses every NaN payload to one value, so a
hash alone can no longer distinguish "one NaN" from "another NaN" — but it never
could hide that a NaN is not a finite coordinate, and the counter is what turned
SK-0.9's "the multiset moved" into a diagnosis. The selftest now asserts both
directions: NaN payloads hash alike **and** `nonFiniteRecords` still counts them.

`node bench/stl-identity.mjs selftest` gained four checks — normal-independence,
`−0.0` folding, NaN folding, and `+Inf` is not a NaN — each paired with an
assertion that the two streams really do differ byte-wise, so a no-op
construction cannot pass by accident.

### Hashes this invalidates

**Every `multiset` value recorded before this change is in the old 48-byte
uncanonicalized construction and is not comparable to any value in this
document.** Specifically:

- `bench/results/webgpu-v2/SK-0.9.md` §4, both tables (the `multiset (16)`
  column: `b1a6c4fc16709000`, `2c84efb61209a29e`, `ab9022b5cd6e8cbe`,
  `286f79c6ce7ddfe8`, `2951e8cf66bf76bd`, `f5b926dc3a2fff69`).
- `bench/results/webgpu-v2/sk-0.9-oracle.jsonl`, all 17 records.

Neither is rewritten: they are evidence of runs that happened, and the jsonl is
sha256-pinned in SK-0.9.md. SK-0.9.md §1 carries a one-line pointer here. No
other document quotes a multiset hash (`stlFnv`, `sha256` and `volumeHex` are
untouched by this change and remain directly comparable across both documents —
which is why the dlmalloc byte-identity check in §6 is stated in `sha256`).

## 8. Post-mortem items from SK-0.9 §7

### A. `PICOVOXEL_SERIAL_LATTICE=1` A/B at 0.5 mm, single, dlmalloc vs mimalloc

SK-0.9 §3 attributed the historic SK-0.1 single-path divergence (`0ccaa277` vs
`38cad381`, identical volume hex and triangle count, different STL bytes) to the
retired serial `Voxels_RenderLattice` lane, by displacement: the divergence
stopped reproducing once SK-0.4 replaced that lane, so the divergence must have
lived there.

**That attribution is now doubtful, and for a reason SK-0.9 could not have
had.** "Identical volume hex, identical triangle count, different STL bytes" is
the exact signature of the defect rooted in §3 — and SK-0.1's 0.5 mm runs sat in
the same 2–3 GiB peak-heap band where the triangle staging pointer straddles
2 GiB. The simplest account of `0ccaa277` vs `38cad381` is therefore not the
lattice lane at all: it is dlmalloc and mimalloc landing that one buffer on
opposite sides of the line, exactly as measured in §4. The lane change altered
the mesh size, which moved the pointer, which is why it "stopped reproducing".

**Run, and it settles the question the other way.** Both arms on the fixed tree,
0.5 mm, single, `PICOVOXEL_SERIAL_LATTICE=1`:

| build | triangles | volume hex | sha256 | multiset (16) | nonFinite |
| --- | ---: | --- | --- | --- | ---: |
| dlmalloc single | 10,048,032 | `4121d9c600000000` | `b9ebd7b20ed1…` | `abbf6646e659083e` | 0 |
| mimalloc single | 10,048,032 | `4121d9c600000000` | `b9ebd7b20ed1…` | `abbf6646e659083e` | 0 |

**Byte-identical.** And the triangle count is **10,048,032** — SK-0.1's number
exactly, the one the tube lane moved to 10,047,988. So this really is the lane
that carried the historic divergence, reproduced at the historic cell, on both
allocators — **and it does not diverge**.

Conclusion: the retired serial `Voxels_RenderLattice` lane is *not*
allocator-dependent. SK-0.9's attribution of `0ccaa277` vs `38cad381` to that
lane was wrong; SK-0.4's lane replacement did not fix the divergence, it moved
the mesh size, which moved the staging pointer, which stopped the readback bug
from firing. **`0ccaa277` vs `38cad381` was this defect all along** — the same
"identical volume hex, identical triangle count, different STL bytes" signature,
in the same 2–3 GiB peak-heap band, one allocator on each side of 2 GiB.

That closes SK-0.9 §7.1 and, with it, the last loose thread of
`NON-DETERMINISM.md` §11.1: there is no second mechanism to hunt.

### B. mimalloc single at 0.5 mm, repeat stability (SK-0.9 §7.2)

Three runs, mimalloc single, 0.5 mm, default lane: one byte stream
(`5d9fa0ee582a…`), `nonFiniteRecords: 0` in all three, and it is the dlmalloc
value. SK-0.9 measured this configuration once; it is now measured three times
plus five more through the multi build at the same cell.

### C. `nonFiniteRecords` back-fill (SK-0.9 §7.4)

Not actionable: the eight SK-0.9 records that predate the counter cannot gain it
retroactively without re-running them, and every configuration they covered has
been re-run here with the counter present. All 24 multi records in
`sk-0.10-oracle.jsonl` carry `nonFiniteRecords: 0`.


## 9. What this changes about the SK-0.9 record

SK-0.9's *measurements* all stand. Its two inferential steps do not:

1. **"max index = `0xFFFFFFFF` = `util::INVALID_IDX`, therefore OpenVDB."** The
   maximum of a garbage distribution is not its mode. `0xFFFFFFFF` is 0.4%–2% of
   the out-of-range values; the bulk are float bit patterns.
2. **"dlmalloc's zero-filled fresh pages mask it, mimalloc's recycled segments
   expose it."** Backwards. The stale bytes are *read from* a region dlmalloc and
   mimalloc both populate identically; what differs is only where the staging
   buffer lands relative to 2 GiB.
3. **"The §11.1 divergence tracked the retired serial lattice lane" (§3).** §8A
   runs that lane at the historic cell on both allocators and gets one byte
   stream. The lane replacement moved the mesh size, which moved the pointer,
   which stopped the *readback* from firing — a localization by displacement
   that displaced the wrong variable.

SK-0.9's methodological calls were right and are what made this findable in one
pass: `nonFiniteRecords` as a health boolean separate from the hash, refusing to
attempt a fix before the diagnosis named a line, and declining the ASan route
(which would have replaced the allocator and measured nothing — correct, and
for a better reason than the one given: there was never an allocator bug).

## Files

- `src/mesh.ts` + 7 siblings — the fix.
- `test/surface-manifest.test.ts` — the regression guard.
- `bench/stl-identity.mjs` — §14.5-reconciled oracle.
- `bench/sk010-probe.mjs` — mesh index forensics (OOB value histogram, quad-shape
  provenance test, `_malloc` pointer log).
- `bench/sk010-pointer-probe.mjs` — the ballast/two-shift sentinel probe.
- `bench/sk010-matrix.sh` — artifact-swapping re-verdict driver.
- `bench/results/webgpu-v2/sk-0.10-oracle.jsonl` — 32 run records.

```
9a16dfa127ce48c6cd203bdfb62481ba673e939a11a6298fc4f389392bdfa7de  sk-0.10-oracle.jsonl
```

```
node bench/stl-identity.mjs selftest
node bench/stl-identity.mjs run --build multi --size 0.5 --label x --jsonl out.jsonl
node bench/sk010-pointer-probe.mjs --build multi --size 0.5 --ballast 419430400
```
