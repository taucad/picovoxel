# SK-0.4 — parallel tube-complex lattice lane (`createLevelSetTubeComplex` as the RenderLattice default)

**Date**: 2026-07-26 · **Branch**: `webgpu` · **Tree under test**: `7ab89cc` + this spike (uncommitted)
**Machine**: Apple M2 Pro, 12 cores, 32 GiB, darwin 25.5.0, node v26.5.0, emsdk 5.0.1
**Conditions**: AC power (86–89%, charging) for every record in this file; start/end 1-min load
recorded per JSON (timing runs started at load ≤ 4.2). All artifacts below were produced by the
**final shipped binaries** — `pico.wasm` sha256 `acb27739…`, `pico-multi.wasm` sha256 `17ff421b…`
(each JSON's `fingerprint.wasmSha256` matches; an earlier evidence set taken against a stale
multi build was discarded and fully re-run). Dep prefixes were rebuilt from scratch per **H1**
(the incremental trap fired: with the cmake build dirs retained, `build-deps-wasm.sh` after the
patch-driven vendor re-extract compiled **zero** units and reinstalled the stale archives —
`build/{tbb,ovdb}-wasm*` must be deleted along with `build/wasm-prefix*`), and gitignored
`src/pico.wasm` refreshed per **H2**.

## 1. Verdict

**The lane ships as the default.** `openvdb::tools::createLevelSetTubeComplex`'s voxelizer —
driven deterministically (§5) — replaces the serial dense-accessor loop for every round-capped
beam and every sphere; flat-capped beams fall back to the serial lane inside the same export.

- **Exit bar (≥6× at 12T on the lattice stages)**: the two named wall stages together
  (turning-fins + helical-void @1.0 mm/12T) = 8380.4 → 1384.9 ms = **6.05×** [per-fixture
  3.24× / 19.11×]. At the 0.5 mm fine-cell scale the same aggregate is **13.2×** (5.55× /
  34.97×), straight-fins 6.03×, quasicrystal wireframe 14.26×. The bar is met — barely at
  1.0 mm, decisively where cells are fine (which is where the wall actually hurts).
- **Determinism**: bit-exact — 3/3 run-to-run stable AND single≡multi identical per fixture
  at 0.5 mm (volume hex, vertex/triangle counts, vertex+triangle byte FNVs). §5.
- **Equivalence**: SK-0.8 gate shape passes on every fixture once the level-set gate is read
  against the (non-clean) serial reference; the one real divergence is the nested-end-spheres
  case, where the serial lane is the wrong one (U23). §4.
- **Memory**: at 10⁵ beams the tube lane peaks **+61.6 MiB** over the serial lane
  (112.8 vs 51.2 MiB heap growth @0.25 mm), and its growth is **identical single vs multi**
  — the deterministic split tree makes allocation thread-count-independent too. §7.
- **Pins**: 4 byte-locked lattice pins drift, exactly as expected; the serial-lane flag
  reproduces all of them (42/42 tests). **Nothing regenerated in this commit** — pin
  regeneration is commit 2, after orchestrator review. §8.

## 2. What was built

