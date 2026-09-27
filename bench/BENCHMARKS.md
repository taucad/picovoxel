# picovoxel benchmarks

> Measured on Apple M2 Pro (12 cores, 32 GiB), darwin 25.5.0, node v26.5.0, wasm 70304cfe70a0 (5,835,133 B), commit 3622099, 2026-07-23.
> **Absolute numbers are device-specific; treat ratios and phase splits as the portable signal.**
> Reproduce with `pnpm run bench` (the harness refuses loaded machines). Source: `bench/results/2026-07-23-3622099.json`.
>
> Native-comparison figures (the ~1.95× PicoGK wasm cost, the 3–9% SDF callback overhead, the ~150×
> bulk-readback win) come from earlier measured runs, not from this harness; native builds live outside
> this repository's toolchain.

| Metric     | Description                                                  | Phase                                    |       Median |       Min |       Max |
| ---------- | ------------------------------------------------------------ | ---------------------------------------- | -----------: | --------: | --------: |
| M1         | createPico() cold instantiate (5.8 MB module)                | instantiate                              |     9.223 ms |     8.395 |    10.225 |
| M2@0.5     | sphere r=10 @ 0.5mm                                          | build                                    |     1.121 ms |     0.897 |     1.437 |
|            |                                                              | volume                                   |     0.822 ms |     0.774 |      0.92 |
| M2@0.25    | sphere r=10 @ 0.25mm                                         | build                                    |     3.223 ms |      3.05 |     3.365 |
|            |                                                              | volume                                   |     3.273 ms |     3.189 |     3.968 |
| M3@0.5     | gyroid implicit @ 0.5mm (JS SDF)                             | render                                   |    17.261 ms |    16.787 |    17.549 |
|            |                                                              | mesh                                     |    13.473 ms |    13.392 |    13.629 |
| M3@0.25    | gyroid implicit @ 0.25mm (JS SDF)                            | render                                   |   109.343 ms |   109.073 |   110.127 |
|            |                                                              | mesh                                     |    48.147 ms |    47.454 |    50.012 |
| M4         | union + subtract + intersect chain (differential shapes)     | chain                                    |     6.821 ms |     6.666 |     7.392 |
| M5         | offset +2 and smoothen(1) on a CSG body                      | offset                                   |   239.287 ms |   231.785 |   245.936 |
|            |                                                              | smoothen                                 |   415.441 ms |   409.079 |   439.877 |
| M6         | mesh readback bulk vs per-element (0.25mm gyroid)            | bulk                                     |     0.631 ms |     0.262 |     0.669 |
|            |                                                              | perElement                               |    15.627 ms |    15.396 |    18.925 |
| M7         | 100k-triangle synthetic bulk import                          | import                                   |     1.692 ms |     1.611 |     1.839 |
| M8         | full interpolated slice sweep + vectorize (sphere r=8)       | sweep                                    |     4.255 ms |     3.596 |     4.438 |
| M9         | facade vs raw: 10k isEmpty calls                             | raw10k                                   |    16.551 ms |    16.435 |    34.481 |
|            |                                                              | facade10k                                |    16.594 ms |    15.909 |     25.35 |
| M10@single | gyroid tape @ 0.25mm (single entry)                          | render                                   |     53.21 ms |    52.528 |    64.121 |
|            |                                                              | mesh                                     |    51.708 ms |    51.054 |    52.683 |
| M10@multi  | gyroid tape @ 0.25mm (multi entry)                           | render                                   |    11.813 ms |    11.224 |    14.941 |
|            |                                                              | mesh                                     |    48.508 ms |     45.12 |    52.874 |
| M11        | RoverWheel Wheel_02 @ 1.0mm (subject)                        | construct                                | 27418.794 ms | 27220.323 | 27623.393 |
|            |                                                              | mesh                                     |   277.256 ms |   271.426 |    277.77 |
|            |                                                              | stl                                      |   151.273 ms |   144.173 |   159.333 |
| M12@single | HelixHeatX @ 1.0mm (single entry)                            | construct                                | 57524.336 ms |  57315.89 | 58023.821 |
|            |                                                              | author                                   |   431.614 ms |   426.546 |   435.803 |
|            |                                                              | kernel:bounding.create                   |   232.793 ms |   230.019 |   235.298 |
|            |                                                              | kernel:turning-fins.hot                  |  3936.898 ms |  3865.145 |  3985.501 |
|            |                                                              | kernel:turning-fins.cool                 |  3941.728 ms |  3898.658 |  4006.628 |
|            |                                                              | kernel:corner-fins.union                 |     4.858 ms |     4.741 |     5.376 |
|            |                                                              | kernel:straight-fins.hot                 |  1286.332 ms |  1254.078 |  1294.874 |
|            |                                                              | kernel:straight-fins.cool                |   1274.53 ms |  1262.059 |  1296.657 |
|            |                                                              | kernel:straight-fins.union               |     4.097 ms |     4.004 |     4.137 |
|            |                                                              | kernel:fins.union                        |     3.374 ms |     3.182 |     3.927 |
|            |                                                              | kernel:outer-structure.create            | 14162.297 ms | 14057.697 | 14382.879 |
|            |                                                              | kernel:helical-void.hot                  |  5347.049 ms |  5311.113 |  5390.031 |
|            |                                                              | kernel:helical-void.cool                 |  5335.416 ms |  5303.194 |  5354.855 |
|            |                                                              | kernel:cool-inner.offset                 |  1025.191 ms |  1023.006 |  1131.269 |
|            |                                                              | kernel:hot-fluid-void.subtract           |     4.826 ms |     4.509 |     5.106 |
|            |                                                              | kernel:hot-inner.offset                  |   1029.02 ms |  1014.386 |  1041.974 |
|            |                                                              | kernel:cool-fluid-void.subtract          |     5.535 ms |     4.852 |     5.565 |
|            |                                                              | kernel:inner-volume.union                |      6.81 ms |     6.359 |      7.34 |
|            |                                                              | kernel:splitters.union                   |     2.297 ms |     2.167 |     3.513 |
|            |                                                              | kernel:outer-volume.offset               |  1120.618 ms |  1108.633 |  1126.731 |
|            |                                                              | kernel:flange.create                     |   2726.48 ms |  2682.614 |  2765.095 |
|            |                                                              | kernel:finished-flange.fillet            |  1039.657 ms |  1029.699 |  1055.661 |
|            |                                                              | kernel:finished-flange.smoothen          |   135.605 ms |   133.424 |   138.177 |
|            |                                                              | kernel:outer-volume.union-flange         |      4.16 ms |     4.015 |     4.685 |
|            |                                                              | kernel:io-supports.create                |   178.862 ms |   176.667 |   181.954 |
|            |                                                              | kernel:outer-volume.union-supports       |     5.875 ms |     5.512 |     6.468 |
|            |                                                              | kernel:outer-volume.fillet               |  7207.478 ms |   7145.64 |  7229.684 |
|            |                                                              | kernel:outer-volume.smoothen             |  1176.691 ms |   1156.92 |  1203.368 |
|            |                                                              | kernel:centre-piece.add                  |    21.052 ms |    20.643 |    21.403 |
|            |                                                              | kernel:outer-volume.union-structure      |     5.821 ms |     5.242 |     6.197 |
|            |                                                              | kernel:outer-volume.subtract-screw-holes |     2.839 ms |     2.699 |     3.047 |
|            |                                                              | kernel:outer-volume.project-z-slice      |     4.902 ms |     4.783 |     4.971 |
|            |                                                              | kernel:print-web.create                  |     2.983 ms |     2.822 |     3.222 |
|            |                                                              | kernel:outer-volume.subtract-print-web   |     3.976 ms |     3.786 |     4.099 |
|            |                                                              | kernel:result.subtract-inner-volume      |     5.698 ms |     5.485 |     6.949 |
|            |                                                              | kernel:result.union-fins                 |     7.513 ms |     6.513 |    10.249 |
|            |                                                              | kernel:result.union-splitters            |     4.027 ms |     3.642 |     4.783 |
|            |                                                              | kernel:result.intersect-bounding         |     4.929 ms |     4.519 |     5.415 |
|            |                                                              | kernel:io-threads.create                 |  5823.319 ms |  5787.559 |  5843.671 |
|            |                                                              | kernel:result.union-threads              |     3.567 ms |     3.294 |     4.017 |
|            |                                                              | kernel:io-cuts.create                    |    25.165 ms |     24.52 |    27.082 |
|            |                                                              | kernel:result.subtract-io-cuts           |     2.038 ms |     1.807 |     2.204 |
|            |                                                              | unattributed                             |     0.401 ms |     0.203 |     0.505 |
|            |                                                              | mesh                                     |   135.511 ms |   134.088 |   138.334 |
|            |                                                              | stl                                      |   123.275 ms |    85.952 |   638.497 |
| M12@multi  | HelixHeatX @ 1.0mm (multi entry)                             | construct                                | 35523.218 ms | 35435.863 | 37391.597 |
|            |                                                              | author                                   |   468.383 ms |   452.154 |   515.776 |
|            |                                                              | kernel:bounding.create                   |   100.656 ms |    89.773 |   126.852 |
|            |                                                              | kernel:turning-fins.hot                  |  3878.177 ms |  3826.071 |  3963.017 |
|            |                                                              | kernel:turning-fins.cool                 |  3872.251 ms |  3860.416 |  4008.027 |
|            |                                                              | kernel:corner-fins.union                 |    14.646 ms |    10.174 |    49.984 |
|            |                                                              | kernel:straight-fins.hot                 |  1260.138 ms |  1237.472 |  1321.886 |
|            |                                                              | kernel:straight-fins.cool                |  1287.494 ms |  1261.446 |  1315.407 |
|            |                                                              | kernel:straight-fins.union               |     10.59 ms |      8.27 |    20.738 |
|            |                                                              | kernel:fins.union                        |      7.83 ms |     5.895 |     9.749 |
|            |                                                              | kernel:outer-structure.create            |  2311.542 ms |  2285.251 |  2375.427 |
|            |                                                              | kernel:helical-void.hot                  |  5334.119 ms |  5299.216 |  5409.584 |
|            |                                                              | kernel:helical-void.cool                 |  5302.984 ms |  5300.505 |  5378.134 |
|            |                                                              | kernel:cool-inner.offset                 |   167.993 ms |   150.981 |   203.599 |
|            |                                                              | kernel:hot-fluid-void.subtract           |    13.076 ms |    11.678 |    13.509 |
|            |                                                              | kernel:hot-inner.offset                  |   149.738 ms |   145.073 |    211.41 |
|            |                                                              | kernel:cool-fluid-void.subtract          |    13.432 ms |      11.3 |    48.459 |
|            |                                                              | kernel:inner-volume.union                |    14.941 ms |    10.652 |    27.311 |
|            |                                                              | kernel:splitters.union                   |     1.824 ms |     1.444 |     2.206 |
|            |                                                              | kernel:outer-volume.offset               |   168.124 ms |   159.031 |   211.755 |
|            |                                                              | kernel:flange.create                     |  2601.057 ms |  2581.069 |   3066.71 |
|            |                                                              | kernel:finished-flange.fillet            |   232.962 ms |   216.363 |   501.221 |
|            |                                                              | kernel:finished-flange.smoothen          |    46.935 ms |    41.214 |    60.628 |
|            |                                                              | kernel:outer-volume.union-flange         |    14.461 ms |     5.161 |    17.727 |
|            |                                                              | kernel:io-supports.create                |   177.268 ms |   176.541 |   183.152 |
|            |                                                              | kernel:outer-volume.union-supports       |    17.301 ms |    14.314 |    22.764 |
|            |                                                              | kernel:outer-volume.fillet               |  1117.313 ms |  1092.635 |  1259.989 |
|            |                                                              | kernel:outer-volume.smoothen             |   190.363 ms |   183.381 |    257.28 |
|            |                                                              | kernel:centre-piece.add                  |     45.46 ms |    33.347 |    55.301 |
|            |                                                              | kernel:outer-volume.union-structure      |    11.443 ms |     9.428 |     22.32 |
|            |                                                              | kernel:outer-volume.subtract-screw-holes |     7.204 ms |      5.63 |    10.871 |
|            |                                                              | kernel:outer-volume.project-z-slice      |     7.855 ms |     7.012 |    10.511 |
|            |                                                              | kernel:print-web.create                  |     3.033 ms |     3.021 |      3.08 |
|            |                                                              | kernel:outer-volume.subtract-print-web   |     15.21 ms |    11.461 |    17.738 |
|            |                                                              | kernel:result.subtract-inner-volume      |     17.01 ms |    15.961 |     18.26 |
|            |                                                              | kernel:result.union-fins                 |    16.453 ms |    14.637 |    27.185 |
|            |                                                              | kernel:result.union-splitters            |    13.581 ms |     8.415 |    16.215 |
|            |                                                              | kernel:result.intersect-bounding         |    20.498 ms |    16.335 |    24.186 |
|            |                                                              | kernel:io-threads.create                 |    6549.6 ms |  6463.443 |  6601.972 |
|            |                                                              | kernel:result.union-threads              |    11.658 ms |     8.999 |    18.756 |
|            |                                                              | kernel:io-cuts.create                    |    43.536 ms |     38.93 |    53.948 |
|            |                                                              | kernel:result.subtract-io-cuts           |    10.678 ms |     5.119 |    19.974 |
|            |                                                              | unattributed                             |     0.519 ms |     0.476 |      0.63 |
|            |                                                              | mesh                                     |     57.39 ms |    56.892 |    68.802 |
|            |                                                              | stl                                      |   123.637 ms |   114.096 |   157.427 |
| M13        | SchwarzDiamond preset @ 0.5mm, [-15,15]³: callback vs tape   | callback                                 |     35.91 ms |    35.722 |    36.842 |
|            |                                                              | tape                                     |    13.572 ms |    13.491 |    13.705 |
| M14        | QuasiCrystal wireframe gens 0/1/2 @ 2.0mm, QuasiTile_02 seed | gen0                                     |     4.715 ms |     4.578 |     4.745 |
|            |                                                              | gen1                                     |   139.212 ms |   137.796 |   142.918 |
|            |                                                              | gen2                                     |  6007.974 ms |  5947.103 |  6136.948 |

