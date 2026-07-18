# picogk-js benchmarks

> Measured on Apple M2 Pro (12 cores, 32 GiB), darwin 25.0.0, node v24.6.0, wasm d0e7283d8120 (5,806,517 B), commit 6bf52b6, 2026-07-18.
> **Absolute numbers are device-specific; treat ratios and phase splits as the portable signal.**
> Reproduce with `npm run bench` (the harness refuses loaded machines). Source: `bench/results/2026-07-18-6bf52b6.json`.
>
> Native-comparison figures (the ~1.95× PicoGK wasm tax, R20's 3–9% SDF callback overhead, R11's ~150×
> bulk-readback win) are imported by reference from the measured records in the research docs
> (picogk-wasm-kernel-blueprint) — native builds live outside this repo's toolchain.

| Metric | Description | Phase | Median | Min | Max |
| --- | --- | --- | ---: | ---: | ---: |
| M1 | createPicoGK() cold instantiate (5.8 MB module) | instantiate | 8.418 ms | 8.272 | 9.46 |
| M2@0.5 | sphere r=10 @ 0.5mm | build | 0.99 ms | 0.955 | 1.342 |
|  |  | volume | 0.866 ms | 0.861 | 0.923 |
| M2@0.25 | sphere r=10 @ 0.25mm | build | 3.045 ms | 3.04 | 3.078 |
|  |  | volume | 3.163 ms | 3.149 | 3.186 |
| M3@0.5 | gyroid implicit @ 0.5mm (JS SDF) | render | 18.23 ms | 17.619 | 18.79 |
|  |  | mesh | 13.564 ms | 13.189 | 14.624 |
| M3@0.25 | gyroid implicit @ 0.25mm (JS SDF) | render | 119.873 ms | 116.601 | 128.307 |
|  |  | mesh | 49.971 ms | 47.684 | 51.055 |
| M4 | union + subtract + intersect chain (differential shapes) | chain | 6.883 ms | 6.824 | 6.944 |
| M5 | offset +2 and smoothen(1) on a CSG body | offset | 250.574 ms | 250.278 | 259.026 |
|  |  | smoothen | 424.363 ms | 423.982 | 427.336 |
| M6 | mesh readback bulk vs per-element (0.25mm gyroid) | bulk | 0.509 ms | 0.363 | 0.609 |
|  |  | perElement | 20.904 ms | 19.756 | 21.826 |
| M7 | 100k-triangle synthetic bulk import | import | 1.609 ms | 1.59 | 1.627 |
| M8 | full interpolated slice sweep + vectorize (sphere r=8) | sweep | 4.216 ms | 3.997 | 4.862 |
| M9 | facade vs raw: 10k isEmpty calls | raw10k | 15.552 ms | 15.495 | 16.864 |
|  |  | facade10k | 15.475 ms | 15.163 | 16.902 |
| M10@single | gyroid tape @ 0.25mm (single entry) | render | 49.677 ms | 49.489 | 50.186 |
|  |  | mesh | 50.25 ms | 49.812 | 52.187 |
| M10@multi | gyroid tape @ 0.25mm (multi entry) | render | 13.922 ms | 11.73 | 14.628 |
|  |  | mesh | 46.244 ms | 44.561 | 48.654 |

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

**Measured — NEGATIVE RESULT, REVERTED**: gyroid single 561 → 603 ms (**0.93×**), union64
192 → 202 ms (0.95× — union64 has no trig, so that loss is pure partner-bookkeeping overhead
in the hot evaluator loops), sphere flat, multi flat; identity stayed exact and the suite
green, so the fusion itself was correct — just slower. Root cause: musl `sincos` returns
through memory out-params (two linear-memory stores + loads per call on wasm) and still runs
both kernels, so the one shared `__rem_pio2` it saves is eaten by the call shape; the added
per-instruction partner checks then push the balance negative even on the fixture the stage
targeted. The implementation was verified bit-identical before removal, then reverted to the
TP7b build (snapshot-restored byte-exact). Lesson recorded: on wasm32, fusing paired libm
calls is not worth a memory-out-param ABI — revisit only if a register-returning sincos
becomes available.

### TP7d — affine-arithmetic classification (measured ceiling)

**Approach**: replace interval classification with reduced affine forms
(c₀ + c₁εx + c₂εy + c₃εz + e·[−1,1]; conservative ulp accumulation into e; NaN flag and
no-information collapse carried over from TP6; interval-semantics fallback for ops without an
affine rule). Affine forms track the correlation that plain intervals lose on trig products —
the reason the gyroid classifies only 20% of slabs.

**Expected**: gyroid ≤ ~1.6× fill ceiling (voxEval 12.15M → narrow-band floor; classify cost
rises ~3–4× from a 2.3% base); ~0 for sphere/union64 (already 78%+ classified). Decision by
measurement: kept only if a net win on the gyroid with no regression elsewhere.

