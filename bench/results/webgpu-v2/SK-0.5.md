# SK-0.5 — merge-based booleans, post-fill `pruneLevelSet`, grid-native `properties()`

**Date**: 2026-07-26 · **Branch**: `webgpu-sk05` (off `webgpu` @ `85825da`) · **Audits**: A4
`picogk-runtime-performance-deficiency-audit`, A5 `openvdb-nanovdb-usage`

## Verdict

| # | Change | Verification | Result |
| --- | --- | --- | --- |
| U20 | booleans: whole-operand `deepCopyTypedGrid` → `Csg*Op` with a `DeepCopy` tag (lazy per-node copy) | heap high-water on a contained-operand union, 0.1 mm, separate sessions per arm | **2 → 1** full-grid materializations per boolean. High-water **442.5 → 368.8 MB**; the 73.7 MB it drops is the 77.9 MB operand |
| U21 | `pruneLevelSet` after the dense per-voxel fills (`RenderImplicit`, `RenderLattice`, `ProjectZSlice*`) | prunable-slack probe (`union(empty)` yields the pruned form of any field) | **−68.1%** tree on `RenderImplicit`, **−36.1%** on `ProjectZSlice`, **−5.5%** on `RenderLattice`; all fill paths now at **0% residual slack** |
| — | `properties()` → one native call in its own TU (`src/pico-props.cpp`), **plus** `area` from `tools::levelSetArea` | analytic oracles (4πr², capsule wall + caps) in tier-2 and the facade suite | volume and bounds **bit-identical** to the old four-call sequence; area within **0.11%** (sphere) and **0.23%** (capsule) of analytic |

**Byte parity: PASS.** 456/456 tests, 100% coverage on all four metrics, browser gate
17/17 on all engines with hex-float equality against node. All six byte-locked fixtures in
`test/fixtures/` are byte-identical to `webgpu` (checksums below). No pin was regenerated.

**One charter deviation** (§"properties() computes from grid, mesher not invoked"): the
mesher stays. Grid-native `levelSetVolume` is not a drop-in for `properties().volume` — it
is wrong by construction on post-boolean grids, and the number is pinned as a hex float64
in five fixture files. Evidence and the numbers are in §4; this is a report, not a silent
substitution.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 (26.5.2) / v26.5.0 |
| Load | 5.9–7.6 throughout — **a sibling spike (SK-0.3, Lattice ABI) shared the machine** |

Because of the shared load **no wall-clock claim is made in this document**. Every number
below is either an exact value (a byte count, a checksum, a hex float), a deterministic
allocation high-water mark, or a memory ratio measured on both arms of a code A/B. The
`memUsage`/heap figures are deterministic functions of the allocation sequence, not timings,
and reproduce exactly across runs.

---

## 1. Boolean grid materializations

### What the count actually was

The A4 reading was "3 grid materializations per boolean". Read end to end, the copy-first
facade makes **two**, and one of them is the result:

| step | who | grid materialized |
| --- | --- | --- |
| `Voxels_hCreateCopy(a)` | `derive()` in `src/voxels.ts` (SG11 purity) | **1** — becomes the result |
| `deepCopyTypedGrid(b)` | `Voxels::BoolAdd` etc. | **1** — thrown away at end of scope |
| `csgUnion(*result, *bCopy)` | openvdb | 0 — steals nodes out of the copy |
| `RebuildGrid()` | `Voxels::RebuildGrid` | 0 — **the body is `return;`**, disabled upstream |

So the waste was exactly one whole-grid copy of the operand, and it existed only because
`tools::csg{Union,Difference,Intersection}` consume their second argument while the facade
must leave the caller's operand intact.

### The fix

`tools/Merge.h` exposes the same operators the `csg*` wrappers use, and they accept a
`DeepCopy` tag on a **const** tree: `TreeToMerge` then copies only the nodes it actually
grafts and records consumption in a lightweight `MaskTree` — which is precisely what the
`Steal` path achieves by removing the node from the source. `Voxels::CsgMergeFrom<TOp>` is
`csgUnion`'s body (`validateLevelSet` ×2 → `DynamicNodeManager` top-down → `pruneLevelSet`)
with the steal replaced by the tag. Same operator, same traversal order, same prune, so the
values and the resulting topology are identical — which is why the fixture corpus does not
move.

### Measurement

Fixture: `outer` (sphere r=40) fully contains `inner` (sphere r=30) at 0.1 mm, so the union
grafts **nothing** from the operand (`result.memUsage == outer.memUsage`, asserted). Any
memory the union costs beyond the unavoidable result clone is therefore pure operand-copy
traffic. Metric is `HEAPU32.buffer.byteLength`, the emscripten heap high-water mark, which
never shrinks and is deterministic for a deterministic allocation sequence.