Identity oracles (hex-float volumes, FNV-1a mesh hashes) are bit-stable across the 5 repeats of every metric — enforced by the harness, not reviewed by eye.

**Repeatability**: consecutive quiet-machine runs agree within ±10% on every phase ≥ 1 ms;
sub-millisecond phases (e.g. M6 bulk readback) are timer-noise-dominated and may vary up to ±20% — their RATIO to the paired phase is the signal.

**Sanity anchors** (vs earlier measured runs): M6's bulk-vs-per-element ratio grows with mesh size —
~50× here on a ~40k-vertex gyroid, consistent with the earlier ~150× measurement at 174k vertices; M3's render phase
(~130 ns/sample at 0.25 mm including voxel work) is consistent with the earlier 3–9% JS-SDF callback overhead measurement;
M9's raw10k is a deliberately retained emscripten ccall and the facade now runs on direct exports; the rows sit within a few percent because bIsEmpty on a real sphere field is ~1.6 µs of C++ against a ~65 ns boundary delta — the isolated per-call cost is measured by `bench/abi-call-cost.mjs`, not here.

## Appendix — TP7: post-pruning evaluation program (2026-07-18)

The TP6 re-profile (throwaway phase instrumentation on commit `80f9a68`; percentages stable
across repeats, single-variant rows) reframed where the pruned fill spends its time:

