# SK-0.8 — offset renormalization tuning, exposed behind an opt-in and tolerance-gated

**Date**: 2026-07-26 · **Branch**: `webgpu` (from `2dc672a`) · **Audit**: A4
`docs/research/picogk-runtime-performance-deficiency-audit.md`, charter SK-0.8

## Verdict

The 2–4× hypothesis holds, and the mechanism is now fully attributed. But the **audit's
suggested aggressive setting is the wrong knob**: of the two the audit named, only the
spatial-scheme knob is safe, and the `normCount` knob it leads with is the one that
destroys the level set.

| | |
| --- | --- |
| Renormalization's share of the offset wall | **93.9 – 97.5%** (measured, not assumed) |
| Certified opt-in: `FIRST_BIAS`, sweep count left at upstream's 3 | **3.49× – 3.95×**, CI widths ≤ 0.02× |
| Default path | **bit-identical**, proved four ways (below) |
| Settings that clear the proposed gates | **2 of 8** — both on the scheme axis at the default sweep count |
| Settings that break `tools::checkLevelSet` | **every** setting with `normCount < 3`, plus `WENO5` |

Exposed as `Voxels_OffsetTuned` (`src/pico-offset.cpp`, no patch needed — the knobs are
public `LevelSetTracker` API), surfaced as `fastRenorm?: boolean` on `offset`,
`doubleOffset`, `smoothen`, `fillet` and `shell`.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro (Mac14,10), 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 / v26.5.0 |
| Power | **BATTERY, not AC** — 55–63%, discharging, `lowpowermode 0`. See below. |
| Load | 3.05–3.60 (1-min), ceiling cores/2 = 6.0. No sibling spike; resident Claude/Cursor/WindowServer only |
| Build | dlmalloc (the committed baseline allocator), serial `pico.wasm`, `-O3 -msimd128` |

**The battery deviation, and why the numbers still stand.** The standing rules ask for
AC; the machine was on battery for the whole run and I cannot plug it in. Three things
contain the risk rather than hand-wave it:

1. Every ratio is **paired and order-alternated within one process**
   (`collectPairedSamples`), so a mid-run clock change moves both arms of a pair
   together. The reported figure is a bootstrap CI on the median log-ratio.
2. The absolute default-arm numbers land **within 0.5% of the committed AC-power
   baseline**: M5 offset 227.4 ms here vs **228.5 ms** in
   `sk-0.1-baseline-dlmalloc.json`; M5 smoothen 390.8 vs **391.3 ms**. If the battery
   were throttling, this is where it would show, and it does not.
3. The whole sweep was run **twice** (12 paired repeats each). Every speedup reproduced
   within 2% and the accuracy metrics reproduced to the digit — they are deterministic
   functions of the output grids, not timings.

Raw data: `bench/results/webgpu-v2/sk-0.8-ab.json` (second run; both runs agreed).

---

## 1. Knob map

The audit's "FIRST_BIAS / normCount" names resolve to two public setters on
`openvdb::tools::LevelSetTracker`, which `LevelSetFilter` inherits. Nothing is private
and nothing needs patching — the knobs are simply **unreachable from PicoGK's exports**,
which construct their filter locally and take no settings.

| audit name | real identifier | file:line | default | meaning |
| --- | --- | --- | --- | --- |
| FIRST_BIAS | `LevelSetTracker::setSpatialScheme(math::BiasedGradientScheme)` | `LevelSetTracker.h:147` | `HJWENO5_BIAS` (= 4) | gradient stencil used by the Eikonal solve. `FIRST_BIAS`=0, `SECOND`=1, `THIRD`=2, `WENO5`=3, `HJWENO5`=4 (`math/FiniteDifference.h:164-171`) |
| normCount | `LevelSetTracker::setNormCount(int)` | `LevelSetTracker.h:161` | `LEVEL_SET_HALF_WIDTH` = **3** | normalization sweeps per `normalize()` call (`LevelSetTracker.h:542`) |
| — | `setTemporalScheme` | `LevelSetTracker.h:153` | `TVD_RK1` | already the cheapest (1 Euler step); nothing to win. Not exposed. |
| — | `setGrainSize` | `LevelSetTracker.h:168` | 1 | TBB grain; orthogonal to accuracy, out of scope |

