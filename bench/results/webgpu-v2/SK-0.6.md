# SK-0.6 — extraction repair: parallel disjoint-slot mesh flattening

Spike SK-0.6 of the V2 spike charter (★ core, Fable-implemented). Repairs the
serial walls around `openvdb::tools::volumeToMesh` without touching the mesher's
topology or output bytes.

## What was wrong

The extraction path stacked four serial copy passes on top of an already-parallel
mesher (`docs/research/picogk-runtime-performance-deficiency-audit.md` F16
cluster; `gpu-surface-extraction-survey.md` §disjoint-slot):

1. `doVolumeToMesh` (openvdb) copies primitives out of the per-leaf
   `PolygonPool`s one element at a time on one thread (`VolumeToMesh.h:4657-4668`).
2. `roAsMesh` (PicoGKRuntime) split quads via unreserved `push_back`,
3. re-copied every point through `nAddVertex` (per-vertex bbox update), and
4. re-copied every triangle through `nAddTriangle` (per-element asserts).

Points, by contrast, already used count → prefix-sum → disjoint slots inside the
mesher — exactly the asymmetry the surface-extraction survey named.

## The repair

`patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch` (applied at
extract time by `fetch-deps.sh`, hash-stamped like the oneTBB patches):

- `PicoGKMesh.h`: bulk-construction seam (`BulkResize` / `aVertexData` /
  `aTriangleData` / `FinalizeBulk`). `Vector3` has no default constructor, so
  `BulkResize` fill-resizes with the copy constructor; `Triangle`(=`Coord`)
  default-constructs uninitialized in release, so the triangle array costs one
  allocation and no fill.
- `PicoGKVdbVoxels.h` `roAsMesh()`: drives the public `VolumeToMesh` class
  directly (same ctor args as before: iso 0, adaptivity 0, no relaxation), then
  pool-indexed count → prefix sum → `tbb::parallel_for` emission into pre-sized
  disjoint slots, and a `tbb::parallel_reduce` point copy + bbox.

Output-byte preservation, by construction and verified:

- points in point-list order (indices unchanged);
- native triangles in pool order, then the two split triangles per quad in pool
  order — the exact concatenation the serial path produced;
- same winding reversal (`(t2,t1,t0)`; quads → `(q2,q1,q0)`,`(q0,q3,q2)`);
- bbox via `Include` = pure per-axis min/max ⇒ reduction order-independent
  bit-for-bit; `m_nMemUsage` reproduced arithmetically.

The emission layout (pool-indexed offset table + disjoint slots) is the shape
the WGSL port consumes unchanged (survey R6, OCCT L1/L4 lineage). It also makes
primitive emission order independent of allocation order — the property whose
absence produced the mimalloc NO-GO in SK-0.1 (the mesher's *internal* point
indexing retains its own ordering behavior; re-testing mimalloc byte-stability
is a separate follow-up, not claimed here).

## Verification

- Patch round-trip: pristine tarball + patch ⇒ byte-identical to the developed
  tree (`PATCH-ROUNDTRIP-OK`); `fetch-deps.sh` re-extract order verified
  (PicoGKRuntime before nested openvdb).
- Suite: **453/453 green, coverage 100%** (statements/branches/functions/lines)
  on both variants rebuilt with the patch (serial + `THREADS=1` MT prefix built
  fresh in this worktree).
- **Byte-locked example pins untouched and passing** — L0 parity holds on both
  variants.

## Second repair: flat quad output inside the mesher

The first flatten alone moved 12T only 28.1 ← 33.0 ms. A temporary phase probe
inside `VolumeToMesh::operator()` (removed before commit) attributed the
residual on the M10 gyroid at 12T:

| phase | ms (12T) | what it is |
|---|---:|---|
| identify | 5.4 | intersection bool-tree build |
| auxdata | 7.7 | sign + index tree build |
| points | 3.1 | disjoint-slot point emission (upstream) |
| polygons | 2.1–3.4 | quad emission (after this spike) |
| treeclear | 5.9 | sign/index tree teardown |

The polygon pass itself was also allocation-bound (2 `new[]` per leaf +
trim, serialized on the allocator lock at 12T), which motivated the second
patch: `patches/openvdb/0001-flat-quad-output.patch` — opt-in
`enableFlatQuadOutput()` on the uniform path: parallel per-leaf upper-bound
count (the same edge count the pools were sized with) → prefix sum → parallel
emission into per-leaf slot ranges of ONE shared array, exact counts recorded.
Identical per-leaf loop and order; `roAsMesh` consumes flat+counts directly.

## Timing (M10 gyroid @0.25 mm, toMesh() phase only, M2 Pro 12T, AC, lowpowermode 0)

ABAB artifact swap (A = pristine vendor built same-toolchain minutes apart;
B = both patches), 12 repeats + 2 discarded warmups per block, via
`bench/mesh-scaling-ab.mjs`. All four blocks byte-identical
(`538668:a3e35a9c528821e5` — triangleCount:STL-sha16).

| | A1 | B1 | A2 | B2 | verdict |
|---|---:|---:|---:|---:|---|
| single | 43.19 | 38.35 | 43.35 | 38.43 | **1.13×**, disjoint ranges |
| multi (12T) | 33.05 | 23.60 | 32.84 | 24.36 | **1.37×**, disjoint ranges |
| scaling ST→12T | 1.31× | 1.63× | 1.32× | 1.58× | **1.31× → 1.60×** |

**Exit bar ≥4× at 12T: MISSED on the dlmalloc build — 1.60×, with attribution.**
The bar was calibrated against the copy hypothesis; the copies are repaired
(the extraction passes proper now scale), and 79% of the residual 24 ms is
tree lifecycle (identify/auxdata/treeclear ≈ 19 ms) — node-granular
allocation/deallocation through dlmalloc's global mutex. That wall belongs to
the S-A substrate (IndexGrid) and the allocator, not to extraction.

## mimalloc probe: the bar is met when the allocator scales

`MALLOC=mimalloc` multi build of the SAME patched tree, three separate
processes × 8 in-process meshings, dlmalloc artifacts restored afterwards:

- multi mesh: **9.97 / 9.62 / 10.50 ms** → ST→12T scaling ≈ **3.9×**
  (3.3× vs pristine-dlmalloc 12T)
- identity: **byte-identical in all runs and equal to the dlmalloc hash** —
  emission order is now provably allocation-independent on this fixture.

Implication: SK-0.1's mimalloc NO-GO was blocked exactly on mesh-byte
nondeterminism; this spike removes that mechanism. A full re-run of SK-0.1's
0.5 mm HeatX cross-build sweep on the patched tree is the remaining gate for
revisiting the default — this probe is evidence toward it, not the reversal
(different fixture: M10 gyroid @0.25 mm, not HeatX @0.5 mm).

## Deviations

- Roundtrip re-validation exists because the A-side rebuild wiped the
  in-development vendor edits before the openvdb patch file had been
  generated; the edits were reapplied from records and both patches now
  round-trip from pristine tarballs (`FULL-PATCH-ROUNDTRIP-OK`), rebuilt and
  re-verified (identity + 456/456 suite). Lesson recorded: generate the patch
  file in the same step as the vendor edit.
- Header install: the module build compiles against
  `build/wasm-prefix*/include`; after changing `patches/openvdb/`, re-run
  `scripts/build-deps-wasm.sh` (noted in the patch header).