| fixture (single) |     fill | classify |  **eval** | write | merge+tiles |
| ---------------- | -------: | -------: | --------: | ----: | ----------: |
| gyroid @0.1mm    | 1,449 ms |     2.3% | **90.7%** |  6.0% |          ~0 |
| sphere @0.1mm    |   200 ms |     5.1% | **84.3%** |  8.0% |          ~0 |
| union64 @0.25mm  |   494 ms |    10.6% | **87.5%** |  1.4% |          ~0 |

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
green, so the fusion itself was correct, but slower.

Root cause: musl `sincos` returns
through memory out-params (two linear-memory stores + loads per call on wasm) and still runs
both kernels, so the one shared `__rem_pio2` it saves is eaten by the call shape; the added
per-instruction partner checks then push the balance negative even on the fixture the stage
targeted.

The implementation was verified bit-identical before removal, then reverted to the
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
fired. Identity exact, suite green: the AF1 rules were sound but useless here.

Structural
diagnosis, not an implementation artifact: the gyroid's `abs(Σ sin·cos) − 0.4` needs the
affine sum to clear **±0.7** (background 0.3 + iso offset 0.4), and the unavoidable slack —
mul cross-terms rad·rad ≈ 0.06 per product at 0.5 rad/block, plus the abs-straddle collapse
to a degenerate form — consumes the very margin correlation tracking recovers at 8³
granularity.