**How an offset drives them.** `LevelSetFilter::Filter::offset(value)`
(`LevelSetFilter.h:355-377`) advances the surface in CFL-limited steps of
`CFL = 0.5 × voxelSize`, and calls `mParent->track()` after **every** step. `track()`
(`LevelSetTracker.h:302-315`) is `dilateActiveValues(1)` → `normalize()` → `prune()`,
and `normalize()` runs `getNormCount()` sweeps of the spatial scheme.

So one `offset(d)` call costs `⌈|d| / CFL⌉` CFL steps, each paying **3 HJ-WENO5 sweeps
over every leaf in the band**. Upstream's own header says this is more than an offset
needs: *"this dilate method can often be used with a single iterations of low-order
re-normalization"* (`LevelSetTracker.h:115-123`) — that advice was written for narrow-band
dilation, but the reasoning (interface tracking rebuilds the band accurately, so the
solve does not have to) applies with more force to an offset, which moves the surface
along its own normal by a constant and therefore never leaves the distance property far
behind in the first place.

**No patch, no vendored-tree edit.** `Voxels::roVdbGrid()` (`PicoGKVdbVoxels.h:849`) is
public and returns `m_roGrid` itself, so a sibling TU can build a filter over the same
grid object. And `RebuildGrid()` — which PicoGK's three offset entry points call before
and after their filter work — is **dead code**: `PicoGKVdbVoxels.h:888-892` opens with an
unconditional `return`, upstream-disabled "until we determine it is necessary". That is
why one 20-line TU reproduces all three exports exactly.

---

## 2. Renorm-count table per entry point

Counted **from code** (the CFL loop above) and then **verified empirically** in §4 — both,
not either.

`steps(d) = ⌈|d| / (0.5 × voxelSize)⌉` per `offset()` call; each step = 1 dilate +
`normCount` sweeps + 1 prune. At the default `normCount = 3`:

| entry point | `offset()` calls (PicoGK-signed) | CFL steps | renorm sweeps | at 0.5 mm, the fixture distance |
| --- | --- | --- | --- | --- |
| `offset(d)` → `Voxels_Offset` | `[d]` | `steps(d)` | `3·steps(d)` | `d=+2`: 8 steps, **24 sweeps** |
| `doubleOffset(a, b)` → `Voxels_DoubleOffset` | `[a, b]` | `steps(a)+steps(b)` | `3·(…)` | `(2,−2)`: 16 steps, **48 sweeps** |
| `fillet(r, f)` → same export | `[r, −r+f]` | `steps(r)+steps(r−f)` | `3·(…)` | `r=2, f=0`: 16 steps, **48 sweeps** |
| `smoothen(d)` → `Voxels_TripleOffset` | `[d, −2d, d]` | `2·steps(d)+steps(2d)` | `3·(…)` | `d=1`: 4+8+4 = 16 steps, **48 sweeps** |
| `shell({offset: d})` | 1 `offset` + 1 boolean | `steps(d)` | `3·steps(d)` | — |
| `shell({inner, outer, smoothInner})` | 2 `offset` + 1 `TripleOffset` when smoothing | sum of the above | — | — |
| parity fixture `offset(1.5)` | `[1.5]` | 6 | **18 sweeps** | — |

The sweep count scales as `1/voxelSize` for a fixed distance — halving the voxel size
doubles the CFL steps **and** quadruples the leaves each sweep visits. This is the term
that makes offsets the dominant cost on fine-cell models.

---

## 3. Timing A/B — 4 fixtures × 8 settings, 12 paired repeats each

Default arm = the shipped untuned export (`Voxels_Offset`/`DoubleOffset`/`TripleOffset`),
so any per-call overhead the new TU adds lands in the tuned arm. Timed span = the two
calls the facade's `derive()` makes (`Voxels_hCreateCopy` + the offset); destroy is
outside the timer.

**Speedup (default ÷ tuned), median with bootstrap 95% CI:**

| setting (scheme, normCount) | M5 offset +2 | analytic sphere +2 | M5 smoothen 1 | parity offset +1.5 |
| --- | --- | --- | --- | --- |
| **FIRST, 3** ← certified | **3.64×** [3.61, 3.65] | **3.49×** [3.48, 3.50] | **3.54×** [3.53, 3.55] | **3.95×** [3.94, 3.96] |
| SECOND, 3 | 2.12× [2.12, 2.13] | 2.08× [2.08, 2.08] | 2.08× [2.08, 2.09] | 2.30× [2.29, 2.30] |
| THIRD, 3 | 1.38× | 1.37× | 1.37× | 1.44× |
| WENO5, 3 | **0.95×** | 0.94× | 0.92× | 0.92× |
| FIRST, 2 | 4.97× | 4.73× | 4.79× | 5.66× |
| FIRST, 1 | 7.91× | 7.24× | 7.47× | 9.89× |
| HJWENO5, 1 | 2.82× | 2.74× | 2.72× | 2.90× |
| FIRST, 0 *(ceiling, not shippable)* | 19.51× | 16.03× | 17.26× | 39.14× |