| piece | file | note |
| --- | --- | --- |
| lattice TU | `src/pico-lattice.cpp` | `Voxels_RenderLatticeTubes(hLib, hThis, hLattice)` — same three handles as `Voxels_RenderLattice`, same union-into-existing-grid semantics; builds one tube complex (beams + spheres in the SAME complex), `csgUnion`s it into the target, then renders the flat-capped subset (if any) through `Voxels::RenderLattice` on a lattice re-authored to contain exactly that subset |
| vendored-tree patch | `patches/PicoGKRuntime/0002-lattice-parameter-accessors.patch` | seven inline const getters on `LatticeSphere`/`LatticeBeam` (`vecCenter`, `fRadius`, `vecStart`, `vecEnd`, `fRadStart`, `fRadEnd`, `bRoundCap`) — pure insertion, upstreamable verbatim; without them the only readable surface is `fSdValue()`, which forces the per-sample renderer shape being replaced |
| raw binding | `scripts/generate-raw.mjs` → `src/raw.generated.ts`, `src/pico-exports.txt` | 140 core + 12 own-TU exports (was 11) |
| facade default | `src/lattice.ts` (`toVoxels`), `src/voxels.ts` (`withLattice`) via `src/context.ts` `RENDER_LATTICE_EXPORT` | both call sites route through one constant |
| escape hatch | `PICOVOXEL_SERIAL_LATTICE=1` | routes the facade back to `Voxels_RenderLattice` wholesale (read once at module load; browsers always get the default). The raw subpath keeps both exports bound unconditionally — that is the A/B arm |
| A/B + evidence harness | `bench/lattice-tubes-ab.mjs` | `--equivalence` (SK-0.8 §4 gate shape verbatim + analytic column), `--timing` (paired, order-alternated, same lattice handle, bootstrap CI), `--determinism` (volume hex + mesh counts + vertex/triangle byte FNVs ×N), `--memory` (wasm heap high-water, one render per process; `--fixture beams-1e5` = 104,544-beam jungle gym) |
| suite | `test/tier2.test.mjs` (+2 tests) | ABI-level differential over a mixed-case lattice (capsule, taper, flat cap, sphere), and the U23 nested-radius disagreement pinned against the closed form in the direction that says which lane is right |

`SPLIT_TARGET = 16` was chosen by sweep (16/32/64 at 12T/0.5 mm: tube-lane median sums
2156/2165/2253 ms; 16 wins the beam-count-heavy stages, concedes ~15% on helical-void).

## 3. Beam-case mapping table (complete)

Fixture names refer to §4's equivalence records; openvdb dispatch cites
`LevelSetTubesImpl.h` (vendored 13.0.0 line).

| lattice element | PicoGK serial form | tube-complex expression | dispatch | fixture(s) | verdict |
| --- | --- | --- | --- | --- | --- |
| round cap, r0 = r1 | `fSdvRoundCone` (degenerates to capsule) | capsule | `\|r0−r1\| < 0.001·voxel` → `CapsuleVoxelizer` (:1195) | `case:capsule`, `case:axis-aligned Z capsule`, `case:overlapping crossed capsules` | same SDF definition; sub-µm field deltas (§4) |
| round cap, r0 ≠ r1 | `fSdvRoundCone` (iq sdRoundCone) | tapered capsule | `TaperedCapsuleVoxelizer` | `case:tapered`, `case:tapered thin`, fins fixtures | same shape — both are the convex hull of the end spheres; **bit-exact fields** on `case:tapered` |
| round cap, near-equal radii | round cone | capsule (openvdb snaps radii) | :1195 threshold | `case:near-equal radii r 2→2.0004` | max SDF delta 4.0e-4 mm = the radius snap; bounded by `0.001·voxel` by construction |
| round cap, nested end spheres ((p0−p1)² ≤ (r0−r1)²) | `fSdvRoundCone` — **wrong**: `a2 = l²−(r0−r1)²` goes negative, `sqrtf` of a negative product | the larger ball (that IS the convex hull) | :1191 ball branch | `case:nested end spheres r 6→1` | **the lanes disagree and the tube lane is right**: closed-form volume 904.78; serial 84.21 (−90.7%), tubes 901.46 (−0.37%). Serial reference is also the one with 160 `checkLevelSet` violations; tubes is clean. Pinned in `tier2` as **U23** |
| zero-length round beam | never reaches the renderer | — | `Lattice::AddBeam` converts to a sphere (`PicoGKLattice.h:213-218`) | `case:zero-length round beam` | bit-exact (it is a sphere by the time either lane sees it) |
| sphere | `fSdValue` sphere | zero-length segment, equal radii → ball branch | :1191 | `case:sphere`, `case:mixed caps + sphere` | bit-exact fields; spheres ride in the same complex — no second pass |
| **flat cap** (`bRoundCap == false`) | `fSdvFlatCone` (conical frustum, planar ends) | **none** — the complex is built solely from sphere-capped convex hulls; no open/flat variant exists in the API | n/a | `case:flat cone`, `case:flat cone tapered`, `heatx:io-threads` | serial fallback inside the export, as a re-authored lattice of exactly those beams (`AddBeam(..., false)` so the zero-length→sphere rule cannot fire). Bit-exact vs old lane; timing 1.00× [0.997, 1.003] — the fallback costs nothing |
| empty lattice | no-op | skipped (`oSegments.empty()`) | — | `case:empty lattice` | both empty |
| non-integer narrow band (mm-band `Voxels` ctor, `PicoGKVdbVoxels.h:393`) | n/a | complex band must match the target grid bit-for-bit; if `round(background/voxel)·voxel ≠ background` the whole lattice takes the serial lane | guard in `Voxels_RenderLatticeTubes` | — | reachable only via the non-default ctor; conservative fallback |