Reverted to the TP7b build (snapshot-restored byte-exact). Revisit only with
finer blocks or a field without an abs-threshold root.

### Program outcome (cumulative, vs TP6 `80f9a68`)

Two of four stages landed; two measured negative and were reverted with findings recorded.
Cumulative landed effect (TP6 → TP7b, back-to-back pairs): **gyroid single 1,403 → 586 ms
(2.4×) / multi 215 → 87 ms (2.5×); sphere single 193 → 94 ms (2.1×) / multi 31 → 17 ms
(1.8×); union64 single 471 → 196 ms (2.4×) / multi 70 → 29 ms (2.4×)** — on top of TP6
pruning's 1.2–13.3×, all bit-identical to the JS-callback path.

### HelixHeatX voxel sweep vs LEAP71's published table (2026-07-19)

The flagship real-world subject: the whole HelixHeatX Task
headless — geometry generation (1,197,460 lattice beams across 37 lattices; the long-standing "~10⁵" figure was an order of magnitude low, counted directly), the boolean assembly,
the full finishing family (offset/fillet/smoothen/projectZSlice), meshing and
binary-STL bytes.

LEAP71's published numbers ("on a MacBook Air", README
table.png) time the same Task INCLUDING viewer previews + screenshots, a
delta in the published numbers' favour. Apple M2 Pro, 12 threads on the multi
build; start load 4.2 (not a quiet-machine baseline — treat timings as upper
bounds).