| arm | live grids before | high-water after union | growth during the boolean |
| --- | --- | --- | --- |
| baseline (`deepCopyTypedGrid`) | outer 136.5 MB + inner 77.9 MB | **442.5 MB** | **186.5 MB** |
| merge (`DeepCopy` tag) | same | **368.8 MB** | **112.8 MB** |
| difference | | −73.7 MB | −73.7 MB (operand is 77.9 MB) |

The residual 112.8 MB is the `Voxels_hCreateCopy` clone that the pure API owes the caller:
136.5 MB of grid, less the ~24 MB of arena slack inside the 256 MB initial heap. **That is
the semantic minimum for a copy-first boolean: one materialization, and it is the result.**

Regression guard: `test/voxels-booleans.test.ts` → *"a boolean materialises the result clone
and nothing else"*. It runs a `clone()` arm and a `union()` arm in separate sessions and
asserts the union's growth exceeds the clone's by less than half the operand's size. On the
baseline binary that difference is 73.7 MB against a 38.9 MB bar — the test discriminates.

---

## 2. Post-fill pruning

`csgUnion/Difference/Intersection` already end in `pruneLevelSet` (`prune=true` in
`Composite.h`), and `LevelSetFilter` prunes its own output — so the booleans, `offset`,
`RenderMesh` and the openvdb primitive constructors were never the problem. The fills that
walk a **dense accessor over a bounding box** were: they allocate a leaf for every 8³ block
they touch, including the blocks that end up uniformly `+background` or uniformly
`-background`.

Probe: `v.union(empty)` is a clone plus `csgUnion`, and `csgUnion` prunes A — so it yields
the pruned form of any field, and the memory it gives back is the prunable slack. Measured
at 0.4 mm on r=20 subjects:

| construction path | tree before | after prune | slack |
| --- | --- | --- | --- |
| `RenderImplicit` (JS callback, dense triple loop) | 13.12 MB | 4.18 MB | **−68.1%** |
| `RenderImplicit` compose-into-existing (callback) | 13.30 MB | 4.42 MB | **−66.8%** |
| `ProjectZSliceUp/Dn` | 8.03 MB | 5.13 MB | **−36.1%** |
| `RenderLattice` | 3.98 MB | 3.76 MB | **−5.5%** |
| `Voxels_RenderImplicitTape` (fresh, TP6) | 4.18 MB | 4.18 MB | 0.0% |
| `Voxels_RenderImplicitTapeCompose` | 4.42 MB | 4.42 MB | 0.0% |
| `createLevelSetSphere` | 4.96 MB | 4.96 MB | 0.0% |
| `RenderMesh` (`meshToLevelSet` + csgUnion) | 4.95 MB | 4.95 MB | 0.0% |
| boolean result | 5.49 MB | 5.49 MB | 0.0% |
| `offset` (`LevelSetFilter`) | 5.68 MB | 5.68 MB | 0.0% |

Two things fall out. First, **our own tape TU needed nothing** — TP6/TP7 block pruning plus
the level-1 interior tiles already produce the pruned tree, so `src/pico-tape.cpp` is
untouched by this spike. Second, the callback fill is 3.1× the tree of the tape fill for the
same geometry; after the change the two land on the **same 4.18 MB / 4.42 MB**, i.e. the two
engines now agree on representation as well as on values.

Value-neutrality was measured before it was assumed. For every row above, the pruned form
has bit-identical raw `levelSetVolume`, bit-identical mesh-round-trip `properties().volume`
and byte-identical STL output. That is expected — `pruneLevelSet` only replaces a leaf whose
every voxel already sits at ±background, with a tile carrying that same value, and
`volumeToMesh` emits nothing for such a block either way.

After the change all fill paths report **0.0% residual slack** (same probe, patched binary).

Regression guard: `test/voxels-booleans.test.ts` → *"per-voxel fills leave no prunable tree
behind"*, over the three affected paths.

---

## 3. `properties()` in its own TU

`src/pico-props.cpp` exports `Voxels_GetProperties(hLib, hThis, float* volume, float* area,
PKBBox3* bbox)`. It is the sequence the facade used to drive from TypeScript —
`Mesh_hCreateFromVoxels` → `Mesh_GetBoundingBox` → `Voxels_hCreate` → `Voxels_RenderMesh` →
`Voxels_fCalculateVolume`, plus two handle registrations and two destroys — moved in-module,
plus `tools::levelSetArea` over the grid that sequence already builds.