Fixture beam counts: turning-fins 355,600 · straight-fins 106,656 · helical-void 65,000 ·
io-threads 23,200 (all flat-capped) · quasicrystal gen-1 5,824. Of the HeatX lattices only
the ScrewHole pair and the ThreadCutter helix are flat-capped — the two wall stages are
round-capped throughout.

## 4. Equivalence — SK-0.8 §4 gate shape, serial lane as reference

`sk-0.4-equivalence.json`, 0.5 mm, single glue. Gates: vol/area rel ≤3%, bounds ≤1 voxel
(0.5 mm), SDF max ≤1 voxel / mean ≤0.25 voxel over the band intersection, `checkLevelSet`,
mesh valid. `bandMismatch` reported, not gated.

| fixture | volΔ | areaΔ | boundsΔ mm | sdf max mm | sdf mean mm | bitExact | bandMiss | mesh | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| case:capsule r=2 L=20 | 1.1e-7 | 0 | 0 | 2.4e-7 | 6.1e-8 | 0.687 | 0 | ✓ | pass |
| case:tapered r 3→1 | 0 | 0 | 0 | **0** | **0** | **1.000** | 0 | ✓ | pass (bit-exact) |
| case:tapered thin r 2→0.1 | 0 | 0 | 0 | 2.2e-8 | 5.3e-12 | 1.000 | 0 | ✓ | pass |
| case:near-equal radii | 5.1e-3 | 2.4e-3 | 0.06 | 4.0e-4 | 2.0e-4 | 0.063 | 24 | ✓ | pass (radius snap, §3) |
| case:nested end spheres | 9.70 | 0.92 | 2.90 | 0 | 0 | 1.000 | 756 | ✓ | **divergent — tubes correct** (§3, U23) |
| case:sphere r=3 | 0 | 0 | 0 | 0 | 0 | 1.000 | 0 | ✓ | pass (bit-exact) |
| case:zero-length round beam | 0 | 0 | 0 | 0 | 0 | 1.000 | 0 | ✓ | pass (bit-exact) |
| case:flat cone (fallback) | 0 | 0 | 0 | 0 | 0 | 1.000 | 0 | ✓ | pass (bit-exact) |
| case:flat cone tapered (fallback) | 0 | 0 | 0 | 0 | 0 | 1.000 | 0 | ✓ | pass (bit-exact) |
| case:axis-aligned Z capsule | 0 | 0 | 0 | 2.4e-7 | 3.9e-8 | 0.713 | 0 | ✓ | pass |
| case:overlapping crossed capsules | 0 | 0 | 0 | 2.4e-7 | 6.1e-8 | 0.686 | 0 | ✓ | pass |
| case:mixed caps + sphere | 0 | 0 | 0 | 2.4e-7 | 1.7e-8 | 0.911 | 0 | ✓ | pass |
| heatx:turning-fins.hot | 0 | 0 | 0 | 6.0e-7 | 4.2e-8 | 0.415 | 0 | ✓ | pass |
| heatx:straight-fins.hot | 0 | 0 | 0 | 7.2e-7 | 5.3e-8 | 0.415 | 0 | ✓ | pass |
| heatx:helical-void.hot | 0 | 7.7e-8 | 0 | 9.8e-6 | 1.3e-7 | 0.501 | 3 | ✓ | pass (4.88M band voxels compared) |
| heatx:io-threads (flat caps) | 0 | 0 | 0 | 0 | 0 | 1.000 | 0 | ✓ | pass (bit-exact — full fallback) |
| quasicrystal:wireframe gen-1 | 0 | 0 | 0 | 1.7e-6 | 1.1e-7 | 0.400 | 8 | ✓ | pass |

