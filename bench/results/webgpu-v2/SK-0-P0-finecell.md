# SK-0 P0 — fine-cell MT geometry loss: isolated to U-SK05-a (merge-based CSG)

**Date**: 2026-07-26 · **Branch**: `webgpu` · **Tree under test**: `ff68494` (SK-0.2…SK-0.7 landed)
**Found by**: the SK-0.1 mimalloc re-verdict attempt (see `SK-0.1.md` addendum, which this supersedes as the P0 record)

## Verdict

**Culprit: `patches/PicoGKRuntime/0001-merge-booleans-post-fill-prune.patch`, sub-change
U-SK05-a (merge-based CSG) — necessary and sufficient.**

The multi-thread build silently drops geometry, nondeterministically, at every voxel size
below 1.0 mm. Volume hex and triangle count differ **per run**; triangles are always *fewer*
than reference, never more. Exactly 1.0 mm is correct and byte-stable, which is why the suite
was green throughout.

U-SK05-b (post-fill `pruneLevelSet`) is **innocent** — measured, not assumed. Its memory win
can be kept.

No fix is attempted here. The fix belongs to SK-0.5's follow-up with the orchestrator
arbitrating.

> **RESOLVED — U-SK05-a reverted.** Arbitration kept U-SK05-b and the `properties()` TU and
> reverted the merge-based CSG. The combined patch was split: the boolean half is gone and the
> file is now `patches/PicoGKRuntime/0001-post-fill-prune.patch` (references to the old
> `0001-merge-booleans-post-fill-prune.patch` filename in this document and in `SK-0.1.md` are
> left as written — they name the artifact as it existed when it was measured). Both dep
> prefixes were rebuilt from scratch per **H1**, `src/pico.wasm` refreshed per **H2**, and the
> gate's `skipIf` is deleted: it now passes. Post-revert oracle, 0.7 mm HeatX multi, one run
> per process, all four identity fields against the `sk-0.1-heatx-sweep-dlmalloc.json`
> reference:
>
> | run | volumeHex (LE) | stlFnv | stlBytes | triangles | Δ vs reference |
> | --- | --- | --- | ---: | ---: | ---: |
> | 1 | `000000a0e5ff2141` | `aa392ded` | 227,136,884 | 4,542,736 | **0** |
> | 2 | `000000a0e5ff2141` | `aa392ded` | 227,136,884 | 4,542,736 | **0** |
> | 3 | `000000a0e5ff2141` | `aa392ded` | 227,136,884 | 4,542,736 | **0** |
>
> Three runs, one value — and it is the reference value, not merely a stable one. (The bench
> JSON records the same double big-endian as `4121ffe5a0000000`.) The mechanism question below — upstream `TreeToMerge` race vs. our driving of it —
> is **still open** and is recorded as the precondition for any re-attempt (`U20`,
> `MIGRATING-FROM-CSHARP.md`). Step 4 of "Recommended next steps" (re-baseline sub-1.0 mm MT
> numbers) and step 5 (mimalloc) are now unblocked.

## Machine state

Apple M2 Pro, 12 cores, 32 GiB · darwin 25.5.0 · node v26.5.0 · AC power, `lowpowermode 0`.
Determinism run, not a timing run: 1-min loadavg spanned **3.70–7.31** across toggle runs and
was deliberately not gated. Load is irrelevant to the verdict — the clean configurations
returned bit-exact matches *under the same load range* that produced divergence in the dirty
ones, which is itself evidence the effect is not load-induced noise.

## Toggle matrix — the causal isolation

Patch-level toggles in an isolated worktree at `ff68494` (shared emsdk/`downloads`/`dist`
symlinked from the main checkout; main checkout never modified). Detector: HeatX **multi**
@0.7 mm, 3 runs per configuration, against the reference in
`sk-0.1-heatx-sweep-dlmalloc.json` (volume hex `4121ffe5a0000000`, 4,542,736 triangles — the
cell where single ≡ multi still held).