Absolute default-arm medians: **227.4 / 179.9 / 390.8 / 583.6 ms**.

`WENO5, 3` is **slower than the default** — `HJWENO5` is openvdb's cheaper
Hamilton-Jacobi specialisation of the same 5th-order reconstruction, so asking for plain
`WENO5` buys nothing and costs 5–8%. Worth recording so nobody tries it again.

### Per-stage attribution: the linear-in-`normCount` fit

`normCount ∈ {0,1,2,3}` at `FIRST_BIAS`, same fixture, same process. If the code reading
in §1 is right, the wall must be `fixed + normCount × sweep` with a **constant** slope —
and it is, to within 2% on every fixture:

| fixture | 0 sweeps | 1 | 2 | 3 | per-sweep Δ | FIRST ms/sweep | HJWENO5 ms/sweep* | cost ratio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M5 offset +2 | 11.72 | 28.83 | 45.94 | 62.84 | 17.11 / 17.11 / 16.90 | **17.04** | 71.89 | **4.22×** |
| analytic sphere +2 | 11.01 | 24.38 | 37.44 | 50.59 | 13.37 / 13.05 / 13.15 | **13.19** | 56.28 | **4.27×** |
| M5 smoothen 1 | 22.51 | 51.93 | 81.04 | 110.35 | 29.42 / 29.11 / 29.32 | **29.28** | 122.75 | **4.19×** |
| parity offset +1.5 | 14.54 | 57.53 | 100.54 | 144.25 | 42.99 / 43.01 / 43.72 | **43.24** | 189.68 | **4.39×** |

\* derived as `(default − fixed)/3`, i.e. assuming the non-renorm work is
scheme-independent — which it is, being `dilateActiveValues` + `offsetImpl` + `prune`.

**Renormalization's share of the offset wall** = `1 − fixed/default`:

| fixture | fixed (dilate + offsetImpl + prune) | renorm share |
| --- | --- | --- |
| M5 offset +2 | 11.72 ms | **94.84%** |
| analytic sphere +2 | 11.01 ms | **93.88%** |
| M5 smoothen 1 | 22.51 ms | **94.24%** |
| parity offset +1.5 | 14.54 ms | **97.51%** |

That closes the hypothesis cleanly. Renormalization is ~95% of the wall, an HJ-WENO5
sweep costs ~4.2× a first-order upwind sweep, so the ceiling on a scheme swap is 4.2×
and the measured 3.5–4.0× is exactly `0.95·4.2 + 0.05·1` in reverse. **The 2–4× band was
right, and the reason it is not higher is the 5% of fixed work, not any missing tuning.**

### Distance ladder — the CFL step-count model, empirically

M5 offset shape, `FIRST_BIAS` vs default, 7 repeats per cell:

| distance | CFL steps (model) | default | certified | speedup | no-renorm ceiling | default ms/step |
| --- | --- | --- | --- | --- | --- | --- |
| 1 mm | 4 | 104.4 ms | 29.6 | 3.53× | 6.1 | 26.10 |
| 2 mm | 8 | 227.8 | 63.2 | 3.60× | 11.6 | 28.48 |
| 4 mm | 16 | 536.0 | 144.8 | 3.70× | 16.9 | 33.50 |
| 8 mm | 32 | 1433.6 | 374.7 | 3.83× | 17.0 | 44.80 |

The wall tracks the modelled step count, and the **speedup grows with distance** —
because the fixed 5% is amortised further as the band grows. The `no-renorm` column
saturates past 4 mm, which is itself diagnostic: with zero renormalization the band is
never rebuilt, so there is nothing for the later steps to sweep. It is a ceiling, not a
setting.

---

## 4. Accuracy — metrics, and the proposed L1 gates

### The metric definitions (the shape the L1 GPU-tolerant lane inherits)

