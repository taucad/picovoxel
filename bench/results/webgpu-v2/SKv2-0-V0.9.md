# SKv2-0 V0.9 — ProjectZSlice repair (T5×F15) + the U2 seal fix

**Verdict: LANDED.** `projectZSlice` rides `Voxels_ProjectZSliceFast`
(`src/pico-zslice.cpp`): upstream's per-column value logic verbatim
(min-propagation, average end-cap seal, `SetSdValue` clamp/off semantics,
terminal prune) with two changes — **F15 column culling** (only columns
whose touched z-slab intersects stored content are visited; untouched
columns differed from upstream only by background-valued writes the
terminal prune removed) and **the U2 correction**: the seal depth is the
narrow band in VOXELS (`background()/voxelSize` = 3), where upstream's
`(int)(0.5f + background())` read the millimetre quantity as a layer count
— correct at 1.0 mm by coincidence, 2 of 3 layers at 0.5–0.7 mm, **zero
below ~0.167 mm (open caps)**. The dense mutating export stays raw-side as
the differential oracle.

## Exit assertions

1. **Per-column min oracle + per-scale seal counts**: `test/zslice.test.ts`
   — the projected column seals the full band at {1.5, 1.0, 0.5,
   0.167} mm (the buggy formula's count is `round(3·voxelSize)`; 0 at
   0.167). Tier-2 **C19**: value-identity with upstream at 1.0 mm, and the
   0.4 mm divergence asserted as the documented U2 correction.
2. **Single≡multi at fine cells**: 0.5 mm cross-entry `gridHash` record
   equality (serial/dlmalloc vs multi/mimalloc).
3. **Pin regeneration, SK-0.4 protocol, cause named**: the suite isolated
   exactly the predicted movement — `g0-reference.json` **heatx@1mm
   byte-UNCHANGED** (the coincidence claim held at production scale);
   **heatx@0.7mm moved in gridHash ONLY** (`056d67cb…` → `cb75cf9f…`) with
   activeVoxels/insideTiles/insideOffVoxels/volumeHex/triangles/vertices/
   multiset all identical — the corrected third seal layer writes
   narrow-band *values* without changing classification or the mesh at
   this fixture. The value-sensitive canonical grid hash is the only
   oracle that can see it: the G0 construction doing precisely its §14.5
   job. Cause: **U2 seal fix (this move)**. No byte-locked example fixture
   moved (HeatX examples pin 1.0/0.7 mm volume+triangles, both invariant
   here).
4. **Stage speedup recorded**: 1.25× on a two-tower sparse fixture at
   0.2 mm (6.0 vs 7.5 ms); the culling win scales with
   bbox-area/content-columns and is modest on compact shapes — the
   correctness half is the reason this move exists; the wall was never the
   headline (HeatX kernel `project-z-slice` ≈ 5 ms).

Suite: 55 files, 496/496, coverage 100%; browser gate 3×17/17 (commit).
Ground rule 8 discharged (+1 export: BULK 18→19, bound 158→159, C19, API
surface).

## Ledger deltas (this commit)

MIGRATING U2 row → fixed here with per-scale oracles, pin move documented;
WORKLOAD ProjectZSlice row → graduated; NON-DETERMINISM untouched (U2 was
already §12/§14.3's worked example of deterministic wrongness — the fix
lands exactly as prescribed there).