* **5 ABI crossings → 1**, and 2 handle-manager registrations → 0. At SK-0.2's measured
  33–56 ns/crossing this is ~200 ns against a multi-second meshing pass, so **no perf claim
  is made for it**. The reason to do it is that `area` needs the corrected grid, which only
  existed inside that sequence.
* **`area` is the grid-native part**: `levelSetArea` over the corrected level set, no second
  meshing pass, no extra allocation. Sphere r=10 @ 0.4 mm: **1255.23 mm² vs 1256.64 analytic
  (0.11%)**. Capsule r=5 l=20: **940.35 vs 942.48 (0.23%)**.
* Volume and bounds are the **same floats** as before, by construction — the TU calls the
  same methods in the same order on the same objects. Confirmed by the five fixture files
  that pin `properties().volume` as a hex float64 (§5).

ABI plumbing: `src/pico-exports.txt`, `BULK_FUNCTIONS` in `scripts/generate-raw.mjs`
(regenerated `src/raw.generated.ts`), the props TU added to `scripts/build-pico-module.sh`.
Tier-2 coverage is **148/148**, with `Voxels_GetProperties` exercised against analytic
oracles rather than a `> 0` check.

---

## 4. Why `properties()` volume/bounds cannot come from the grid

This is the spike's one NO-GO, and it is a correctness result, not a tolerance argument.

`properties()` exists to launder a dirty level set. openvdb's csg ops leave distance-0
voxels behind on coincident surfaces, and `LevelSetMeasure` integrates them as real surface,
so the raw grid measure of a geometrically **empty** field is large. The mesh round-trip
(`volumeToMesh` → `meshToLevelSet`) is the correction. Upstream's own `levelSetRebuild` is
mesh-based for exactly this reason — and in this tree it is dead code (`RebuildGrid()` opens
with `return;`), which is *why* the correction has to live in the facade.

Measured at 0.4 mm, `properties().volume` (mesh round-trip) against `voxels.volume` (openvdb
`levelSetVolume` over the live grid), and `bounds()` (mesh bbox) against
`evalActiveVoxelBoundingBox` (via `dimensions()`):

| subject | `properties().volume` | grid `levelSetVolume` | delta | `properties().area` | mesh bounds | active-voxel bounds |
| --- | --- | --- | --- | --- | --- | --- |
| sphere r10 (pristine) | 4185.22 | 4192.95 | +0.18% | 1255.23 | −9.99…9.99 | −10.80…11.20 |
| sphere − offset sphere | 2683.15 | 2687.58 | +0.17% | 1348.28 | −9.99…5.77 | −10.80…9.60 |
| **a − a (degenerate)** | **0.00** | **205.39** | **∞** | 0.00 | empty sentinel | −10.80…11.20 |
| union of two spheres | 7500.81 | 7510.65 | +0.13% | 2001.63 | −9.99…21.99 | −10.80…23.20 |
| intersection | 1807.24 | 1813.70 | +0.36% | 749.44 | −1.99…9.99 | −2.80…11.20 |
| offset(+2) | 7232.72 | 7243.12 | +0.14% | 1807.91 | −11.99…11.99 | −12.80…13.20 |
| lattice (6 beams) | 2476.41 | 2440.48 | **−1.45%** | 1990.66 | −16.96…16.96 | −18.00…18.40 |
| implicit sphere | 7233.38 | 7242.74 | +0.13% | 1808.02 | −11.99…11.99 | −13.20…13.60 |

Three blockers, in order of severity:

1. **`a − a` reports 205.39 mm³ for a field that has no interior at all.** `csgDifference`
   computes `max(d, −d) = |d|`, so no voxel is negative — `isEmpty` correctly says empty —
   yet the double-sided zero sheet measures as surface. `test/voxels-properties.test.ts`'s
   SG1 test pins the correction at **>100×** on exactly this case
   (`properties().volume < a.volume * 0.001` while `raw > a.volume * 0.01`). A grid-native
   volume fails that test outright.
2. **`properties().volume` is pinned bit-exact in five fixture files** —
   `helixheatx.json`, `roverwheel.json`, `quasicrystals.json`,
   `shapekernel-examples.json`, `latticelibrary-examples.json` (plus `simulation.json`,
   three subjects). A ±0.2% shift is a byte-lock break, which the standing rules make a
   STOP-and-report, not a pin regeneration.
3. **The active-voxel bbox is not the iso-surface bbox.** It is inflated by the narrow band
   — 0.8–1.2 mm at 0.4 mm voxels (2–3 voxels per face) — while
   `test/voxels-properties.test.ts` asserts bounds within **0.5 mm** of the analytic sphere
   extent. `evalActiveVoxelBoundingBox` cannot pass that, and it is already exposed anyway
   as `voxels.dimensions()`, so there was nothing to add.