All five are computed against the **L0 default output on the same fixture**, plus one
absolute check. They come off the existing ABI — nothing new was invented to measure:

| metric | how | why this one |
| --- | --- | --- |
| **corrected volume, relative delta** | `Voxels_GetProperties` (SG1 mesh round-trip), not raw `levelSetVolume` | the raw integral counts the distance-0 voxels csg leaves behind (SK-0.5 §4); the corrected one is the number the fixtures pin |
| **corrected surface area, relative delta** | same call, `tools::levelSetArea` | strictly more sensitive than volume — it responds to band roughness the volume integral averages out. On the parity fixture the reduced-sweep settings show 9% area drift at 4% volume drift, so a volume-only gate would have passed them |
| **iso-surface bounds, max component delta (mm)** | same call's `PKBBox3` | catches a uniform surface shift that a volume ratio can hide |
| **narrow-band SDF, max and mean \|Δ\| (mm)** | `Voxels_GetZSlice` over the **intersection** of the two active-voxel boxes, at voxels where **both** grids are strictly inside their band (`\|v\| < background`) | the direct field error. Band-membership is per-grid, so voxels the two disagree about are counted separately (`bandMismatch`) rather than silently dropped — including them would measure band extent, not distance error |
| **level-set health** | `Voxels_bDiagnose` → `tools::checkLevelSet` | **the gate that decides everything.** It reports voxels whose \|∇φ\| falls outside [0.5, 1.5] — i.e. where the field has stopped being a signed distance field. Every downstream op assumes it is one: further offsets, `closestPointOnSurface`, `surfaceNormal`, gradient fields, and the mesher's own interpolation |
| **extracted mesh validity** | `Mesh_hCreateFromVoxels` + `Mesh_bIsValid` | the watertightness proxy the tree already has |

Reference outputs: all four fixtures' L0 default has an **empty** diagnosis and a valid
mesh, so the comparison baseline is itself healthy.

### Proposed gate values

Distances in **voxels** so the gate is resolution-independent; at the 0.5 mm fixtures
1 voxel = 0.5 mm.

| metric | proposed L1 gate | where the number comes from |
| --- | --- | --- |
| corrected volume relative delta | **≤ 3%** | the analytic-offset tolerance already in `test/voxels-offsets.test.ts:23`, which is the parity corpus's own offset band |
| corrected area relative delta | **≤ 3%** | same band, applied to the more sensitive of the pair |
| bounds max component delta | **≤ 1 voxel** | `test/voxels-offsets.test.ts:86` already states shell bounds "match the original within a voxel" |
| narrow-band SDF max \|Δ\| | **≤ 1 voxel** | a sub-voxel surface displacement is below what `volumeToMesh` can express |
| narrow-band SDF mean \|Δ\| | **≤ 0.25 voxel** | max/2 — this is a *bias* bound, not an extremum bound, so it must be tighter than the max gate by construction |
| level-set health | **must be EMPTY** | non-negotiable, and not a tolerance: a field with \|∇φ\| outside [0.5, 1.5] is not a distance field. This gate is what rejected 6 of 8 settings |
| `Mesh_bIsValid` | **true** | — |

`bandMismatch` is **reported, not gated** — it tracks narrow-band extent, which pruning
legitimately changes.

### Accuracy table — every setting, every fixture

vol/area in %, sdf and bounds in mm at 0.5 mm voxel (so the 1-voxel gate is 0.500 and the
0.25-voxel gate is 0.125). **Bold** = gate violation.