| configuration | U-SK05-a | U-SK05-b | runs vs reference | verdict |
| --- | :---: | :---: | --- | --- |
| all patches (baseline) | ✓ | ✓ | 3/3 divergent, all differing | **DEFECT** |
| merge-booleans patch removed | ✗ | ✗ | **3/3 bit-exact** | clean |
| only U-SK05-a | ✓ | ✗ | 3/3 divergent, all differing | **DEFECT** |
| only U-SK05-b | ✗ | ✓ | **3/3 bit-exact** | clean |

U-SK05-a alone reproduces it; U-SK05-b alone does not. Necessary and sufficient.

### Per-run hashes

| run | volume hex | triangles | Δ vs reference |
| --- | --- | ---: | ---: |
| `no-merge-booleans` ×3 | `4121ffe5a0000000` | 4,542,736 | **0** |
| `only-U-SK05b-postfillprune` ×3 | `4121ffe5a0000000` | 4,542,736 | **0** |
| `all-patches-restored` run1 | `41236c8ee0000000` | 4,049,552 | −493,184 |
| `all-patches-restored` run2 | `41221725e0000000` | 4,503,740 | −38,996 |
| `all-patches-restored` run3 | `41256ead60000000` | 3,632,560 | −910,176 |
| `only-U-SK05a-mergeCSG` run1 | `4121ca8be0000000` | 4,267,984 | −274,752 |
| `only-U-SK05a-mergeCSG` run2 | `41220e7a00000000` | 4,347,936 | −194,800 |
| `only-U-SK05a-mergeCSG` run3 | `4121fe46c0000000` | 4,524,940 | −17,796 |

Raw records: `sk-0-p0-toggle-matrix.jsonl` (12 runs).

```
5c68daf7e5bb7290ccecd49fc65a1b0535b9dd1c4740bd6a2bef7d37e8afdee6  sk-0-p0-toggle-matrix.jsonl
```

Eight further runs from the discovery pass (main checkout, dlmalloc and mimalloc, 0.5–1.0 mm,
including the committed `src/pico-multi.wasm`) are in `sk-0.1-addendum-oracle.jsonl`.

## Mechanism

U-SK05-a replaces the eager whole-grid deep copy in `BoolAdd`/`BoolSubtract`/`BoolIntersect`
with openvdb's merge operators under a `DeepCopy` tag (`tools/Merge.h`, `TreeToMerge`), which
copy only the nodes actually grafted and track consumption in a lightweight mask tree. The
patch's own rationale argues this is value-neutral because it is "the same operator, the same
top-down `DynamicNodeManager` traversal and the same terminating `pruneLevelSet`".

The measurements say the equivalence does not hold under 12-thread execution:

- **Volume differs, so the defect is in the voxel grid, not extraction.** `volume` is computed
  from the grid and is upstream of `roAsMesh`; that alone exonerates SK-0.6.
- **Always fewer triangles, never more** — consistent with whole nodes going missing from the
  result rather than values being perturbed.
- **Nondeterministic across runs at fixed thread count** — a scheduling-order dependence, i.e.
  the consumption-tracking mask tree being read or mutated without sufficient synchronization
  while the `DynamicNodeManager` traversal runs concurrently. The eager deep copy it replaced
  gave each boolean a private operand, which is why the old path could not exhibit this.
- **Scale-dependent onset**: clean at 1.0 mm, broken at 0.8 mm and finer. At 1.0 mm the HeatX
  operands are small enough that the merge has few graftable interior nodes and little
  concurrency to race over; the defect needs enough nodes to contend.

This is a diagnosis from black-box behaviour, not from reading the openvdb merge internals.
Whether the race is in openvdb's `TreeToMerge` under `DeepCopy` (an upstream bug, relevant to
U-row candidacy) or in how the patch drives it (ours) is **not** established here and is the
first question the fix should answer.

## What this exonerates

- **mimalloc** — shares the bug and amplifies it (worst run −18% of triangles vs dlmalloc's
  −4.9% at 0.5 mm), consistent with a memory/scheduling-sensitive race. The SK-0.1 mimalloc
  re-verdict stays **blocked** until this is fixed and the oracle re-run.