There is a real win available in `bounds()` — it pays a whole `volumeToMesh` for a bounding
box, and a sign-crossing scan over active voxels would be far cheaper — but it changes a
public number (voxel-granular instead of sub-voxel-interpolated vertex extents) against a
0.5 mm bar. Left for a spike that owns the numeric change. Not taken here.

## 5. Checksums

Built from `patches/PicoGKRuntime/0001-merge-booleans-post-fill-prune.patch` applied by
`scripts/fetch-deps.sh` to a **clean re-extract** of the pinned tarball (`vendor/` is
gitignored, so the patch is how the change survives a fresh clone — same mechanism
`patches/oneTBB/` uses).

**Toolchain byte-reproducibility, checked both directions.** With the patch removed and the
props TU unwired, a full re-extract + rebuild in this worktree reproduces `webgpu`'s
committed multi artifacts **exactly** — `pico-multi.wasm`
`1b5930bab561b37d6641e664991504304d280526ce8a96591d50c512adbdd068`, `pico-multi.mjs`
`a22d816296dc0cd370eeeaa3e5f0d249638937f19608ae08f9fd613239c00684`, both matching
`git show HEAD:`. So the entire wasm delta in this commit is attributable to this spike and
nothing else. Re-applying the patch and rebuilding reproduces the hashes below on the nose.

The delta is +23,801 B on the multi binary. Most of it is not the boolean bodies: the
`DeepCopy` tag instantiates `TreeToMerge`'s mask machinery (`MaskTree`, `MaskUnionOp`,
`initializeMask`, `probeConstNode`) — a whole new tree type — for three operators. Both
variants moved by the same ~22.4 KB before the props TU was added, which is what confirms
the cost is template instantiation rather than anything shape-dependent.

| artifact | sha256 |
| --- | --- |
| `src/pico.wasm` (5,858,304 B, 41,347 SIMD) | `4b1d4d171c517d53bb3cd60df0b840fe623d73cf1434c177f9f34f457657f71f` |
| `src/pico-multi.wasm` (5,856,604 B, 39,084 SIMD) | `55734885eb2aa324e324c9cdb280223d6244f7f3188439088afa145b7a73c6c7` |
| `src/pico.mjs` | `85d06cca3d23dff2ae27f35516e51c1ce1a4c6cbc704047fc286da86a977e76b` |
| `src/pico-multi.mjs` | `738d52683bfa61a8c64eaa5f4400e9acf7a8e942be320ea44733fc3a3ad47fe8` |
| the patch | `25798642540fa4d75f1ffed67f4d5fd41491636e57fc45aa64d72606f87f2d0c` |

Byte-locked fixtures — **all six byte-identical to `webgpu`**:

| fixture | sha256 |
| --- | --- |
| `test/fixtures/helixheatx.json` | `56298c702d37ed991180117019e16edf584d2f01291b34e327053ec1d74c2eec` |
| `test/fixtures/latticelibrary-examples.json` | `9e360d57ee590b2d3bc0ea26620eaad182ec7e0e5477904586e9d09705af6c0a` |
| `test/fixtures/quasicrystals.json` | `b120759423e59d2319626719cf1222adf003a2f0a2213ec96a2978913ec9f1c0` |
| `test/fixtures/roverwheel.json` | `5a5ee9da71e7f6920e9cc6db0f85eae0e263a350a0af8cd054729d291f718749` |
| `test/fixtures/shapekernel-examples.json` | `52e2702d51b41b2b2dc18a67de1b15628ff536f78f929d25266d4ce94504218f` |
| `test/fixtures/simulation.json` | `08c9a479c2e225cbcc35699422865a93998956c4e2be8e0c1c76805d6fe926b6` |

## 6. Exit assertions

| assertion | result |
| --- | --- |
| boolean grid materializations at the semantic minimum | **1** (the result clone). Was 2. Measured, not inferred |
| `pruneLevelSet` applied post-fill; reduction measured | 3 paths; −68.1% / −36.1% / −5.5%; all fills now at 0% residual |
| `properties()` computes from grid, mesher not invoked | **PARTIAL — deviation reported (§4).** Area is grid-native (`levelSetArea`); volume and bounds must keep the mesh round-trip or they are wrong on post-boolean grids and break five byte-locked pins |
| suite green; byte-locked fixtures byte-identical | 456/456, 100% coverage ×4, browser gate 17/17 all engines, six fixtures byte-identical |
| committed on `webgpu-sk05`, not merged | yes |