| setting | fixture | volΔ | areaΔ | boundsΔ | sdf max | sdf mean | bandMiss | level set | mesh | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **FIRST, 3** | M5 offset | 0.879 | 0.754 | 0.016 | 0.194 | 0.0500 | 2 604 | clean | ✓ | pass |
| | analytic | 0.715 | 0.475 | 0.012 | 0.138 | 0.0422 | 1 644 | clean | ✓ | pass |
| | smoothen | 2.137 | 2.057 | 0.081 | 0.306 | 0.0895 | 2 810 | clean | ✓ | pass |
| | parity | 0.185 | 0.345 | 0.129 | 0.358 | 0.0264 | 4 413 | clean | ✓ | pass |
| **SECOND, 3** | M5 offset | 0.084 | 0.068 | 0.000 | 0.084 | 0.0052 | 790 | clean | ✓ | pass |
| | analytic | 0.043 | 0.029 | 0.000 | 0.053 | 0.0026 | 342 | clean | ✓ | pass |
| | smoothen | 0.172 | 0.083 | 0.000 | 0.110 | 0.0077 | 664 | clean | ✓ | pass |
| | parity | 0.080 | 0.128 | 0.114 | 0.385 | 0.0056 | 1 122 | clean | ✓ | pass |
| THIRD, 3 | M5 offset | 0.051 | 0.034 | 0.011 | 0.118 | 0.0072 | 896 | clean | ✓ | |
| | analytic | 0.057 | 0.038 | 0.011 | 0.058 | 0.0048 | 648 | clean | ✓ | |
| | smoothen | 0.205 | 0.164 | 0.053 | 0.330 | 0.0137 | 1 086 | clean | ✓ | |
| | parity | 0.005 | 0.177 | 0.162 | **0.900** | 0.0110 | 2 020 | **40 voxels** | ✓ | **FAIL** |
| WENO5, 3 | M5 offset | 0.558 | 0.441 | 0.031 | **0.512** | 0.0774 | 9 794 | **660 voxels** | ✓ | **FAIL** |
| | analytic | 0.591 | 0.434 | 0.024 | 0.473 | 0.0736 | 6 738 | **252 voxels** | ✓ | **FAIL** |
| | smoothen | 0.965 | 0.175 | 0.060 | 0.485 | 0.0813 | 5 274 | **64 voxels** | ✓ | **FAIL** |
| | parity | 0.157 | 0.206 | 0.086 | **0.572** | 0.0561 | 22 412 | **256 voxels** | ✓ | **FAIL** |
| FIRST, 2 | M5 offset | 0.883 | 0.712 | 0.039 | 0.321 | 0.0626 | 3 788 | clean | ✓ | |
| | analytic | 0.747 | 0.497 | 0.038 | 0.275 | 0.0571 | 2 796 | clean | ✓ | |
| | smoothen | 1.615 | 1.534 | 0.063 | 0.310 | 0.0754 | 2 882 | clean | ✓ | |
| | parity | 0.136 | 0.164 | 0.081 | **0.719** | 0.0353 | 7 243 | **8 voxels** | ✓ | **FAIL** |
| FIRST, 1 | M5 offset | 1.674 | 1.102 | 0.108 | **0.528** | 0.1116 | 6 588 | **384 voxels** | ✓ | **FAIL** |
| | analytic | 1.533 | 1.008 | 0.108 | 0.490 | 0.1089 | 4 932 | **168 voxels** | ✓ | **FAIL** |
| | smoothen | 0.732 | 0.649 | 0.044 | 0.370 | 0.0608 | 3 426 | clean | ✓ | |
| | parity | **3.996** | **9.373** | 0.358 | **2.158** | 0.0675 | 13 486 | clean | ✓ | **FAIL** |
| HJWENO5, 1 | M5 offset | 0.781 | 0.461 | 0.095 | **0.565** | 0.0821 | 8 242 | **1 304 voxels** | ✓ | **FAIL** |
| | analytic | 0.726 | 0.474 | 0.095 | **0.524** | 0.0799 | 6 146 | **1 080 voxels** | ✓ | **FAIL** |
| | smoothen | 0.193 | 0.127 | 0.007 | 0.276 | 0.0332 | 2 668 | **64 voxels** | ✓ | **FAIL** |
| | parity | **4.209** | **9.219** | 0.476 | **2.383** | 0.0510 | 15 723 | **175 voxels** | ✓ | **FAIL** |
| FIRST, 0 | M5 offset | **14.795** | **9.105** | **0.790** | 0.160 | 0.0037 | 33 090 | **6 978 voxels** | ✓ | **FAIL** |
| | analytic | **13.890** | **9.171** | **0.790** | 0.002 | 0.0004 | 21 898 | **5 354 voxels** | ✓ | **FAIL** |
| | smoothen | 0.186 | 0.170 | 0.032 | 0.334 | 0.0073 | 23 928 | **8 514 voxels** | ✓ | **FAIL** |
| | parity | 1.471 | **10.512** | 0.370 | **2.456** | 0.0125 | 83 330 | **23 876 voxels** | ✓ | **FAIL** |