Analytic column, where a closed form exists: candidate rel error equals the reference's to
4+ digits on capsule/sphere/zero-length (0.0185 / 0.0165 / 0.0251 / 0.0790) — "differs from
reference" never means "less accurate"; on nested-end-spheres the candidate is the accurate
one (0.0037 vs 0.9069).

**The `checkLevelSet` EMPTY gate, read correctly for lattices**: unlike SK-0.8's offset
fixtures, the serial lattice reference is NOT clean — the per-element min-splat leaves
\|∇φ\| violations wherever elements overlap (turning-fins reference: 458,402 voxels).
On every fixture the candidate's diagnosis is **byte-identical to the reference's** (same
counts), except nested-end-spheres where the candidate is EMPTY and the reference has 160
violations. The lane never makes the field worse than the lane it replaces, and once makes
it strictly better. The gate as applied here: *diagnosis must not exceed the reference's* —
passes everywhere.

## 5. Determinism — by construction, then measured

Construction: upstream's `createLevelSetTubeComplex` drives `TubeComplexVoxelizer` under
`tbb::parallel_reduce` with the auto partitioner — the split tree (hence csg join topology)
depends on worker availability. This TU drives the same voxelizer under
`tbb::parallel_deterministic_reduce` with grain = `ceil(buckets/SPLIT_TARGET)` — the split
tree is a pure function of the input. Same discipline as the 0001 disjoint-slot mesh flatten.

Measured (`sk-0.4-determinism-{single,multi}.json`, 0.5 mm, 3 runs each, oracle = raw
level-set volume as hex double + extracted mesh vertex/triangle counts + FNV-1a over the
vertex and triangle byte arrays):

| fixture | 3× single | 3× multi (11 workers) | single ≡ multi |
| --- | --- | --- | --- |
| heatx:turning-fins.hot | stable | stable | **identical** |
| heatx:straight-fins.hot | stable | stable | **identical** |
| heatx:helical-void.hot | stable | stable | **identical** |
| heatx:io-threads (flat caps) | stable | stable | **identical** |
| quasicrystal:wireframe gen-1 | stable | stable | **identical** |

0.5 mm is strictly finer than the 0.7 mm L0 fine-cell gate scale
(`SK-0-P0-finecell.md` — the scale that killed U-SK05-a). The full-app 0.7 mm HeatX
differential is §8's story: same volume hex as the serial pin, +8 triangles.

## 6. Timing — paired, order-alternated, bootstrap CI (12 repeats, 1 warmup)

`sk-0.4-timing-{multi,single}-1.0mm.json`, `sk-0.4-timing-multi-0.5mm.json`. Both arms render
the SAME lattice handle; ratios are median serial/tubes with 95% bootstrap CI on the median
log ratio.

**12T (multi, 11 workers), 1.0 mm** — the SK-0.1 wall scale:

| fixture | serial ms | tubes ms | ratio | 95% CI |
| --- | --- | --- | --- | --- |
| heatx:turning-fins.hot (355.6k beams) | 3684.8 | 1139.3 | **3.24×** | [3.18, 3.29] |
| heatx:straight-fins.hot (106.7k) | 1201.0 | 356.1 | **3.38×** | [3.34, 3.41] |
| heatx:helical-void.hot (65k) | 4695.6 | 245.6 | **19.11×** | [18.88, 19.23] |
| heatx:io-threads (flat caps, 23.2k) | 296.8 | 298.0 | 1.00× | [0.995, 0.997] |
| quasicrystal:wireframe gen-1 (5.8k) | 254.2 | 35.6 | **7.14×** | [6.53, 7.24] |

**12T, 0.5 mm**: turning-fins **5.55×** [5.49, 5.57], straight-fins **6.03×** [5.98, 6.10],
helical-void **34.97×** [34.39, 35.86], flat caps 1.00×, quasicrystal **14.26×** [13.89, 14.57].

**Single-thread, 1.0 mm** (the algorithmic delta alone): turning-fins 2.57×, straight-fins
2.73×, helical-void 4.23×, flat caps 0.99×, quasicrystal 2.70× — the scanline voxelizer beats
the dense bbox walk even before threads.

Reading: the ratio tracks voxel-work per beam. helical-void (few, fat beams) is
compute-dominated and scales to 19–35×. The fins stages are beam-COUNT dominated: at 1.0 mm
each of turning-fins' 355.6k beams touches only a handful of voxels, so the serial
per-complex setup (vertex/segment ingest, bucket build in the voxelizer constructor) and the
final csg combine bound the lane at ~3.2× (Amdahl fit from the ST/MT pair: ~75% of the ST
tube-lane wall is in the non-parallel sections at 1.0 mm); at 0.5 mm the parallel share grows
and the same stage reaches 5.5×. The contract's two named wall stages sum to **6.05× at
1.0 mm/12T** and **13.2× at 0.5 mm**.

## 7. Memory — per-thread trees at 10⁵ beams

`sk-0.4-memory-beams-1e5-0.25mm-*.json` (+ the 0.5 mm and helical-void variants). Fixture:
104,544-beam jungle gym (33³ nodes, 3 mm pitch, r=0.5 round-capped), authored through the
bulk wire format; wasm linear-memory high-water across ONE first render, one process per
record (wasm memory only grows, so growth = that render's peak demand beyond the 256 MB
initial heap).

| lane | glue | heap growth | render ms |
| --- | --- | --- | --- |
| serial | single | 51.2 MiB | 6814 |
| serial | multi | 51.2 MiB | 6727 |
| tubes | single | 112.8 MiB | 1917 |
| tubes | multi | **112.8 MiB** | **707** |

The tube lane's price at 10⁵ beams is **+61.6 MiB** peak (the complex's own grid + per-leaf
trees + combine staging) for 9.5× the speed at 12T — and the growth is **bit-identical
single vs multi**, because the deterministic split tree fixes the number of intermediate
trees regardless of worker count. All four records produce the same volume hex
(`000000e06bb10841`). At 0.5 mm the same fixture fits inside the initial heap on both lanes
(growth 0) — the 256 MB floor masks anything smaller; treat sub-floor growth as "≤ initial
heap", not zero cost.

## 8. Pins — exact failing list (regenerated: NOTHING)

Full suite on the new default: **462/466 pass**; the 4 failures are precisely the
byte-locked lattice pins, and all 4 pass under `PICOVOXEL_SERIAL_LATTICE=1` (42/42 tests in
those files). UPDATE_PINS regeneration is **commit 2**, after orchestrator review.

