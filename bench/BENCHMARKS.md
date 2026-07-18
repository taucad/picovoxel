# picogk-js benchmarks

> Measured on Apple M2 Pro (12 cores, 32 GiB), darwin 25.0.0, node v24.6.0, wasm 31f1f1de991c (5,763,731 B), commit 7212f2a, 2026-07-17.
> **Absolute numbers are device-specific; treat ratios and phase splits as the portable signal.**
> Reproduce with `npm run bench` (the harness refuses loaded machines). Source: `bench/results/2026-07-17-7212f2a.json`.
>
> Native-comparison figures (the ~1.95× PicoGK wasm tax, R20's 3–9% SDF callback overhead, R11's ~150×
> bulk-readback win) are imported by reference from the measured records in the research docs
> (picogk-wasm-kernel-blueprint) — native builds live outside this repo's toolchain.

| Metric | Description | Phase | Median | Min | Max |
| --- | --- | --- | ---: | ---: | ---: |
| M1 | createPicoGK() cold instantiate (5.8 MB module) | instantiate | 9.812 ms | 9.559 | 13.843 |
| M2@0.5 | sphere r=10 @ 0.5mm | build | 1.117 ms | 1.007 | 1.441 |
|  |  | volume | 0.919 ms | 0.887 | 0.945 |
| M2@0.25 | sphere r=10 @ 0.25mm | build | 3.398 ms | 3.19 | 3.493 |
|  |  | volume | 3.332 ms | 3.283 | 3.521 |
| M3@0.5 | gyroid implicit @ 0.5mm (JS SDF) | render | 19.553 ms | 19.065 | 24.235 |
|  |  | mesh | 14.053 ms | 13.862 | 14.835 |
| M3@0.25 | gyroid implicit @ 0.25mm (JS SDF) | render | 138.433 ms | 129.693 | 140.081 |
|  |  | mesh | 59.193 ms | 53.59 | 59.741 |
| M4 | union + subtract + intersect chain (differential shapes) | chain | 7.096 ms | 7.042 | 7.23 |
| M5 | offset +2 and smoothen(1) on a CSG body | offset | 291.829 ms | 287.308 | 305.538 |
|  |  | smoothen | 506.893 ms | 502.069 | 517.483 |
| M6 | mesh readback bulk vs per-element (0.25mm gyroid) | bulk | 0.674 ms | 0.346 | 0.806 |
|  |  | perElement | 24.697 ms | 21.475 | 25.327 |
| M7 | 100k-triangle synthetic bulk import | import | 1.766 ms | 1.652 | 2.107 |
| M8 | full interpolated slice sweep + vectorize (sphere r=8) | sweep | 4.541 ms | 4.112 | 5.446 |
| M9 | facade vs raw: 10k isEmpty calls | raw10k | 17.326 ms | 16.952 | 25.513 |
|  |  | facade10k | 17.016 ms | 16.446 | 19.288 |

Identity oracles (hex-float volumes, FNV-1a mesh hashes) are bit-stable across the 5 repeats of every metric — enforced by the harness, not reviewed by eye.

**Repeatability**: consecutive quiet-machine runs agree within ±10% on every phase ≥ 1 ms;
sub-millisecond phases (e.g. M6 bulk readback) are timer-noise-dominated and may vary up to ±20% — their RATIO to the paired phase is the signal.

**Sanity anchors** (vs the research-doc records): M6's bulk-vs-per-element ratio grows with mesh size —
~50× here on a ~40k-vertex gyroid, consistent with R11's ~150× record at 174k vertices; M3's render phase
(~130 ns/sample at 0.25 mm including voxel work) is consistent with R20's 3–9% JS-SDF callback overhead;
M9 shows the facade adds no measurable cost over raw cwraps at 10k calls (within run-to-run noise).
## Appendix — TP7: post-pruning evaluation program (2026-07-18)

The TP6 re-profile (throwaway phase instrumentation on commit `80f9a68`; percentages stable
across repeats, single-variant rows) reframed where the pruned fill spends its time:

| fixture (single) | fill | classify | **eval** | write | merge+tiles |
| --- | ---: | ---: | ---: | ---: | ---: |
| gyroid @0.1mm | 1,449 ms | 2.3% | **90.7%** | 6.0% | ~0 |
| sphere @0.1mm | 200 ms | 5.1% | **84.3%** | 8.0% | ~0 |
| union64 @0.25mm | 494 ms | 10.6% | **87.5%** | 1.4% | ~0 |

The fill is 84–91% tape **evaluation** — the callback-era "86% write machinery" split does not
hold on the tape path, so this program attacks evaluation. Supporting counters: gyroid evaluates
12,152,079 voxels × 32 instructions (only 20% of slabs classified, zero interior, no min/max to
shorten) and 4 of its 6 libm trig calls per voxel depend only on x or y — loop-invariant along z.
union64's tape shortens 1,343 → 114.8 avg instructions.