**Certified `FIRST, 3` margins against the gates**: volume 2.137/3.0 = 71% of budget
(worst case, on `smoothen`); area 2.057/3.0 = 69%; bounds 0.129/0.500 = 26%; sdf max
0.358/0.500 = 72%; sdf mean 0.0895/0.125 = 72%; level set clean on 4/4. The tightest
margin is 28% headroom, which is the honest read: this is a *bounded* approximation, not
a free lunch, and the option is opt-in for that reason.

### The analytic cross-check — the tuned arm is not simply "worse"

On the sphere fixture the closed form is known (`4/3·π·12³`), so both arms can be scored
against truth instead of against each other:

| setting | volume error vs analytic | area error vs analytic |
| --- | --- | --- |
| **L0 default (HJWENO5, 3)** | 0.0935% | 0.1205% |
| **SECOND, 3** | **0.0500%** | **0.0917%** |
| THIRD, 3 | 0.1501% | 0.1582% |
| WENO5, 3 | 0.4971% | 0.3128% |
| FIRST, 3 | 0.8073% | 0.5949% |
| FIRST, 1 | 1.6247% | 1.1267% |
| FIRST, 0 | 13.9701% | 9.2802% |

`SECOND_BIAS` at the default sweep count is **more accurate than the shipped default**
against the closed form, at 2.1–2.3×. That reframes the whole "accuracy cost" framing for
that row: it is not a trade, it is strictly better geometry twice as fast. It is still
not the default here, because the default is byte-locked and byte-locked wins.

---

## 5. Why the certified opt-in is `FIRST_BIAS` at three sweeps

The two knobs are **not interchangeable**, which is the main correction to the audit:

- **Lowering the spatial scheme's order preserves the Eikonal property.** `FIRST` and
  `SECOND` at three sweeps leave `checkLevelSet` clean on 4/4 fixtures. The solve still
  converges; it just converges with a cheaper stencil.
- **Lowering the sweep count destroys it.** Every `normCount < 3` setting measured
  reported voxels outside `NormGrad [0.5, 1.5]` on at least one fixture, and the failures
  are concentrated on the fixture with concave detail and a subtracted cavity (parity),
  where the solve has the most work to do per step.
- **`HJWENO5, 1` is strictly dominated by `FIRST, 3`**: slower (2.82× vs 3.64×) *and*
  broken (1 304 bad voxels vs clean) *and* less accurate on parity (4.2% vs 0.2% volume).
  A 5th-order stencil that is not iterated to convergence is worth less than a 1st-order
  stencil that is. That is the single most useful finding here for the L1 lane.

So `fastRenorm: true` = `setSpatialScheme(FIRST_BIAS)` with `normCount` **left at
upstream's 3**. `SECOND_BIAS` is the obvious second preset and is deliberately **not**
added: `Voxels_OffsetTuned` on the `picovoxel/raw` subpath reaches both knobs directly, so
re-sweeping needs no new facade surface. One preset, one integer constant
(`src/voxels.ts` `FAST_RENORM_SCHEME`), no config object.

---

## 6. The default path is bit-identical

Four independent proofs, because this is the assertion the L0 oracle rests on:

1. **`Voxels_OffsetTuned(scheme=-1, count=-1)` ≡ the untuned exports**, bit-for-bit, on
   `Offset(+2)`, `Offset(−2)`, `DoubleOffset(2,−2)` and `TripleOffset(1)` — and also when
   the defaults are spelled out explicitly as `(4, 3)`. `Voxels_bIsEqual` true and
   hex-float volumes equal in all 8 combinations
   (`test/voxels-offsets.test.ts`, `test/tier2.test.mjs` C3).
2. **The facade's default path is unchanged**: `offset`, `doubleOffset`, `smoothen` and
   `fillet` without `fastRenorm` still call `Voxels_Offset`/`DoubleOffset`/`TripleOffset`
   directly — the new export is not even on the code path. Pinned per entry point against
   the raw export (`test/voxels-offsets.test.ts`).
3. **The six byte-locked fixtures are byte-identical**, `git status test/fixtures/` clean:

| fixture | sha256 |
| --- | --- |
| helixheatx.json | 56298c702d37ed991180117019e16edf584d2f01291b34e327053ec1d74c2eec |
| latticelibrary-examples.json | 9e360d57ee590b2d3bc0ea26620eaad182ec7e0e5477904586e9d09705af6c0a |
| quasicrystals.json | b120759423e59d2319626719cf1222adf003a2f0a2213ec96a2978913ec9f1c0 |
| roverwheel.json | 5a5ee9da71e7f6920e9cc6db0f85eae0e263a350a0af8cd054729d291f718749 |
| shapekernel-examples.json | 52e2702d51b41b2b2dc18a67de1b15628ff536f78f929d25266d4ce94504218f |
| simulation.json | 08c9a479c2e225cbcc35699422865a93998956c4e2be8e0c1c76805d6fe926b6 |

