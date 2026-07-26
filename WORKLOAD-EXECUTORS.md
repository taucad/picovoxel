# Workload executors

Ledger of every PicoGK runtime compute entry point and its **current workload executor** — single-thread CPU (`ST`), multi-thread CPU (`MT`, oneTBB), or GPU — plus its graduation status through the max-performance program. Companion to `MIGRATING-FROM-CSHARP.md`; evidence lives in `docs/research/picogk-gpu-acceleration.md` (Finding 1 op map), `docs/research/picogk-cpu-fast-lane-workstream.md` (W1 register), `docs/research/picogk-webgpu-iteration-2-blueprint.md` (gates G1–G4, moves N0–N7), and `bench/BENCHMARKS.md`.

**Status legend**: `current` — executor is where it started; `graduated` — moved executor with measured evidence; `candidate` — graduation planned, gate named; `measured-dead` — a graduation was tried, measured, and rejected (do not re-run without new architecture); `non-improvable` — algorithmically at its ceiling on this executor.

> **Baselines re-based 2026-07-26 (SK-0.1) and remain dlmalloc-denominated.** Every later
> spike (SK-1…SK-3) must compare against `bench/results/webgpu-v2/sk-0.1-baseline-dlmalloc.json`
> (20 samples/phase, bootstrap CI), not the 2026-07-23 file. `-sMALLOC=mimalloc` was measured
> and **rejected as the default**: it wins 1.208× on HeatX multi `construct` but loses STL
> byte reproducibility at 0.5 mm (three runs, three byte streams, identical geometry) — see
> `bench/results/webgpu-v2/SK-0.1.md`. It stays available as `MALLOC=` in
> `scripts/build-pico-module.sh`.
>
> **Re-test on the patched tree (SK-0.1 addendum, 2026-07-26 later) is BLOCKED, and found a
> P0 instead.** The default **dlmalloc multi** build now produces silently wrong,
> nondeterministic geometry at every voxel size finer than 1.0 mm — volume hex and triangle
> count differ per run (0.7 mm: 3,158,084 tris vs the 4,542,736 reference; the committed
> `src/pico-multi.wasm` gives a third value again). Exactly 1.0 mm is clean and byte-stable,
> which is why the 453/453 suite is green: the only HeatX fixture pins 1.0 mm. Volume differs,
> so the defect is in **voxel construction, not extraction**. Every MT row below is therefore
> suspect on fine cells until this is fixed, and no MT measurement taken after `d8ccfb5`
> should be trusted at <1.0 mm. mimalloc is not implicated (it shares and amplifies the bug).
> Details, suspect range and the recommended fine-cell suite gate: `SK-0.1.md` addendum.
>
> **MT substrate changed 2026-07-26 (SK-0.7); no row changes executor.** Three vendored
> oneTBB fixes (`patches/oneTBB/`) apply under every `MT` row: `machine_pause` is an
> in-register spin instead of a JS-boundary `sched_yield` (65.8 → 2.1 ns), the external
> thread's stealing threshold is derived from its real stack so it keeps its share in
> deep/nested regions (0.71× → 0.98× of fair share at 72 KB depth), and worker stacks are
> 1 MB instead of 64 KB — which is the precondition for U5 / W1.2 T4's deeper parallel
> `RenderLattice` recursion. `createPico` on the multi build also got ~96 ms faster
> (readiness poll replacing a fixed sleep), which shifts *session* wall, not stage wall.
> Evidence: `bench/results/webgpu-v2/SK-0.7.md`. Stage baselines were not re-taken — a
> sibling spike shared the machine — so SK-0.1's numbers still stand as the comparator.
>
> **Fill pruning landed, merge-based CSG REVERTED 2026-07-26 (SK-0.5 → SK-0 P0); no row
> changes executor.** What survives from SK-0.5: the three dense-accessor fills
> (`RenderImplicit`, `RenderLattice`, `ProjectZSlice*`) now end in `pruneLevelSet` like every
> csg path already did, shedding 68.1% / 5.5% / 36.1% of tree (`U21`,
> `patches/PicoGKRuntime/0001-post-fill-prune.patch`), and `properties()` moved into its own
> TU and gained `area` from `tools::levelSetArea`.
>
> **What was reverted: `U20`, merge-based CSG.** Replacing the eager whole-operand deep copy
> with the `Csg*Op` merge operators under a `DeepCopy` tag made the 12-thread build drop
> geometry **nondeterministically at every voxel size below 1.0 mm** — and every byte-locked
> pin in this repo sits at ≥1.0 mm, so the suite was green for the entire life of the defect.
> Toggle matrix: necessary and sufficient (3/3 divergent with it, 3/3 bit-exact without;
> `U21` alone bit-exact). Booleans are back to the eager operand copy. The fine-cell identity
> gate in `test/examples-helixheatx.test.ts` (0.7 mm, pinned) now closes that blind spot and
> stays. Evidence: `bench/results/webgpu-v2/SK-0-P0-finecell.md`.
>
> **Therefore: every MT number in this ledger measured at <1.0 mm on `ff68494..03eb200` is
> suspect** — dropped geometry makes a stage look faster. Re-derive before citing.
>
> **Read the deviation before trusting the audit here**: A4/A5 read `properties()`'s
> re-voxelization as laziness that grid-native `levelSetVolume` would fix. It would not — the
> mesh round-trip is what removes the distance-0 voxels csg leaves on coincident surfaces,
> and without it `a − a` measures 205.39 mm³ for a field with no interior. Volume and bounds
> therefore stay mesh-derived (also: five fixture files pin `properties().volume` as a hex
> float64). Evidence: `bench/results/webgpu-v2/SK-0.5.md`.
>
> The A/B is still informative for this ledger: the allocator moved **MT paths only** and
> left every ST row flat, so no row below changes executor. Two ST rows are now confirmed
> by allocator-insensitivity — the `RenderLattice` stages (`turning-fins`, `helical-void`)
> sat at 0.99–1.00× across a 12-thread allocator swap, which is what a genuinely serial
> stage looks like. U5 / W1.2 T4 keep their priority.

