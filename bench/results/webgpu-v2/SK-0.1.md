# SK-0.1 — allocator A/B (`-sMALLOC=mimalloc`) and bench re-baselining

**Date**: 2026-07-26 · **Branch**: `webgpu` · **Bench commit**: `427a1f1`

## Verdict

**mimalloc is a NO-GO as the build default.** It buys a real, well-bounded win on
multithreaded creation paths (HeatX `construct` **1.208×**, CI 1.171–1.262), and it costs
byte reproducibility: at 0.5 mm the mimalloc multi build produced **three different STL byte
streams in three runs** from identical geometry. The L0 CPU-strict oracle is the foundation
every later spike rests on, so a determinism break outranks a 20% win. `-sMALLOC` is now a
build-script knob (`MALLOC=`, default `dlmalloc`); the flag is not set in any default path.

**Baselines committed here are dlmalloc-denominated.** SK-1…SK-3 compare against
`sk-0.1-baseline-dlmalloc.json`, not the 2026-07-23 file.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 (macOS 26.5.2, build 25F84) / v26.5.0 |
| Power | **AC**, `lowpowermode 0` |
| Load at A-block starts | 4.43, 2.05 (harness ceiling = cores/2 = 6, guard armed throughout) |
| Known resident process | Codex (operator-required); ABAB blocking absorbs its scatter |

### Low-power-mode contamination (found and cleared before any baseline)