- **SK-0.6** (`ecdf907`, parallel disjoint-slot extraction) — downstream of `volume`, and its
  patch stayed applied in the clean configurations.
- **SK-0.3** (`41d5b1e`, bulk beam buffer) and **SK-0.7** (`85825da`, oneTBB substrate) —
  both stayed applied in the two bit-exact configurations, so neither is implicated. The
  oneTBB and SK-0.3 toggles planned as steps (b)/(c) were therefore not needed; step (c)'s
  per-beam fallback check was not run for the same reason.
- **U-SK05-b** (post-fill prune) — measured clean on its own.

## The gate

(Gate now LIVE — the `SK0_P0_GATE=1` opt-in described below was removed with the fix.)

`test(sk-0): fine-cell single==multi identity gate` — commit `9c21263`, one 0.7 mm assertion
in `test/examples-helixheatx.test.ts` pinned to the reference geometry. The repo has no
expected-failure convention, so it is skipped by default (CI stays green while the defect is
open) but gated on `SK0_P0_GATE=1` rather than a bare `.skip`, so it can be executed on
demand. **The fix commit deletes the `skipIf`.** Verified failing on `ff68494` at 4,189,660
triangles / volume hex `000000002e472241`.

The gate outlives the fix: the 1.0 mm differential that already existed is structurally unable
to see this class of defect.

## Hardening items (recorded, not fixed in this pass)

**H1 — stamp-driven re-extract leaves archive mtimes older than build outputs.**
`fetch-deps.sh` correctly re-extracts and re-patches when its hash stamp changes, but `tar`
restores the archive's own mtimes, so freshly patched sources can be *older* than the
`libopenvdb.a` built from the previous tree. cmake/make then no-op. Observed live this pass:
sources at 17:17 against a 17:19-stamped prefix built at 14:57, with the incremental dep
rebuild completing in ~10 s and doing nothing. Both prefixes had to be deleted to force a
genuine rebuild. Any spike that toggles a patch and rebuilds incrementally can silently
measure the *previous* patch set. Suggested fix: `touch` extracted trees at the end of
`extract()`, or make the dep-build step depend on the stamp file rather than source mtimes.

**H2 — `src/pico.wasm`/`pico.mjs` are gitignored while `src/pico-multi.*` are tracked.**
The working tree's single-build artifact was stale enough to predate SK-0.5's
`_Voxels_GetProperties` export, so every single-build test failed locally with a binding
error until rebuilt — while the tracked multi artifact stayed current. The asymmetry means a
fresh checkout and a long-lived one disagree about which tests can even run.

**H1b — deleting `build/wasm-prefix*` alone is not a clean dep rebuild (SK-0.4, observed
live).** H1's trap has a second stage: with the prefixes deleted but the cmake build dirs
(`build/{tbb,ovdb}-wasm*`) retained, `build-deps-wasm.sh` compiled **zero** units and
`cmake --install` simply reinstalled the previous stale archives into fresh prefixes —
tar's restored mtimes make make see no work, so the "rebuild" is a copy. A genuine clean
dep rebuild after a patch/fetch-deps change must delete `build/{tbb,ovdb}-wasm*` together
with `build/wasm-prefix*` (verify by counting compile lines in the build log; SK-0.4's
clean run compiled 128 units where the trapped run compiled 0).

## Recommended next steps

1. SK-0.5 follow-up: determine whether the race is upstream (`TreeToMerge` + `DeepCopy`) or in
   the patch's use of it. If upstream, it is a U-row candidate with a strong reproducer.
2. Re-run this toggle matrix as the fix's acceptance test, then delete the gate's `skipIf`.
3. Re-baseline: every MT number measured on `d8ccfb5..ff68494` at <1.0 mm is suspect, because
   dropped geometry makes stages look faster. SK-0.5's own boolean/prune wins need re-measuring
   after the fix.
4. Only then revisit the mimalloc question.