| # | pin | drift |
| --- | --- | --- |
| 1 | `test/examples-helixheatx.test.ts` › "HelixHeatX @ 0.7 mm: multi build reproduces the pinned fine-cell geometry" | volume hex **identical** (`000000a0e5ff2141`); triangles 4,542,744 vs pinned 4,542,736 (+8 — band-edge mesh difference, not geometry loss; contrast the P0 failure mode: *fewer* triangles, per-run variance) |
| 2 | `test/examples-quasicrystals.test.ts` › "QuasiCrystal wireframes @ 2.0 mm: gens 0-2 pinned and scaling; face/tile tasks pinned" | triangle counts identical; volume hex low-mantissa drift (e.g. `…003f7f1841` vs `…203f7f1841`) |
| 3 | `test/examples-roverwheel.test.ts` › "wheel-02 preset builds headless and matches its byte-locked pins" | byte-locked STL/volume pins |
| 4 | `test/examples-shapekernel.test.ts` › "ex-lattice-pipe runs headless and matches its byte-locked pins" | byte-locked pins |

The 1.0 mm HeatX stage pins pass **unchanged** on the new default. Note the 0.7 mm
fine-cell differential itself (single≡multi within the new lane) holds — the drift is
old-lane-vs-new-lane, not thread-vs-thread.

## 9. Artifact index (commit 1)

- `sk-0.4-equivalence.json` — §4 (single glue, 0.5 mm)
- `sk-0.4-determinism-{single,multi}.json` — §5 (0.5 mm, 3 runs)
- `sk-0.4-timing-{multi,single}-1.0mm.json`, `sk-0.4-timing-multi-0.5mm.json` — §6 (12 repeats)
- `sk-0.4-memory-{helical-void,beams-1e5}-{serial,tubes}-{single,multi}.json`,
  `sk-0.4-memory-beams-1e5-0.25mm-{serial,tubes}-{single,multi}.json` — §7
- harness: `bench/lattice-tubes-ab.mjs`
- ledgers: `WORKLOAD-EXECUTORS.md` (`Voxels_RenderLattice` row), `MIGRATING-FROM-CSHARP.md`
  (U5 spiked, U23 new, facade-surface row)

## 10. Pin regeneration protocol (commit 2 — orchestrator approved)

Commit 1 landed the lane with the 4 pins deliberately red on the default (§8); this
regeneration is the operator-approved one-time L0 pin move, executed via each test's own
`UPDATE_PINS=1` mechanism on the new default lane (plus the one hardcoded fine-cell
constant, which has no fixture file). Nothing else in any fixture file moved — the diffs
are exactly the lattice-bearing entries.

**Changed-pin identity, before → after:**

| pin | volume (hex LE) before → after | volume mm³ | rel Δ | triangles before → after |
| --- | --- | --- | --- | --- |
| helixheatx fine-cell @0.7 mm (multi, hardcoded) | `000000a0e5ff2141` → **unchanged** | 589,810.8125 | 0 | 4,542,736 → 4,542,744 (+8) |
| quasicrystals gen-1 wireframe | `000000c087a8e340` → `000000e0a4a8e340` | 40,260.24 → 40,261.15 | 2.3e-5 | 64,920 (unchanged) |
| quasicrystals crystalFromFace | `000000203f7f1841` → `000000003f7f1841` | 401,359.78 → 401,359.75 | 7.8e-8 | 678,696 (unchanged) |
| quasicrystals crystalFromTile | `000000a0ebb5f740` → `00000080ebb5f740` | 97,118.727 → 97,118.719 | 8.0e-8 | 155,736 (unchanged) |
| roverwheel wheel-02 | `000000003b5b3f41` → `000000c03b5b3f41` | 2,054,971.00 → 2,054,971.75 | 3.7e-7 | 3,310,844 (unchanged) |
| shapekernel ex-lattice-pipe [1] | `000000406ff2d540` → `000000c06ef2d540` | 22,473.738 → 22,473.730 | 3.5e-7 | 57,004 → 57,012 (+8) |
| shapekernel ex-lattice-pipe [2] | `0000006080b1e040` → `000000e080b1e040` | 34,188.012 → 34,188.027 | 4.6e-7 | 83,376 → 83,360 (−16) |
| shapekernel ex-lattice-pipe [3] | `000000605639c040` → `000000005639c040` | 8,306.6748 → 8,306.6719 | 3.5e-7 | 37,832 → 37,800 (−32) |