**Protocol**: every stage must be volume-hex + triangle-count identical to the TP6 baseline
(`bench/tape-prune-ab.mjs`, 1 warmup + 5 repeats, back-to-back against the previous stage's
preserved module pair), suite-green, and browser-gated at the end. Numbers below are
loaded-machine A/B pairs — **ratios are the signal** (header rule applies).

### TP7a — loop-invariant hoisting (axis-dependency levels)

**Approach**: tag each tape instruction with an axis-dependency mask (const / x-only / xy / z);
evaluate each class at its loop depth in `DenseFill` — constants once per slab, x-only once per
row, xy once per column, only the z-varying suffix per voxel. Same scalar operations on the same
inputs, computed once instead of up to 512 times — bit-identical by construction. Subsumes
interpreter-dispatch amortization for the hoisted share.

**Expected**: gyroid eval 1,315 → ~490 ms (6 → 2 libm calls/voxel) ⇒ fill ~1,450 → ~620 ms
(~2.3×); sphere ~1.5× (pow(x²), pow(y²) hoist); union64 ~1.8× (per-sphere x/y distance terms
hoist, ≈⅔ of the pows).

**Measured** (back-to-back vs the preserved TP6 pair, all cells volume-hex + tri-count
identical): gyroid single 1,403 → **735 ms (1.91×)** / multi 215 → **95 ms (2.26×)**;
sphere single 193 → **114 ms (1.69×)** / multi 31 → 17 ms (1.82×); union64 single
471 → **247 ms (1.91×)** / multi 70 → **32 ms (2.19×)**. Close to prediction on every
fixture (gyroid's shortfall vs ~2.3× is the per-voxel interpreter dispatch the SIMD stage
targets); multi gains exceed single — the smaller working set also relieves memory pressure
across 12 threads. New differential pins the empty-level-3 path (z-independent tape ⇒ result
register hoists out of the voxel loop; STL-byte identical to its JS twin).

### TP7b — f64x2 SIMD over z-pairs (exact-rounding subset)

**Approach**: evaluate the z-varying suffix two z-samples at a time with wasm SIMD128 `f64x2`
for the exact-rounding ops (+, −, ×, ÷, sqrt, floor, mod, abs, neg) plus min/max rebuilt as
compare+bitselect to replicate `std::min`/`std::max` NaN- and signed-zero semantics bit-exactly.
Transcendentals (sin/cos/pow/exp/log) stay scalar musl calls per lane — the tape ≡ JS pin holds
because musl-wasm ≡ V8 fdlibm, and a vectorized polynomial libm would break it. Odd z-tail runs
scalar.

**Expected**: honest and modest on THESE fixtures — after TP7a the per-voxel residue is
libm-dominated (gyroid: sin/cos(z·s); sphere/union64: pow(z−c, 2)), so 1.05–1.2×. The real
beneficiaries are pow-free arithmetic-heavy tapes (box/plane/CSG-of-quadrics style). Halving
level-3 dispatch is the side benefit.

**Measured** (back-to-back vs the preserved TP7a pair, identity exact; TP7a re-measured within
1.5% of its own A/B — single-thread rows are load-robust): gyroid single 746 → **586 ms
(1.27×)**; sphere single 113 → **94 ms (1.20×)**; union64 single 241 → **196 ms (1.23×)**.
Slightly ahead of prediction — halved dispatch is worth as much as the lanes here. Multi rows
were captured under a 30–43 loadavg spike and show no separable signal (gyroid 107 → 107 ms);
the single ratios are the portable result for this stage.

### TP7c — sincos fusion (gyroid-class fields)

**Approach**: when a tape contains sin(a) and cos(a) of the same operand, evaluate both with one
musl `sincos` call — one shared argument reduction (`__rem_pio2`) feeding the same `__sin`/`__cos`
kernels the separate calls use, so results are bit-identical (pinned by the existing tape ≡ JS
differentials and the cross-engine hex gate).

**Expected**: gyroid-only ~1.1–1.3× (the z-pair is the only per-voxel pair left after TP7a);
nil for the distance fixtures.

**Measured**: _(pending)_

### TP7d — affine-arithmetic classification (measured ceiling)

**Approach**: replace interval classification with reduced affine forms
(c₀ + c₁εx + c₂εy + c₃εz + e·[−1,1]; conservative ulp accumulation into e; NaN flag and
no-information collapse carried over from TP6; interval-semantics fallback for ops without an
affine rule). Affine forms track the correlation that plain intervals lose on trig products —
the reason the gyroid classifies only 20% of slabs.

**Expected**: gyroid ≤ ~1.6× fill ceiling (voxEval 12.15M → narrow-band floor; classify cost
rises ~3–4× from a 2.3% base); ~0 for sphere/union64 (already 78%+ classified). Decision by
measurement: kept only if a net win on the gyroid with no regression elsewhere.

**Measured**: _(pending)_