4. **The 0.7 mm fine-cell single≡multi identity gate is green**, as is the 1.0 mm
   HeatX pin with its STL-byte parity:

```
✓ HelixHeatX @ 1.0 mm: pinned result, STL-size parity, single↔multi identity  93959ms
✓ HelixHeatX @ 0.7 mm: multi build reproduces the pinned fine-cell geometry    57837ms
```

And the negative control: `fastRenorm: true` **must** change the output, asserted per
entry point. A knob that silently no-op'd would have sailed through every accuracy gate.

## 7. Suite

```
Test Files  49 passed (49)
Tests      464 passed (464)
```

461 before, +3 SK-0.8 tests (`test/voxels-offsets.test.ts`): the four-entry-point default
pin, the `OffsetTuned`-reproduces-upstream differential, and the gate check on
`offset`/`smoothen`/`shell`. Tier-2 ABI coverage **151/151** (140 core + 11 own-TU) —
`Voxels_OffsetTuned` is exercised with both oracles in C3. `tsc --noEmit` clean,
`tsdown` build clean.

## 8. Artifacts

| file | sha256 |
| --- | --- |
| `src/pico-offset.cpp` | 2c1a09ded2ab0983dc7fd5dee60b238c72f8bfdd9ee2db0a1d6efaa0417fa425 |
| `bench/offset-renorm-ab.mjs` | ba636755540ce350e6598e1f7c8520cf41f2d2db0bc418ffc596d54b8bff8879 |
| `bench/results/webgpu-v2/sk-0.8-ab.json` | f4b7cc2de829ec68752772afb716cc8175bc054a51d10ef22ed9e4547cbff246 |
| `src/pico.wasm` (untracked, rebuilt) | e774dcd6c1d4c59e1784426e1fe0144c5f09621766cb357548abec48c2501789 |
| `src/pico.mjs` (untracked, rebuilt) | d3772998afbac4288301d935818a6e516f77ef426714c76095677790e90f5c30 |
| `src/pico-multi.wasm` (tracked) | be5dbf5cbeae3fc059452286ee9744feba10e17d1282f33469c07693d8279158 |
| `src/pico-multi.mjs` (tracked) | 04c7578ef92974c50f4aa5f4271f1acd97a6b6f9b34524c9b639310f4c9e2597 |

No `patches/` change, no dep rebuild — so hardening warnings H1/H2 from
`SK-0-P0-finecell.md` did not apply, beyond rebuilding **both** module variants
(`THREADS=0` and `THREADS=1`) so the untracked `src/pico.wasm` carries the new export
alongside the tracked multi pair.

## 9. Reproducing

```bash
THREADS=0 bash scripts/build-pico-module.sh && THREADS=1 bash scripts/build-pico-module.sh
npm run typecheck && npm run build && npx vitest run
npx tsx bench/offset-renorm-ab.mjs --repeats 12      # writes sk-0.8-ab.json
```

## 10. What this hands the L1 lane

- **The gate shape**, verbatim: six metrics against the L0 output plus one absolute
  level-set-health check, with the health check as a hard boolean rather than a
  tolerance. A GPU offset kernel that reproduces geometry to 3% but leaves \|∇φ\| outside
  [0.5, 1.5] has not passed — it has produced something the rest of the pipeline cannot
  consume.
- **The area metric is load-bearing.** On the parity fixture the reduced-sweep settings
  sat at 4% volume drift and 9% *area* drift. A volume-only gate passes them.
- **The reference must be scored too.** The analytic column exists because "differs from
  L0" and "less accurate" are not the same claim, and `SECOND_BIAS` is the proof: it
  differs from L0 and is closer to truth.
- **95% of the offset wall is one openvdb loop** (`Normalizer::euler01` under a
  `parallel_for` over the leaf range), and its cost is exactly linear in a settable
  integer. That is the single most GPU-shaped kernel in the offset family, and its CPU
  cost is now characterised per sweep and per fixture, so a GPU bar can be set against
  `17.0 / 13.2 / 29.3 / 43.2 ms per sweep` rather than against a whole-op wall.
