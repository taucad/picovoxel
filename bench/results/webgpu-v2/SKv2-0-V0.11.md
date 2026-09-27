# SKv2-0 V0.11 — P8 query repairs: batched raycast + closest-point swap

**Verdict: LANDED.** `src/pico-query.cpp` adds two batched ABIs, surfaced as
`voxels.raycastBatch({origins, directions})` and
`voxels.closestPointsOnSurface({points})`:

- **`Voxels_RayCastBatch`** — N rays over ONE cached
  `LevelSetRayIntersector` (upstream constructs it per call) and one ABI
  crossing. Per-ray semantics are upstream's EXACTLY, including the
  integer-voxel truncation of the fractional hit (`vecToMM(Coord(...))`) —
  fixing that truncation is a value change deliberately left to its own
  move. Serial single-ray facade unchanged (the oracle).
- **`Voxels_ClosestPointBatch`** — the algorithm swap: openvdb
  `ClosestSurfacePoint` (index built once per batch, sub-voxel answers)
  replacing the O(r³)-per-query Bresenham shell scan for batch consumers.
  C2 by nature; the SDF/analytic fixture is its own oracle.

## Exit assertions

1. **batch ≡ serial exact per ray** — 52-ray matrix (26 inward, 26
   outward): hit/miss agrees with the serial oracle on every ray, hit
   coordinates bit-equal per axis (`test/query-batch.test.ts`).
2. **hit/miss 100% off-grazing** — every inward ray hits, every outward
   misses (52/52).
3. **closest-point in-band + within 1 voxel of the true min** — analytic
   sphere: result radius within one voxel of the surface, realized distance
   within one voxel of |‖q‖ − r|, 6/6 queries incl. an interior and a
   near-center query.
4. **per-query speedups recorded** (0.2 mm sphere r=10, N=2000):
   raycast **10.2 → 1.4 µs/ray (7.3×)**, 2000/2000 hit agreement;
   closest-point **~2.5 ms → 10.4 µs/query (241×** vs the Bresenham scan,
   serial extrapolated from 200 queries**)**.

Ground rule 8 discharged (+2 exports: BULK 21→23, bound 161→163, tier-2
C21, surface-manifest +2 wrapper keys, API surface). Suite + browser gate:
see commit.

## Ledger deltas

WORKLOAD `Voxels_bRayCastToSurface` + `Voxels_bClosestPointOnSurface` rows →
graduated (batch entries); serial closest-point facade unchanged (its swap
rides the batch; single-query routing left as-is deliberately — the batch
is where P8's amortization exists).