**Measured — NEGATIVE RESULT, REVERTED**: gyroid single 537 → 538 ms (**1.00× — the affine
retry reclassified essentially nothing**), sphere 90 → 93 ms (−3%), union64 182 → **220 ms
(−17%)** — its 144 IA-ambiguous columns each paid a 1,343-instruction affine sweep that never
fired. Identity exact, suite green: the AF1 rules were sound, just useless here. Structural
diagnosis, not an implementation artifact: the gyroid's `abs(Σ sin·cos) − 0.4` needs the
affine sum to clear **±0.7** (background 0.3 + iso offset 0.4), and the unavoidable slack —
mul cross-terms rad·rad ≈ 0.06 per product at 0.5 rad/block, plus the abs-straddle collapse
to a degenerate form — consumes the very margin correlation tracking recovers at 8³
granularity. Reverted to the TP7b build (snapshot-restored byte-exact). Revisit only with
finer blocks or a field without an abs-threshold root.

### Program outcome (cumulative, vs TP6 `80f9a68`)

Two of four stages landed; two measured negative and were reverted with findings recorded.
Cumulative landed effect (TP6 → TP7b, back-to-back pairs): **gyroid single 1,403 → 586 ms
(2.4×) / multi 215 → 87 ms (2.5×); sphere single 193 → 94 ms (2.1×) / multi 31 → 17 ms
(1.8×); union64 single 471 → 196 ms (2.4×) / multi 70 → 29 ms (2.4×)** — on top of TP6
pruning's 1.2–13.3×, all bit-identical to the JS-callback path.

### R11 — HelixHeatX voxel sweep vs LEAP71's published table (2026-07-19)

The flagship real-world subject (blueprint R11): the whole HelixHeatX Task
headless — geometry generation (~10⁵ lattice beams), the boolean assembly,
the full finishing family (offset/fillet/smoothen/projectZSlice), meshing and
binary-STL bytes. LEAP71's published numbers ("on a MacBook Air", README
table.png) time the same Task INCLUDING viewer previews + screenshots, a
delta in the published numbers' favour. Apple M2 Pro, 12 threads on the multi
build; start load 4.2 (not a quiet-machine baseline — treat timings as upper
bounds). One run per cell; integrity = single≡multi identity (volume hex, STL
FNV-1a and byte count) at every size, which held throughout — the entire
application is thread-count-deterministic. Source:
`bench/results/heatx-sweep-2026-07-18-85d283b.json`.

| voxel (mm) | single (s) | multi (s) | published (s) | STL ours (MB) | STL published (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 61.8 | 38.2 | 34 | 93.7 | 94 |
| 0.9 | 81.8 | 43.1 | — | 122.1 | — |
| 0.8 | 103.9 | 49.7 | — | 165.2 | — |
| 0.7 | 151.1 | 73.1 | — | 227.1 | — |
| 0.6 | 262.2 | 95.0 | — | 328.0 | — |
| 0.5 | 420.9 | 133.0 | 98 | 502.4 | 502 |

Readings:
- **Geometry parity (the D5 signal): STL sizes match the published table to
  0.1–0.4% at both published cells** (502.4 vs 502 MB; 93.7 vs 94 MB decimal).
  Same tri counts ⇒ same part.
- **Thread scaling grows with the workload**: 1.6× at 1.0 mm → 3.2× at 0.5 mm
  (the narrow-band work at fine voxels parallelizes; per-op overheads amortize).
- **wasm vs native**: multi lands within 1.4× of the published native-C#
  number at 0.5 mm despite the previews delta running against us.
- **Authoring is noise (Finding 8 confirmed at production scale)**: the pure-JS
  lattice loops cost 0.4–0.8 s of 38–421 s wall — <1.5% everywhere. No batch
  promotion warranted.
- Native memory passes 1 GiB below 0.7 mm (the session-level warning fires);
  the 0.3/0.2 mm cells are R12's memory-gated territory.

M11 (RoverWheel Wheel_02) and M12 (HelixHeatX @ 1.0 mm single/multi) join the
generated metric table on the next `npm run bench -- --update` run.

### R12 — fine-voxel ceiling (0.3/0.2 mm), documented (2026-07-19)

Attempted per the memory-gated protocol (`node bench/heatx-sweep.mjs --sizes
0.3 --builds multi`): **0.3 mm does NOT complete on wasm32.** The session's
native-memory warning fires (>1 GiB) during fin/void construction, and the
run dies when a later allocation exhausts the 4 GB linear-memory ceiling —
notably during a *small* flange-cylinder mesh build, i.e. the heap was
already consumed by long-lived intermediates (the HeatX assembly holds
fins + voids + structure grids concurrently; at 0.3 mm that is ~4.6× the
0.5 mm narrow-band footprint, plus the ~1.4 GB STL to come). 0.2 mm
(published: 1240 s / 3.4 GB STL) fails a fortiori. Mitigation paths, not
pursued here: explicit `dispose()` of intermediates inside the subject
(against the port-fidelity goal of keeping the C# structure), a
memory64 build, or out-of-core STL streaming. The user-priority 0.5–1.0 mm
band is comfortably inside the ceiling.

(The probe also exposed that a failed wasm `_malloc` near the ceiling
surfaces as a raw `RangeError` from `HEAPF32.set` rather than the typed
`PICOGK_OUT_OF_MEMORY` error — hardened in the facade as a follow-up
commit.)