One run per cell; integrity = single≡multi identity (volume hex, STL
FNV-1a and byte count) at every size, which held throughout — the entire
application is thread-count-deterministic. Source:
`bench/results/heatx-sweep-2026-07-18-85d283b.json`.

| voxel (mm) | single (s) | multi (s) | published (s) | STL ours (MB) | STL published (MB) |
| ---------: | ---------: | --------: | ------------: | ------------: | -----------------: |
|        1.0 |       61.8 |      38.2 |            34 |          93.7 |                 94 |
|        0.9 |       81.8 |      43.1 |             — |         122.1 |                  — |
|        0.8 |      103.9 |      49.7 |             — |         165.2 |                  — |
|        0.7 |      151.1 |      73.1 |             — |         227.1 |                  — |
|        0.6 |      262.2 |      95.0 |             — |         328.0 |                  — |
|        0.5 |      420.9 |     133.0 |            98 |         502.4 |                502 |

Readings:

- **Geometry parity (the D5 signal): STL sizes match the published table to
  0.1–0.4% at both published cells** (502.4 vs 502 MB; 93.7 vs 94 MB decimal).
  Same tri counts ⇒ same part.
- **Thread scaling grows with the workload**: 1.6× at 1.0 mm → 3.2× at 0.5 mm
  (the narrow-band work at fine voxels parallelizes; per-op overheads amortize).
- **wasm vs native**: multi lands within 1.4× of the published native-C#
  number at 0.5 mm despite the previews delta running against us.
- **Authoring is noise, confirmed at production scale**: the pure-JS
  lattice loops cost 0.4–0.8 s of 38–421 s wall — <1.5% everywhere. No batch
  promotion warranted.
- Native memory passes 1 GiB below 0.7 mm (the session-level warning fires);
  the 0.3/0.2 mm cells hit the memory ceiling (next section).

M11 (RoverWheel Wheel_02) and M12 (HelixHeatX @ 1.0 mm single/multi) join the
generated metric table on the next `pnpm run bench -- --update` run.