(gen-0 and gen-2 quasicrystal entries, all other shapekernel entries, and every non-lattice
pin in every fixture: byte-identical.)

**Same-runtime C#-parity argument**: these pins certify *this runtime's* default lattice
path, and a C# PicoGK front-end bound to this runtime takes the same
`Voxels_RenderLatticeTubes` code path — the pins move because the runtime's default moved,
for every consumer at once, not because the wasm port diverged from C# semantics. The old
values remain reproducible bit-for-bit under `PICOVOXEL_SERIAL_LATTICE=1` (re-verified: the
4 files pass 42/42 on the flag against the OLD pins — §8), so the serial lane's contract is
intact, merely no longer the default one. The largest volume move is 2.3e-5 relative; every
one is orders of magnitude inside §4's gates.

**U23 caveat on the old values**: the serial numbers being retired were themselves
defective on the nested-end-spheres beam class — `fSdvRoundCone` takes `sqrtf` of a
negative product there and renders −90.7% of the closed-form volume where the tube lane is
−0.37% and `checkLevelSet`-clean (§3). The regeneration moves the pins *toward* the more
correct lane.

**Fine-cell identity gate on the new default**: the 0.7 mm multi gate was run 3× against
the new fixed pin — 3/3 green (a nondeterministic lane cannot hit a fixed pin thrice);
volume hex is unchanged from the serial-lane era, only the mesh gained 8 triangles.

**Last ceremony of its kind** (NON-DETERMINISM.md §12, item 5): future same-geometry lane
changes gate on the G0 identity oracles (canonical grid hash / hex volume / mesh multiset),
not on pin bytes — this regeneration is intended to be the final byte-pin move for a
same-geometry default swap.

**H1b** (hardening, discovered executing this spike; appended to
`SK-0-P0-finecell.md` §Hardening): deleting `build/wasm-prefix*` alone is NOT a clean dep
rebuild — the retained cmake build dirs (`build/{tbb,ovdb}-wasm*`) reinstall the stale
archives with zero compiles, because tar's restored mtimes make make see no work. Delete
the build dirs with the prefixes.

### What "full suite green" additionally surfaced (fixed in the same commit)

**Coverage gate had been masked by the red pins.** With the 4 pin failures gone, the
100%-threshold coverage gate ran to completion for the first time in a while and failed on
two counts: (a) this spike's `RENDER_LATTICE_EXPORT` env ternary (`src/context.ts`) had an
untaken branch — restructured as `resolveRenderLatticeExport(env?)` with a direct test in
`test/coverage-gaps.test.ts`; (b) **pre-existing, SK-0.8's**: `doubleOffset`/`fillet`
`fastRenorm` arms (`src/voxels.ts:282,295`) were never exercised — SK-0.8 landed while pin
failures short-circuited the coverage report. Closed by adding both to the existing
fastRenorm gate matrix in `test/voxels-offsets.test.ts` (they now run through the same
volume/area/bounds/level-set gates, 467th test).

**Pre-existing multi-glue teardown race, now fixed at the root.** 3 of 4 full-suite runs
exited 1 with all tests passing: a vitest fork crashed AFTER reporting its results. macOS
crash reports (4×, incl. one from a commit-1-era bench run — the race predates this
regeneration) show the identical signature: **SIGILL on an `em-pthread` worker while the
main thread frees the wasm BackingStore** (`munmap` under `BackingStore` destruction).
Nothing ever joined the pthread pool: workers outlive every JS reference to their module,
and at process teardown V8 frees the shared memory while a worker can still be executing
in it. Fix: `session.dispose()` now calls `module.PThread?.terminateAllThreads()` (multi
glue only; each session owns its module, so its pool dies with it). Suite green twice
consecutively + three-engine browser gate after the fix.