The session opened on battery with `lowpowermode 1`. On **byte-identical** wasm, node and
machine, six independent phases ran **1.21–1.24× slower** than the 2026-07-23 baseline — a
tight band across unrelated phases, which is a uniform clock cap, not load scatter (load was
*lower* than the baseline run's). No baseline was taken until AC power was restored, after
which the same probe returned **0.99–1.04×**. Had this gone unnoticed, every SK-1…SK-3 spike
measured on AC would have booked a free ~1.2×.

## Builds

Four artifacts from one toolchain state (emcc 5.0.1); the allocator flag is the only delta.
`-sMALLOC` is link-time only — the dep archives bind `malloc`/`free` at link, so no dep
rebuild is needed for the A/B. The serial dep prefix (`build/wasm-prefix`) was rebuilt for
this spike; only the `-mt` prefix existed.

| artifact | dlmalloc (A) | mimalloc (B) | Δ |
| --- | ---: | ---: | ---: |
| `pico.wasm` | 5,835,150 | 5,900,372 | +65,222 |
| `pico-multi.wasm` | 5,812,981 | 5,878,615 | +65,634 |

### Drift check — fresh A vs the shipped 2026-07-20 artifact

Fresh A differs from shipped by **+17 bytes** (`pico.wasm`) and **+16 bytes**
(`pico-multi.wasm`), but is **output-identical**: HeatX single, HeatX multi and RoverWheel
all produced matching STL SHA-256, volume hex, triangle count and byte count. No semantic
toolchain drift since 2026-07-20; the A/B is internally valid and comparable to history.

## Allocator delta — headline phases

ABAB blocking (A₁B₁A₂B₂), 10 repeats per block, **20 samples per side**, paired by sample
index, log-ratio bootstrap CI (`bench/stats.mjs`). Full 120-phase table:
`sk-0.1-allocator-delta.md`. Speedup >1 = mimalloc faster.

| metric | phase | dlmalloc (ms) | mimalloc (ms) | Δ% | speedup | 95% CI | verdict |
| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |
| M12@multi | construct | 34664.796 | 28367.272 | −18.2% | **1.208×** | 1.171–1.262 | faster |
| M12@multi | mesh | 56.446 | 37.817 | −33.0% | 1.475× | 1.395–1.574 | faster |
| M10@multi | mesh | 44.080 | 21.142 | −52.0% | **1.998×** | 1.939–2.117 | faster |
| M10@multi | render | 12.813 | 10.800 | −15.7% | 1.129× | 1.094–1.246 | faster |
| M12@single | construct | 55259.545 | 55742.461 | +0.9% | 0.991× | 0.974–1.024 | no effect |
| M11 | construct | 26195.151 | 25500.430 | −2.7% | 1.028× | 0.993–1.063 | no effect |
| M6 | perElement | 15.373 | 14.448 | −6.0% | 1.090× | 1.081–1.097 | faster |
| M3@0.25 | mesh | 46.807 | 44.252 | −5.5% | 1.054× | 1.002–1.073 | faster |
| M13 | tape | 13.070 | 13.300 | +1.8% | 0.982× | 0.969–1.002 | no effect |
| M14 | gen2 | 5774.498 | 5894.861 | +2.1% | 0.981× | 0.938–1.015 | no effect |

**120 phases: 43 faster, 5 regressions, 72 no measurable effect.**

The result is one-dimensional: **the win is entirely on multithreaded paths.** Every
single-thread row is flat within CI. That is exactly the shape dlmalloc's global free-list
mutex predicts — with one thread there is no contention to remove.

### Regressions (all single-thread, all small boolean stages)

| metric | phase | speedup | Δ% |
| --- | --- | ---: | ---: |
| M12@single | `kernel:result.subtract-io-cuts` | 0.827× | +21.8% |
| M12@single | `kernel:result.union-threads` | 0.920× | +10.6% |
| M12@single | `kernel:corner-fins.union` | 0.926× | +10.5% |
| M12@single | `kernel:cool-fluid-void.subtract` | 0.933× | +6.6% |
| M12@single | `kernel:hot-fluid-void.subtract` | 0.943× | +9.1% |

All five are sub-10 ms stages where mimalloc's per-allocation bookkeeping is not amortized.
Recorded as findings, not failures.

## HeatX creation-stage decomposition

Stage instrumentation already existed (`kernel:*` phases, ~45 stages) — none was added.
Creation stages are **33.2 s of 35.5 s (94%)** of multi construct and 45.5 s of 57.5 s (79%)
of single.

| stage (M12@multi) | dlmalloc (ms) | mimalloc (ms) | speedup | 95% CI |
| --- | ---: | ---: | ---: | :---: |
| `kernel:result.intersect-bounding` | 14.758 | 2.961 | **5.282×** | 3.937–6.617 |
| `kernel:io-threads.create` | 6333.669 | 1388.246 | **4.581×** | 4.277–4.900 |
| `kernel:result.union-threads` | 7.655 | 1.781 | 3.998× | 3.255–5.197 |
| `kernel:result.subtract-io-cuts` | 6.419 | 1.450 | 3.788× | 3.671–5.471 |
| `kernel:io-cuts.create` | 36.454 | 22.317 | 1.621× | 1.552–1.724 |
| `kernel:cool-inner.offset` | 145.311 | 126.090 | 1.139× | 1.039–1.215 |
| `kernel:outer-structure.create` | 2236.334 | 1979.177 | 1.128× | 1.051–1.196 |
| `kernel:turning-fins.hot` | 3803.266 | 3815.970 | 1.004× | 0.970–1.024 |
| `kernel:helical-void.hot` | 5190.923 | 5179.336 | 0.994× | 0.966–1.025 |

`io-threads.create` alone supplies ~4.9 s of the 6.3 s construct saving.

**Corroborating result for the executor ledger**: the two largest stages —
`turning-fins` (3.8 s) and `helical-void` (5.2 s) — sat at **0.99–1.00×** through a
12-thread allocator swap. Those are the `Voxels_RenderLattice` stages, marked `ST` in
`WORKLOAD-EXECUTORS.md`. Allocator-insensitivity under 12 threads is what a genuinely
serial stage looks like, so this independently confirms the ledger's top serial wall and
leaves U5 / W1.2 T4 unchanged in priority.

## Voxel sweep, peak heap and the OOM boundary

Peak heap is now recorded by the sweep (`peakHeapBytes`). wasm linear memory never shrinks,
so its size at end of task **is** the run's peak.

| voxel (mm) | build | dlmalloc (s) | mimalloc (s) | speedup | dlmalloc heap (GiB) | mimalloc heap (GiB) | heap ratio |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | single | 55.2 | 55.8 | 0.989× | 0.87 | 1.57 | 1.81× |
| 1.0 | multi | 34.9 | 29.0 | 1.204× | 0.87 | 1.57 | 1.81× |
| 0.9 | single | 71.6 | 72.1 | 0.993× | 0.97 | 1.57 | 1.62× |
| 0.9 | multi | 38.6 | 32.3 | 1.196× | 0.97 | 1.64 | 1.69× |
| 0.8 | single | 90.9 | 91.3 | 0.996× | 1.07 | 1.61 | 1.50× |
| 0.8 | multi | 44.1 | 37.5 | 1.177× | 1.07 | 1.60 | 1.49× |
| 0.7 | single | 125.8 | 125.1 | 1.005× | 1.49 | 1.95 | 1.31× |
| 0.7 | multi | 54.4 | 47.4 | 1.147× | 1.49 | 1.95 | 1.31× |
| 0.6 | single | 183.8 | 183.0 | 1.004× | 1.67 | 2.23 | 1.33× |
| 0.6 | multi | 70.5 | 62.7 | 1.125× | 1.68 | 2.23 | 1.33× |
| 0.5 | single | 291.5 | 290.6 | 1.003× | 2.59 | 3.25 | 1.26× |
| 0.5 | multi | 98.3 | 89.1 | 1.103× | 2.59 | 3.50 | 1.35× |

Readings:

- **The multi win decays as the grid refines**: 1.204× at 1.0 mm → 1.103× at 0.5 mm. Finer
  grids spend proportionally more time in the serial lattice stages, which the allocator
  cannot touch. Quote the win with its voxel size attached.
- **The memory overhead is largely fixed, not proportional**: 1.81× at 1.0 mm falls to
  1.26–1.35× at 0.5 mm as real data grows against a roughly constant segment-cache cost.
- **STL parity holds**: 502.4 MB at 0.5 mm and 93.7 MB at 1.0 mm on both allocators, matching
  LEAP71's published 502 / 94 MB.
- dlmalloc multi at 0.5 mm is **98.3 s vs the published 98 s** native-C# figure.

### OOM boundary (B6)

| voxel (mm) | dlmalloc | mimalloc |
| ---: | --- | --- |
| 0.5 | passes, 2.59 GiB | passes, 3.25–3.50 GiB |
| 0.4 | **fails** — `RangeError: offset is out of bounds` | **fails** — same signature |

**The boundary did not move.** Both allocators clear 0.5 mm and both fail at 0.4 mm, with
the raw-`RangeError` OOM signature R12 documented. mimalloc's extra 0.9 GiB at 0.5 mm was
not enough to cross the 4 GB wasm32 ceiling one step early. This also **tightens R12**,
which recorded 0.3 mm as the first failure: 0.4 mm already fails, on both allocators.

Side effect worth noting: mimalloc's 1.57 GiB at 1.0 mm trips the session's 1 GiB
`memoryWarningBytes` notice at a voxel size where dlmalloc (0.87 GiB) stays quiet.

## The blocker — determinism break at 0.5 mm

The sweep's own single≡multi integrity oracle failed on the mimalloc build at 0.5 mm, and
re-probing showed the multi build is nondeterministic **run to run**:

| build | allocator | `stlFnv` @0.5 mm | runs |
| --- | --- | --- | --- |
| single | dlmalloc | `38cad381` | 2/2 stable |
| multi | dlmalloc | `38cad381` | 2/2 stable, **≡ single** |
| single | mimalloc | `e344bfe1` | 2/2 stable, **≠ dlmalloc** |
| multi | mimalloc | `6c528980`, `cfa0069c`, `951774e1` | **3 runs, 3 values** |

Across every one of those runs the geometry is invariant — volume hex `4121d9c600000000`,
10,048,032 triangles, 502,401,684 STL bytes. Identical mesh, **different byte order**. The
consistent reading is that mimalloc changes allocation addresses, which changes leaf
iteration order in mesh extraction, which changes triangle emission order; under 12 threads
that ordering stops being reproducible at all.

Scale-dependent: at 1.0 mm all three builds (shipped, dlmalloc, mimalloc) are byte-identical,
confirmed by SHA-256 on full STL streams and by all 18 bench metrics agreeing on identity
across both sides. The committed fixtures pin 1.0 mm, so **the test suite cannot see this** —
the sweep's cross-build oracle is what caught it. No pins were regenerated.

## Gate results

| assertion | result |
| --- | --- |
| New baselines committed with checksums | **pass** — this directory |
| Delta table covers every fixture + HeatX stages | **pass** — 120 phases |
| OOM / peak-heap boundary re-located | **pass** — unmoved at 0.5/0.4 mm; R12 tightened |
| Full suite green on the mimalloc build | **pass** — 49 files, 453 tests, 100% |
| Byte-locked fixtures identical A vs B | **pass at pinned scale (1.0 mm)**; **FAIL at 0.5 mm** |
| mimalloc as default only if all hold | **NOT APPLIED** — default stays `dlmalloc` |

## If mimalloc is revisited

The win is real and the mechanism is understood; the blocker is ordering, not correctness.
Paths worth measuring before adopting it: pin mesh-extraction output order independently of
allocation order (which would make the L0 oracle robust to *any* allocator and is worth
doing on its own merits); or scope mimalloc to the single-thread build, where it is flat —
i.e. no reason to. Do not adopt on the strength of the 1.208× alone.

## Files and checksums

Regenerate the delta table with:

```
node bench/alloc-ab.mjs sk-0.1-block-a1.json,sk-0.1-block-a2.json \
                        sk-0.1-block-b1.json,sk-0.1-block-b2.json
```

```
d713027286809f604346e4a991177272ccdaa00cb0803db04459d6c38043a099  sk-0.1-allocator-delta.md
f507315ae4750a27cf2b29f360b77a3eb34161f57b3e54562aee21c5ff8db5d2  sk-0.1-baseline-dlmalloc.json
9d049c16ad24f9eb1306bfd8cda7739db12665892d1f3046870d5c3b40d41b4d  sk-0.1-block-a1.json
6d2ea1ae3230272f377553eb8047938d38c69ffc1b0865a2aa44cb41e8414703  sk-0.1-block-a2.json
70a9a70ade8f39923cff37b4cad501efb28f988beffa4bbe7ee944d299e61391  sk-0.1-block-b1.json
2f37661e89b34b97110a1690b7478c56b59ebc2fec21e690ad0a6ce5c51153bc  sk-0.1-block-b2.json
f27406dc628afd2e831d8477a63185187303829d6226d858fad31e00710a0a0f  sk-0.1-heatx-sweep-dlmalloc.json
9bcd27c52f85e8da2d4b82425e232d3cd594b3f7c71ac1ef0f6e81f52d989588  sk-0.1-mimalloc.json
```
