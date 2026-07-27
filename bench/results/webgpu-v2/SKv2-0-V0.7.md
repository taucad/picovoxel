# SKv2-0 V0.7 ★ — `csgUnionCopy` booleans + the §11.3 native U20 reproducer

**Two verdicts.** (1) The boolean family now rides openvdb's shared-nothing
`csg*Copy` operators — value-identical to the mutating path everywhere the
oracles can see, one materialization per pair, measurably faster. (2) The
§11.3 native stock-TBB reproducer **REPRODUCED the U20 defect class on
native hardware**: the merge(DeepCopy) path drops geometry
nondeterministically under concurrency with completely stock components —
an **upstream openvdb defect**, substrate exonerated, novel report.

**Tree**: picovoxel `webgpu` on top of `8d01136`. Machine: Apple M2 Pro
12-core / 32 GiB, AC, `lowpowermode 0`.

## 1. The boolean successor (shared-nothing csg*Copy)

- New sibling TU `src/pico-boolean.cpp`: `Voxels_hBoolAddCopy` /
  `Voxels_hBoolSubtractCopy` / `Voxels_hBoolIntersectCopy` — const inputs,
  `csgUnionCopy`/`csgDifferenceCopy`/`csgIntersectionCopy`
  (thread-per-leaf `doCSGCopy`), result adopted via the
  `Voxels(FloatGrid::Ptr, int)` constructor. Upstream's post-boolean
  `RebuildGrid()` is a disabled no-op, so nothing else to replicate.
- Facade `union`/`subtract`/`intersect`/`trim` rewired (`composeCopy`:
  pairwise chains, eager intermediate destroy, zero-operand purity, LUB
  provenance). The mutating exports remain on the raw subpath.
- Ground rule 8 discharged: exports file, `BULK_FUNCTIONS` 14→17 +
  regenerated bindings, build TU, BOTH artifacts rebuilt (single/dlmalloc
  5,977,490 B; multi/mimalloc 6,042,140 B), `generate-raw.test.ts` counts
  154→157, tier-2 **C18** block (value-identity vs the mutating path per op
  + const-input proof), API-surface spec updated.

### Exit assertions

1. **Materializations = 1, counter-verified**: `allocated.voxels` net +1 per
   boolean pair (facade test); the old shape allocated a receiver copy AND
   an internal whole-operand deep copy per pair.
2. **EXACT gate**: tier-2 C18 — G0 grid-hash identity `csg*Copy` ≡
   copy+mutate for union/subtract/intersect, inputs bit-untouched. At
   production scale: the full suite (489/489, coverage 100%) ran the
   boolean-heavy byte-locked corpus and the **G0 per-commit pins (HeatX
   multi 1.0/0.7 mm) held unchanged** — the strongest available statement
   that the swap moved no geometry byte. Browser gate 3×17/17.
3. **`a−a` degenerate pinned**: `isEmpty` true (SG2), non-zero narrow-band
   raw volume unchanged.
4. **Wall/high-water**: warm single-pair union at 0.15 mm: 6.5 → 4.7 ms
   (~1.4×). High-water probe (fresh session, one union of two big spheres @
   0.08 mm, wasm heap growth as the monotone high-water proxy):
   serial/dlmalloc lane **0 growth on both paths**; multi/mimalloc lane 0
   (old) vs **+187 MiB (new)** — the shared-nothing copy spreads output
   allocation across 12 worker arenas on mimalloc. Recorded as a
   **transient/arena cost rider for V0.15/M1** (the fast lane's 0.24 GiB
   ceiling headroom at 0.4 mm is the concern it feeds); same-value output,
   zero cost on the oracle lane, and long chains reuse warmed arenas — the
   corpus-level number lands with the V0.21 scorecard.

## 2. §11.3 — the native stock-TBB U20 reproducer

Harness: `bench/u20-native-repro.cpp` (build line + verdict in its header).
Substrate: native arm64, **stock homebrew oneTBB 12.18** (none of our
`patches/oneTBB/`), openvdb **13.0.0** built by the PicoGKRuntime vendor
tree (`build-r2/lib/libopenvdb.a`). The harness drives upstream's own
documented Merge.h pattern — `CsgUnionOp(tree, DeepCopy())` through
`DynamicNodeManager::foreachTopDown` + `pruneLevelSet`, structurally
verbatim the reverted U-SK05-a `CsgMergeFrom` — against a 40-union
fine-cell chain, and the shipped steal-on-copy `csgUnion` as the control
arm.

| arm | threads | runs | result |
| --- | --- | --- | --- |
| merge(DeepCopy) | 12 (default) | 5 | **4 distinct checksums, 4 distinct active counts** (13,120,165 / 13,158,217 / 13,170,138 / 2× 13,189,311) — nondeterministic geometry loss |
| csgUnion(steal-on-copy) | 12 (default) | 5 | bit-stable 5/5 @ 13,189,311 (= the merge arm's best case) |
| merge(DeepCopy) | 1 (`global_control`) | 3 | bit-stable 3/3 @ 13,189,311 — correct |

**Verdict: upstream.** The wasm toggle-matrix isolation (U-SK05-a necessary
+ sufficient) now composes with a native reproduction on fully stock
components: the third suspect — wasm/emscripten/patched-TBB substrate
interaction — is **eliminated**. `Merge.h` is unchanged 122 commits past
our pin, so this is a novel upstream report; the harness is the repro
artifact. Filing remains operator-gated (charter operator decision 1).

## Ledger deltas (this commit)

U20 row updated (repro verdict + harness pointer); NON-DETERMINISM §12.10
outcome + §11.3 closed; WORKLOAD-EXECUTORS boolean row → csg*Copy executor.