### Fine-voxel ceiling (0.3/0.2 mm), documented (2026-07-19)

Attempted per the memory-gated protocol (`node bench/heatx-sweep.mjs --sizes
0.3 --builds multi`): **0.3 mm does NOT complete on wasm32.** The session's
native-memory warning fires (>1 GiB) during fin/void construction, and the
run dies when a later allocation exhausts the 4 GB linear-memory ceiling —
notably during a _small_ flange-cylinder mesh build, i.e. the heap was
already consumed by long-lived intermediates (the HeatX assembly holds
fins + voids + structure grids concurrently; at 0.3 mm that is ~4.6× the
0.5 mm narrow-band footprint, plus the ~1.4 GB STL to come). 0.2 mm
(published: 1240 s / 3.4 GB STL) fails a fortiori.

Mitigation paths, not
pursued here: explicit `dispose()` of intermediates inside the subject
(against the port-fidelity goal of keeping the C# structure), a
memory64 build, or out-of-core STL streaming. The user-priority 0.5–1.0 mm
band is comfortably inside the ceiling.

(The probe also exposed that a failed wasm `_malloc` near the ceiling
surfaces as a raw `RangeError` from `HEAPF32.set` rather than the typed
`PICO_OUT_OF_MEMORY` error — hardened in the facade as a follow-up
commit.)

### SK-0.3 — lattice authoring batched: one ABI crossing per lattice (2026-07-26)

Samples: `bench/results/webgpu-v2/sk-0.3-lattice-batch.json`.

`lattice.addBeam()`/`addSphere()` stage into a flat `Float32Array` (8 f32/beam,
`(x, y, z, radius)` per endpoint — the GPU-upload layout) and cross once per lattice via
`Lattice_AddBeams`/`Lattice_AddSpheres` (`src/pico-bulk.cpp`). Public API unchanged.

|                                   | before (per-element) |          after (batched) |           Δ |
| --------------------------------- | -------------------: | -----------------------: | ----------: |
| HeatX `Lattice_AddBeam` crossings |        **1,197,460** | **37** (one per lattice) | **32,364×** |
| `lattice.addBeam()` end to end    |       50.12 ns/beam¹ |        **39.21 ns/beam** |   **1.28×** |
| HeatX `author` stage @3.0 mm      |            238.72 ms |            **150.83 ms** |  **−36.8%** |

¹ The `raw per-call (Lattice_AddBeam)` export measured in the same process — the floor the old
facade sat _on top of_ (SK-0.2 measured that facade at 131.6 ns). The batched facade is now
below the bare crossing it replaced.

Method: `bench/lattice-batch.mjs`. Per-beam rows are min-of-7 over 9×200,000-beam runs in one
process. The `author` row is a **paired ABAB ×5** against the real subject, both variants in the
same process (the "before" variant is a faithful re-creation of the replaced facade, proxied
over `createLattice`); sample ranges are **disjoint** (batched max 154.79 < per-call min 236.06)
and both variants produced an identical volume.

Crossing counts are read from wrappers installed
on the wasm exports before the raw table binds, so they are counted, not inferred.

Machine: M2
Pro, AC, `lowpowermode 0`, loadavg 2.8→7.6 (two sibling spikes sharing the box — which is why
the claim rests on the paired in-process A/B and not on a macro suite run).

A load-flagged full-suite pass (`bench/results/webgpu-v2/sk-0.3-macro-loaded.json`, kept out of
`bench/results/` so the drift canary is not polluted by its contaminated 12-thread rows) puts
`M12@single/author` at **153.382 ms** against SK-0.1's 406.692 — but that baseline is pre-SK-0.2,
so the −62% is the two spikes together; against SK-0.2's quiet 298.069 ms, SK-0.3's share is
−48.5%. Every single-thread row in that pass is within ±1%; every regressed row is a 12-thread
`M12@multi` stage with a flat single-thread twin, i.e. load, not this change.

Residual: 20.9 of the 39.2 ns/beam is C++-side ingest (`make_shared` per beam into upstream's
`std::vector<LatticeBeam::Ptr>`).