> **Per-call ABI cost re-based 2026-07-26 (SK-0.2).** Every "per-call ABI" note below was
> written against emscripten's `ccall` path: `cwrap` demotes any binding with a `bigint`
> argument, and 143 of 147 exports take a handle. The generated layer now binds direct wasm
> exports, so the crossing itself costs **56.4 ns** for a 7-argument call (`Lattice_AddBeam`,
> was 176.6) and **33.1 ns** for a 2-argument boolean query (`Voxels_bIsEmpty`, was 109.1) —
> see `bench/results/webgpu-v2/SK-0.2.md`. **No row changes executor**: the crossing was never
> the reason a chatty entry point is slow. It does move the arithmetic on the batch-ABI
> candidates (T9/T11/P8) — a batched entry now has to beat ~35 ns per skipped crossing rather
> than ~100, so those rows are justified by the *work* they amortize (O(r³) shell scans, dense
> accessor re-seeks), not by the boundary. Rule 3 stands unchanged for the same reason.
>
> **Lattice authoring batched 2026-07-26 (SK-0.3); one row graduates.** `Lattice_AddBeam` was
> the last chatty hot entry point — 1,197,460 crossings across 37 lattices on HeatX. The facade
> now stages beams/spheres into a flat `Float32Array` and crosses **once per lattice**
> (`Lattice_AddBeams`/`Lattice_AddSpheres` in `src/pico-bulk.cpp`; counter-verified 37 for 37).
> Per beam **50.1 → 39.2 ns** end to end through the public facade, i.e. the whole authoring
> call is now cheaper than the bare ABI crossing it replaced; the HeatX `author` stage goes
> **238.7 → 150.8 ms** (paired ABAB ×5, disjoint ranges; a load-flagged full-suite pass puts
> `M12@single/author` at 153.4 ms against SK-0.1's 406.7, every single-thread row flat).
> **The flat buffer is the GPU-upload
> seam**: 8 f32 per beam = (x, y, z, radius) per endpoint, two vec4 lanes, 32 B stride, no
> padding under std140/std430, so `beams.subarray(0, n * 8)` goes to `writeBuffer` unrepacked —
> which is what S-A/S-C and SK-0.4's slab-binned tube-complex lane consume. What it does *not*
> fix is upstream storage: `Lattice` still holds `std::vector<std::shared_ptr<LatticeBeam>>`,
> one `make_shared` per beam, so 20.9 of the amortised 39.2 ns is C++-side ingest. Filed as
> **U18**. Evidence: `bench/results/webgpu-v2/SK-0.3.md`.
>
> Two corrections fell out of the same measurement. **HeatX makes 1,197,460 `Lattice_AddBeam`
> calls across 37 lattices**, not the "~10⁵" R11 has carried — an order of magnitude, counted
> directly. R11's conclusion survives (authoring is still ~0.9% of wall), but any future
> per-call claim about this subject must use the real number. And the `author` phase moved
> **−26%** on a quiet re-run (431.6 → 298.1 ms single) from the binding change alone, which is
> 1.2M × the measured 123 ns facade delta to within 10–27%.

## Voxels — construction

| Op (C ABI) | Executor today | Why it suits / doesn't | Graduation status |
| --- | --- | --- | --- |
| `Voxels_RenderImplicit` (JS/native callback) | ST — structurally serial (one callback per voxel across the boundary) | boundary-crossing pins the loop; parallelism impossible with a foreign callback in the loop | **graduated** → tape (below); callback path kept for API compat only. Since SK-0.5 (U21) it prunes on exit: **−68.1% tree**, which also makes it agree with the tape path on representation, not just on values |
| `Voxels_RenderImplicitTape(Compose)` | MT — TBB parallel eval, thread-local grids, node-steal merge (TP6/TP7) | tape eval is embarrassingly parallel per voxel; merge is node-parallel | graduated 2026-07 (2.4×/8.6× vs callback). GPU M1 single-op offload **measured-dead** (iteration-1 spike: 0.673×, ingest-dominated — see blueprint AR1–AR3). GPU deep-tape kernel + M2-resident: **candidate**, gates G1/G3 |
| `Voxels_IntersectImplicit(Tape)` | MT via tape (mirrors upstream swap dance) | as above | carries upstream narrow-band int-truncation bug (<⅓ mm); fix queued in upstreamables ledger |
| `Voxels_RenderLattice` | **ST** — single dense accessor loop over per-beam bboxes, pruned on exit (SK-0.5) | nothing about it suits ST: analytic SDF min-splat is embarrassingly parallel; this is the top serial wall (HeatX creation stages ≈30 s of 35.5 s @1.0 mm/12T) | **candidate ×2**: W1.2 T4 parallel TU (~thread-count) and GPU G4/N6 (bar ≥10× vs serial). SK-0.5's prune took 5.5% of tree off the output; it does not touch the serial wall |
| `Voxels_RenderMesh` (`meshToLevelSet`) | MT — per-triangle voxelize → thread-local trees → merge | triangle-parallel by construction | candidate: GPU P7 (3–10× honest bar — baseline already MT) |
| Sphere / capsule / dilated-mesh constructors | MT (`createLevelSet*`) | primitive rasterization, TBB inside OpenVDB | current |

## Voxels — modify / combine

| Op | Executor today | Why | Graduation status |
| --- | --- | --- | --- |
| `Voxels_BoolAdd/Subtract/Intersect` | MT — `tools::csg*` node-steal via `DynamicNodeManager`, operand **deep-copied whole** first | node-parallel merge | **deficiency stands: 2 full-grid materializations per boolean where 1 (the result) is the semantic minimum** — W1.2 T6 `.consume()`; GPU value-merge P6 candidate at assembly scale. **New constraint (SK-0 P0)**: the obvious fix — the `Merge.h` operators under a `DeepCopy` tag — was tried, landed, and **reverted** for nondeterministic fine-cell MT geometry loss (`U20`, `bench/results/webgpu-v2/SK-0-P0-finecell.md`). Any re-attempt must first settle whether the race is upstream in `TreeToMerge` or in our driving of it, and must clear the 0.7 mm identity gate |
| `Voxels_Offset` / `DoubleOffset` / `TripleOffset` (+ `Voxels_OffsetTuned`, own TU `src/pico-offset.cpp`) | MT — `LevelSetFilter` leaf-parallel, CFL-iterated. **Now characterised (SK-0.8)**: one `offset(d)` = `⌈\|d\|/(0.5·voxelSize)⌉` CFL steps, each = dilate + `normCount` Eikonal sweeps + prune. Renormalization is **93.9–97.5% of the wall**; the residual (dilate+`offsetImpl`+prune) is 11–23 ms of a 180–584 ms op | leaf sweeps are band-parallel; the wall is one `parallel_for` over `Normalizer::euler01`, and its cost is exactly linear in a settable integer (slope stable within 2% over `normCount` 0–3) | **executor unchanged; the settings are now reachable (SK-0.8)** — `setSpatialScheme`/`setNormCount` exposed behind an opt-in `fastRenorm`, default byte-identical. Certified `FIRST_BIAS` at upstream's 3 sweeps: **3.49–3.95×** on 4 fixtures, level set still clean. Ceiling on a scheme swap is **4.2×** (the measured HJWENO5:FIRST per-sweep cost ratio), so tuning is now *spent*. Still a GPU P5 candidate — and a better-posed one: the bar is now per-sweep (**17.0 / 13.2 / 29.3 / 43.2 ms**) rather than per-op (anchor: NanoVDB CUDA LevelSet 5×, Fog 44× vs native MT CPU). Gate shape for the L1 lane: `bench/results/webgpu-v2/SK-0.8.md` §4 |
| `Voxels_ProjectZSlice` | **ST** — per-column z-scan, now pruned on exit (SK-0.5) | columns are independent — ST is unjustified | candidate: W1.2 T5 parallel TU; carries end-cap seal bug (U2). Ships **36.1% less tree** since SK-0.5 (U21) — the executor did not move, the output representation did |
| `Voxels_bIsEqual` | **ST** — dense bbox compare | trivially parallel + early-exit reduce | candidate: W1.2 T11 |

## Voxels — interrogate

| Op | Executor today | Why | Graduation status |
| --- | --- | --- | --- |
| `Mesh_hCreateFromVoxels` (`volumeToMesh`) | MT (disjoint-slot flatten, SK-0.6) | the "serial adaptivity/stitch" attribution was wrong — the wall was four serial copy passes AROUND the parallel mesher (`doVolumeToMesh`'s per-element primitive copy + roAsMesh's three re-copies); repaired via pool-indexed count→scan→emit into pre-sized slots (`patches/PicoGKRuntime/0001`), byte-identical output, layout = the WGSL port's input shape | current (SK-0.6 measured: ST 43.3→38.4 ms, 12T 32.9→24.0 ms, scaling 1.31→1.60× on dlmalloc — residual is tree lifecycle (identify/auxdata/clear ≈19 of 24 ms), an allocator/S-A wall, not extraction; mimalloc probe on the patched tree: 12T ≈10 ms, ≈3.9× scaling, byte-identical — see `bench/results/webgpu-v2/SK-0.6.md`) |
| `Voxels_fCalculateVolume` | MT — Gauss-divergence reduce (`levelSetVolume`) | reduce-shaped | current. **Not** a substitute for `properties().volume`: on a post-boolean grid the distance-0 voxels csg leaves on coincident surfaces measure as real surface — `a − a` reports 205.39 mm³ for a field with no interior. SK-0.5 §4 has the corpus-wide delta table and the five byte-locked pins that fix this |
| `Voxels_bClosestPointOnSurface` | ST per query — Bresenham shell scan O(r³)/call | algorithmically wrong before executor-wrong | candidate: gradient-walk algorithm fix + batched ABI (W1.2 T11 / P8) |
| `Voxels_bRayCastToSurface` | ST per ABI call | HDDA exists in NanoVDB; no batch entry | candidate: batched query ABI (P8, 10–50×) |
| `Voxels_GetX/Y/ZSlice`, `GetInterpolatedZSlice` | ST dense accessor reads | readback-bound; per-call ABI — now ~35 ns/crossing (SK-0.2), so the batch case rests on amortizing the accessor re-seek and the copy, not on the boundary | candidate: batched `GetZSliceRange` (W1.2 T9) |
| `Voxels_GetVoxelDimensions` etc. (metadata) | ST trivial | O(1) | non-improvable |
| `Voxels_GetProperties` (own TU, `src/pico-props.cpp`) | MT — inherits `volumeToMesh` + `meshToLevelSet` + `levelSetVolume`/`levelSetArea` | the mesh round-trip is load-bearing, not laziness: it is what launders the distance-0 voxels out of a post-boolean grid (SK-0.5 §4). Area is the grid-native part | **new 2026-07-26 (SK-0.5)** — collapses the old 5-crossing / 2-temp-handle TS sequence into one call and adds `properties().area` from `tools::levelSetArea` over the grid the sequence already builds (0.11% of analytic on a sphere). Volume and bounds bit-identical. Inherits `Mesh_hCreateFromVoxels`'s non-scaling shape, so it graduates when W1.3 / P8 does |

## Fields / metadata / IO

| Op | Executor today | Why | Graduation status |
| --- | --- | --- | --- |
| `ScalarField`/`VectorField` builders + `TraverseActive` | ST dense loops; callback ABI has no user-data pointer | bulk facilities missing at ABI | candidate: batch ABIs (P8); active-count export queued upstream |
| VDB file save/load | ST | IO-bound | non-improvable (until profiling says otherwise) |
| picovoxel bulk paths (R11: mesh vertices/triangles, STL bytes) | boundary bulk (one crossing) | already the bulk pattern | graduated 2026-07 (R11) |
| Lattice authoring — `Lattice_AddBeam`/`AddSphere` | boundary bulk (**one crossing per lattice**, SK-0.3) + ST C++ ingest | staging is a flat f32 append in JS; the crossing amortizes to a `memcpy`. Ingest stays ST because upstream allocates a `shared_ptr` per beam | **graduated 2026-07-26 (SK-0.3)** — 1,197,460 → 37 crossings on HeatX, facade 50.1 → 39.2 ns/beam, `author` 238.7 → 150.8 ms. Remaining ceiling is upstream storage (**U18**); the flat buffer is the GPU-upload seam for S-A/S-C |

## Determined non-improvable / measured-dead (do not re-run without new architecture)

- `-flto` (net negative), tail calls (hot path is switch-in-loop), `-ffast-math` (unbounded reassociation; excluded on all lanes), TP7c sincos-fusion, TP7d CPU affine-classify — `docs/research/picogk-cpu-fast-lane-workstream.md` measured-dead list.
- memory64 as a performance path (10%–2× engine tax; capacity escape hatch only).
- **GPU M1 per-op offload of small Class-B fills** — measured-dead at gyroid@0.1 (iteration-1). Caveat per blueprint AR2/AR3: the measurement carried a serial-ingest deviation; the corrected bound (~1.5–2.5×) still fails the 5× bar, but the number must never be quoted as 0.673× without that context, and it says nothing about deep tapes, chains, or lattice (gates G1/G3/G4).

## Rules

1. Every graduation lands with a before/after row in `bench/BENCHMARKS.md` (charter benchmarking discipline: medians + in-process forced-slow-lane ratios + engaged-assert).
2. A row moves to `measured-dead` only with a stage-attributed decomposition — "lost end-to-end" without attribution is inadmissible (blueprint AR9 rule).
3. New ABI entries default to batch-shaped (arrays in, arrays out, one crossing); chatty per-element entries need justification.
4. Update this ledger in the same change that moves an executor — it is the program's source of truth for "what runs where and why."
