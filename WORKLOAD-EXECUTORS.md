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
| `Voxels_RenderImplicit` (JS/native callback) | ST — structurally serial (one callback per voxel across the boundary) | boundary-crossing pins the loop; parallelism impossible with a foreign callback in the loop | **graduated** → tape (below); callback path kept for API compat only |
| `Voxels_RenderImplicitTape(Compose)` | MT — TBB parallel eval, thread-local grids, node-steal merge (TP6/TP7) | tape eval is embarrassingly parallel per voxel; merge is node-parallel | graduated 2026-07 (2.4×/8.6× vs callback). GPU M1 single-op offload **measured-dead** (iteration-1 spike: 0.673×, ingest-dominated — see blueprint AR1–AR3). GPU deep-tape kernel + M2-resident: **candidate**, gates G1/G3 |
| `Voxels_IntersectImplicit(Tape)` | MT via tape (mirrors upstream swap dance) | as above | carries upstream narrow-band int-truncation bug (<⅓ mm); fix queued in upstreamables ledger |
| `Voxels_RenderLattice` | **ST** — single dense accessor loop over per-beam bboxes | nothing about it suits ST: analytic SDF min-splat is embarrassingly parallel; this is the top serial wall (HeatX creation stages ≈30 s of 35.5 s @1.0 mm/12T) | **candidate ×2**: W1.2 T4 parallel TU (~thread-count) and GPU G4/N6 (bar ≥10× vs serial) |
| `Voxels_RenderMesh` (`meshToLevelSet`) | MT — per-triangle voxelize → thread-local trees → merge | triangle-parallel by construction | candidate: GPU P7 (3–10× honest bar — baseline already MT) |
| Sphere / capsule / dilated-mesh constructors | MT (`createLevelSet*`) | primitive rasterization, TBB inside OpenVDB | current |

## Voxels — modify / combine

| Op | Executor today | Why | Graduation status |
| --- | --- | --- | --- |
| `Voxels_BoolAdd/Subtract/Intersect` | MT — `tools::csg*` node-steal via `DynamicNodeManager` | node-parallel merge | deficiency: **deep-copies operand first** (pure memory traffic) — W1.2 T6 `.consume()`; GPU value-merge P6 candidate at assembly scale |
| `Voxels_Offset` / `DoubleOffset` / `TripleOffset` | MT — `LevelSetFilter` leaf-parallel, CFL-iterated | leaf sweeps are band-parallel | candidate: GPU P5 resident stencil chains (anchor: NanoVDB CUDA LevelSet 5×, Fog 44× vs native MT CPU) |
| `Voxels_ProjectZSlice` | **ST** — per-column z-scan | columns are independent — ST is unjustified | candidate: W1.2 T5 parallel TU; carries end-cap seal bug (upstreamables ledger) |
| `Voxels_bIsEqual` | **ST** — dense bbox compare | trivially parallel + early-exit reduce | candidate: W1.2 T11 |

## Voxels — interrogate

| Op | Executor today | Why | Graduation status |
| --- | --- | --- | --- |
| `Mesh_hCreateFromVoxels` (`volumeToMesh`) | MT (disjoint-slot flatten, SK-0.6) | the "serial adaptivity/stitch" attribution was wrong — the wall was four serial copy passes AROUND the parallel mesher (`doVolumeToMesh`'s per-element primitive copy + roAsMesh's three re-copies); repaired via pool-indexed count→scan→emit into pre-sized slots (`patches/PicoGKRuntime/0001`), byte-identical output, layout = the WGSL port's input shape | current (SK-0.6 measured: ST 43.3→38.4 ms, 12T 32.9→24.0 ms, scaling 1.31→1.60× on dlmalloc — residual is tree lifecycle (identify/auxdata/clear ≈19 of 24 ms), an allocator/S-A wall, not extraction; mimalloc probe on the patched tree: 12T ≈10 ms, ≈3.9× scaling, byte-identical — see `bench/results/webgpu-v2/SK-0.6.md`) |
| `Voxels_fCalculateVolume` | MT — Gauss-divergence reduce | reduce-shaped | current |
| `Voxels_bClosestPointOnSurface` | ST per query — Bresenham shell scan O(r³)/call | algorithmically wrong before executor-wrong | candidate: gradient-walk algorithm fix + batched ABI (W1.2 T11 / P8) |
| `Voxels_bRayCastToSurface` | ST per ABI call | HDDA exists in NanoVDB; no batch entry | candidate: batched query ABI (P8, 10–50×) |
| `Voxels_GetX/Y/ZSlice`, `GetInterpolatedZSlice` | ST dense accessor reads | readback-bound; per-call ABI — now ~35 ns/crossing (SK-0.2), so the batch case rests on amortizing the accessor re-seek and the copy, not on the boundary | candidate: batched `GetZSliceRange` (W1.2 T9) |
| `Voxels_GetVoxelDimensions` etc. (metadata) | ST trivial | O(1) | non-improvable |

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
