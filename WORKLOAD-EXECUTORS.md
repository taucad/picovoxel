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
| `Mesh_hCreateFromVoxels` (`volumeToMesh`) | MT nominal, **non-scaling** (50.2 ms ST vs 46.2 ms 12T) | serial adaptivity/stitch phases dominate at our grid sizes; gates `properties()`/`bounds()` triple-pass | candidate: W1.3 investigation → parallel extraction TU or GPU dual contouring (P8); OCCT meshing learnings feeding in |
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

## Determined non-improvable / measured-dead (do not re-run without new architecture)

- `-flto` (net negative), tail calls (hot path is switch-in-loop), `-ffast-math` (unbounded reassociation; excluded on all lanes), TP7c sincos-fusion, TP7d CPU affine-classify — `docs/research/picogk-cpu-fast-lane-workstream.md` measured-dead list.
- memory64 as a performance path (10%–2× engine tax; capacity escape hatch only).
- **GPU M1 per-op offload of small Class-B fills** — measured-dead at gyroid@0.1 (iteration-1). Caveat per blueprint AR2/AR3: the measurement carried a serial-ingest deviation; the corrected bound (~1.5–2.5×) still fails the 5× bar, but the number must never be quoted as 0.673× without that context, and it says nothing about deep tapes, chains, or lattice (gates G1/G3/G4).

## Rules

1. Every graduation lands with a before/after row in `bench/BENCHMARKS.md` (charter benchmarking discipline: medians + in-process forced-slow-lane ratios + engaged-assert).
2. A row moves to `measured-dead` only with a stage-attributed decomposition — "lost end-to-end" without attribution is inadmissible (blueprint AR9 rule).
3. New ABI entries default to batch-shaped (arrays in, arrays out, one crossing); chatty per-element entries need justification.
4. Update this ledger in the same change that moves an executor — it is the program's source of truth for "what runs where and why."
