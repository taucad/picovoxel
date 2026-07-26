# SK-0 EXIT — dual-lane exit baseline and the mimalloc fast-lane decision

**Date**: 2026-07-27 · **Branch**: `webgpu` · **Tree under test**: `84e1515`
(working tree otherwise clean apart from the three never-staged operator files:
`demo/main.ts`, `test/examples-pico.test.ts`, `examples/pico/modular-gyroid-puzzle.ts`)

**Delivers**: the committed forward denominator for SK-1…SK-3
(`sk-0-exit-baseline-dlmalloc.json`), the mimalloc fast-lane decision table, and
the SK-0 exit scorecard against the retiring SK-0.1 baseline.

**Closes**: `NON-DETERMINISM.md` §12.3's "gated only on the exit-baseline
measurement"; `WORKLOAD-EXECUTORS.md`'s "spendable pending the exit-baseline
measurement" on both the construct and the mesh-extraction rows.

## Verdict

**The mimalloc wins are real, they are larger than SK-0.1 measured, and they are
free of any byte cost. Recommendation: flip the fast lane's default to
mimalloc; leave L0/`'exact'` and the shipped single-thread default on
dlmalloc.** No default is flipped by this spike.

| | |
| --- | --- |
| HeatX multi `construct` (M12@multi) | **2.164×** faster on mimalloc, CI 2.141–2.178 |
| Byte identity, dlmalloc vs mimalloc | **identical** — 64 identity-object comparisons at 1.0 mm, plus 5 (cell, build) pairs at 1.0 / 0.5 / 0.4 mm |
| Cost, multi-thread | 2 phases of 47 regress; worst is `M10@multi/render` at 0.723× |
| Cost, single-thread | broad but small: 45 of 73 phases 0.84–0.99×, `M12@single/construct` 0.993× |
| Cost, memory | +0.71 GiB at 1.0 mm (1.80×), +0.38 GiB at 0.5 mm (1.17×), +0.42 GiB at 0.4 mm |
| OOM boundary | **0.4 mm now passes on both** (SK-0.1: failed on both). Headroom to the 4 GiB wasm32 ceiling: dlmalloc 0.66 GiB, **mimalloc 0.24 GiB** |

The one-dimensionality SK-0.1 reported is sharper now, not weaker: **44 of 47
multi-thread phases are faster and 45 of 73 single-thread phases are slower.**
That is the exact signature of removing a global free-list mutex, and it is why
the recommendation is lane-scoped rather than global.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 (macOS 26.5.2, build 25F84) / v26.5.0 |
| emcc | 5.0.1 (vendored `vendor/emsdk`) |
| Power | **AC**, `lowpowermode 0` — verified before any timed run |
| Load at block starts | a1 2.50, b1 (immediately after a1), a2 1.01, b2 (immediately after a2) |
| Harness load guard | `cores/2 = 6.0`, armed for all four blocks (no `--allow-loaded`) |
| Known resident processes | Claude Code + Claude desktop throughout; a Codex/ChatGPT process was resident during a1/b1 and gone by a2/b2 — the ABAB pairing is what absorbs this (see §2) |

SK-0.1's Low Power Mode lesson was checked first and did not recur: `pmset -g`
reported `lowpowermode 0` on AC before the first build and was re-verified during
the run.

## 1. Builds

Four artifacts from one toolchain state at `84e1515`. `-sMALLOC` is link-time
only, so no dependency rebuild was needed and **neither `scripts/fetch-deps.sh`
nor `patches/` was touched** — H1/H1b therefore did not apply and
`build/wasm-prefix*` / `build/{tbb,ovdb}-wasm*` were deliberately left in place.
H2 (refresh the gitignored `src/pico.wasm`) is satisfied: every block copies its
arm's artifacts into `src/` before running.

| artifact | dlmalloc (A) | mimalloc (B) | Δ |
| --- | ---: | ---: | ---: |
| `pico.wasm` | 5,875,598 | 5,940,852 | +65,254 |
| `pico-multi.wasm` | 5,873,395 | 5,939,181 | +65,786 |

The +65 KB matches SK-0.1's +65,222 / +65,634, and the driver refuses to run if
the two arms have equal size — a guard against measuring one artifact against
itself.

### Drift check — stronger than the charter asked for

The charter allowed a fixture-identity comparison on the assumption that links
are not byte-reproducible. They are, here:

| artifact | fresh dlmalloc build | committed / working tree | verdict |
| --- | --- | --- | --- |
| `pico.wasm` | `acb2773959ee5392…` | `acb2773959ee5392…` (working, gitignored) | **byte-identical** |
| `pico-multi.wasm` | `17ff421bce9e599e…` | `17ff421bce9e599e…` (`HEAD:src/pico-multi.wasm`) | **byte-identical** |

Zero drift, so no fixture-identity fallback was needed. `src/` was restored to
these same dlmalloc artifacts at the end of the spike and is clean against
`HEAD`.

## 2. Method

ABAB blocking, A = dlmalloc, B = mimalloc, `BENCH_REPEATS=10` (1 discarded
warmup + 10 measured per metric per block), **20 samples per side per phase**,
paired by sample index, log-ratio bootstrap CI via `bench/stats.mjs`
(`summarizePairedSamples`, 10,000 iterations). This is SK-0.1's protocol
unchanged, so the two documents' numbers are directly comparable.

```
BENCH_REPEATS=10 node bench/run.mjs                      # once per block, artifacts swapped between
node bench/merge-blocks.mjs <out> <blockA1> <blockA2>     # pool a side into one baseline record
node bench/alloc-ab.mjs a1.json,a2.json b1.json,b2.json   # paired delta table
node bench/compare-baselines.mjs <old> <new>              # unpaired cross-day scorecard
node bench/heatx-sweep.mjs --sizes 1.0,0.5 --builds single,multi   # peak heap + fine-cell identity
```

Two tools are new and committed with this spike. `bench/merge-blocks.mjs` pools
same-allocator blocks into one baseline record and **fails on identity drift
between blocks** rather than averaging it away. `bench/compare-baselines.mjs`
compares two baselines taken at different times — deliberately *not* by index
pairing, which would manufacture precision the experiment never had, but by the
ratio of medians with a conservative interval `[oldCiLow/newCiHigh,
oldCiHigh/newCiLow]` built from each side's independent bootstrap CI. It
self-checks: a file against itself gives 1.000× and zero significant phases, and
against SK-0.1's own mimalloc record it reproduces that document's headline
(1.222× vs the paired 1.208×, CI 1.159–1.268 vs 1.171–1.262 — wider, as a
conservative unpaired interval should be).

### Block-to-block drift, and one aborted block

Within the dlmalloc baseline (a1 vs a2, ~70 min apart): headline phases agree to
**≤1.6%** (`M12@multi/construct` 1.016×, `M12@single/construct` 1.000×,
`M11/construct` 1.013×), 91 of 120 phases show no measurable difference. That is
the machine drift the ABAB design absorbs.

The first b2 attempt was killed mid-block by the session harness (a background
task reaped, not a benchmark fault). Its paired a2 had started at load 5.47 while
the replacement b2 would have run at load ~0.8. **Rather than pair across that
gap, a2 and b2 were both re-run back-to-back on a quiet machine**; the orphaned
a2 was discarded from both the baseline and the delta table. Discarding it is the
conservative call — it was a valid dlmalloc block, but including it would have
put 10 of the 20 A-side samples in a different load regime from their B-side
partners, which is precisely what the blocking exists to prevent. (Its numbers
agreed with the retained a2 to within 1.6% on every headline phase, so nothing
was hidden by dropping it.)

## 3. Table 1 — the exit baseline (the L0 denominator for SK-1…SK-3)

`sk-0-exit-baseline-dlmalloc.json`, dlmalloc, 20 samples/phase, 18 metrics,
120 phases. Top-level phases only; the 45 `kernel:*` stages per HeatX metric are
in the file and in `sk-0-exit-allocator-delta.md`.

| metric | phase | median (ms) | 95% CI | MAD |
| --- | --- | ---: | :---: | ---: |
| M1 | instantiate | 8.044 | 7.634–8.575 | 0.576 |
| M2@0.5 | build | 0.893 | 0.889–0.923 | 0.008 |
| M2@0.5 | volume | 0.785 | 0.770–0.796 | 0.016 |
| M2@0.25 | build | 2.840 | 2.830–2.845 | 0.011 |
| M2@0.25 | volume | 2.859 | 2.853–2.870 | 0.011 |
| M3@0.5 | render | 15.537 | 15.482–15.611 | 0.088 |
| M3@0.5 | mesh | 10.462 | 10.413–10.608 | 0.083 |
| M3@0.25 | render | 101.773 | 101.327–101.951 | 0.417 |
| M3@0.25 | mesh | 37.798 | 37.771–38.055 | 0.111 |
| M4 | chain | 6.143 | 6.117–6.178 | 0.035 |
| M5 | offset | 222.299 | 221.079–222.573 | 1.253 |
| M5 | smoothen | 376.600 | 376.321–376.810 | 0.405 |
| M6 | bulk | 0.403 | 0.304–0.434 | 0.083 |
| M6 | perElement | 13.285 | 12.629–13.459 | 0.657 |
| M7 | import | 1.509 | 1.503–1.519 | 0.009 |
| M8 | sweep | 3.583 | 3.458–3.741 | 0.144 |
| M9 | raw10k | 14.916 | 14.901–15.018 | 0.081 |
| M9 | facade10k | 14.355 | 14.227–14.569 | 0.177 |
| M10@single | render | 49.074 | 48.981–49.181 | 0.120 |
| M10@single | mesh | 39.403 | 39.255–40.041 | 0.227 |
| M10@multi | render | 12.889 | 12.636–13.215 | 0.326 |
| M10@multi | mesh | 32.675 | 31.274–34.328 | 1.768 |
| M11 | construct | 25098.778 | 25062.946–25282.529 | 54.491 |
| M11 | mesh | 204.525 | 203.642–206.271 | 1.510 |
| M11 | stl | 187.092 | 181.325–190.677 | 11.202 |
| M12@single | construct | 39371.709 | 39353.200–39401.955 | 31.507 |
| M12@single | author | 159.043 | 155.406–160.457 | 3.347 |
| M12@single | mesh | 103.451 | 103.267–103.779 | 0.295 |
| M12@single | stl | 106.188 | 105.897–106.349 | 0.210 |
| M12@single | unattributed | 0.324 | 0.316–0.330 | 0.010 |
| M12@multi | construct | 16685.450 | 16617.433–16835.162 | 118.119 |
| M12@multi | author | 161.090 | 159.490–164.358 | 5.063 |
| M12@multi | mesh | 33.034 | 32.112–34.197 | 1.163 |
| M12@multi | stl | 110.082 | 109.840–110.377 | 0.357 |
| M12@multi | unattributed | 0.430 | 0.417–0.546 | 0.027 |
| M13 | callback | 34.842 | 34.403–35.214 | 0.429 |
| M13 | tape | 12.921 | 12.901–12.944 | 0.027 |
| M14 | gen0 | 19.724 | 19.689–19.837 | 0.081 |
| M14 | gen1 | 76.710 | 76.191–77.242 | 0.800 |
| M14 | gen2 | 3179.493 | 3149.916–3191.157 | 25.053 |

**This file replaces `sk-0.1-baseline-dlmalloc.json` as the forward denominator.**
The SK-0.1 file remains valid as a historical record and as the scorecard's
"before" column; it is not a valid comparator for SK-1…SK-3 because SK-0.2…SK-0.8
landed between them.

## 4. Table 2 — the mimalloc fast-lane decision table

Paired, 20 samples/side, log-ratio bootstrap CI. Speedup > 1 = mimalloc faster.
Full 120-phase table: `sk-0-exit-allocator-delta.md`.

### 4.1 Headline phases (the chartered set: M12 single+multi, M10, M11, M5, M3)

| metric | phase | dlmalloc (ms) | mimalloc (ms) | Δ% | speedup | 95% CI | verdict |
| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |
| M12@multi | **construct** | 16685.450 | 7754.408 | −53.5% | **2.164×** | 2.141–2.178 | faster |
| M12@multi | mesh | 33.034 | 16.604 | −49.7% | **1.992×** | 1.927–2.041 | faster |
| M12@multi | author | 161.090 | 156.725 | −2.7% | 1.024× | 1.016–1.062 | faster |
| M12@multi | stl | 110.082 | 111.951 | +1.7% | 0.981× | 0.975–0.987 | regression |
| M10@multi | mesh | 32.675 | 14.204 | −56.5% | **2.270×** | 2.194–2.407 | faster |
| M10@multi | render | 12.889 | 17.913 | +39.0% | **0.723×** | 0.707–0.931 | **REGRESSION** |
| M12@single | construct | 39371.709 | 39665.925 | +0.7% | 0.993× | 0.991–0.993 | regression |
| M12@single | mesh | 103.451 | 105.036 | +1.5% | 0.983× | 0.982–0.988 | regression |
| M12@single | stl | 106.188 | 107.546 | +1.3% | 0.986× | 0.983–0.989 | regression |
| M12@single | author | 159.043 | 154.429 | −2.9% | 1.016× | 0.996–1.048 | no effect |
| M10@single | render | 49.074 | 49.450 | +0.8% | 0.999× | 0.982–1.002 | no effect |
| M10@single | mesh | 39.403 | 39.975 | +1.5% | 0.997× | 0.977–1.005 | no effect |
| M11 | construct | 25098.778 | 25234.331 | +0.5% | 0.996× | 0.995–0.997 | regression |
| M11 | mesh | 204.525 | 203.603 | −0.5% | 1.003× | 0.998–1.010 | no effect |
| M11 | stl | 187.092 | 191.227 | +2.2% | 0.996× | 0.978–1.035 | no effect |
| M5 | offset | 222.299 | 227.935 | +2.5% | 0.982× | 0.960–0.992 | regression |
| M5 | smoothen | 376.600 | 382.057 | +1.4% | 0.987× | 0.970–0.994 | regression |
| M3@0.5 | render | 15.537 | 15.991 | +2.9% | 0.971× | 0.969–0.974 | regression |
| M3@0.5 | mesh | 10.462 | 10.778 | +3.0% | 0.974× | 0.968–0.980 | regression |
| M3@0.25 | render | 101.773 | 104.930 | +3.1% | 0.977× | 0.946–0.992 | regression |
| M3@0.25 | mesh | 37.798 | 39.493 | +4.5% | 0.977× | 0.940–0.989 | regression |

**120 phases: 49 faster, 47 regressions, 24 no measurable effect** — but that
aggregate is meaningless without the lane split:

| lane | phases | faster | regressions | no effect |
| --- | ---: | ---: | ---: | ---: |
| multi-thread metrics | 47 | **44** | 2 | 1 |
| single-thread / non-threaded | 73 | 5 | 45 | 23 |

### 4.2 HeatX multi creation-stage decomposition

Every large `M12@multi` kernel stage improves, and **no `M12@multi` kernel stage
regresses**. A representative slice:

| stage (M12@multi) | dlmalloc (ms) | mimalloc (ms) | speedup | 95% CI |
| --- | ---: | ---: | ---: | :---: |
| `kernel:cool-fluid-void.subtract` | 10.012 | 1.911 | **5.917×** | 5.125–5.990 |
| `kernel:result.union-fins` | 12.737 | 2.223 | 5.602× | 4.025–6.561 |
| `kernel:inner-volume.union` | 10.358 | 1.889 | 5.547× | 5.367–6.095 |
| `kernel:result.intersect-bounding` | 14.093 | 2.855 | 5.502× | 4.021–6.521 |
| `kernel:result.subtract-inner-volume` | 12.460 | 2.192 | 5.438× | 4.794–6.065 |
| `kernel:hot-fluid-void.subtract` | 10.407 | 1.926 | 5.177× | 4.772–5.673 |
| `kernel:turning-fins.cool` | 1168.312 | 230.371 | **5.078×** | 4.933–5.149 |
| `kernel:straight-fins.hot` | 352.568 | 68.499 | 5.073× | 4.955–5.241 |
| `kernel:outer-volume.union-supports` | 8.413 | 1.679 | 5.070× | 4.751–5.655 |
| `kernel:corner-fins.union` | 6.967 | 1.446 | 4.989× | 4.480–5.677 |
| `kernel:io-threads.create` ¹ | 6441.633 | 1369.095 | **4.729×** | 4.696–4.982 |

¹ ranked 11th by ratio but **first by absolute saving**: 5.07 s of the 8.93 s
mimalloc removes from multi construct — 57% of the whole fast-lane win — comes
from this one stage. SK-0.1 measured 4.581× on it; the effect is stable across
the entire program.

**Why the win grew from SK-0.1's 1.208× to 2.164×.** SK-0.1 measured a tree
whose largest HeatX stages — `turning-fins` and `helical-void`,
`Voxels_RenderLattice` — were *serial*, and it correctly reported them at
0.99–1.00× through a 12-thread allocator swap. SK-0.4 then moved that lane to a
parallel tube complex. Those stages are now multithreaded and allocation-heavy,
so they are exactly the code dlmalloc's global free-list mutex serializes:
`turning-fins.cool` goes 1168 → 230 ms here, having been allocator-insensitive
before. **SK-0.4 did not just deliver its own win — it converted the largest
remaining serial stages into stages mimalloc can accelerate.** The two spikes
compound rather than overlap.

### 4.3 The costs, stated plainly

| cost | magnitude | reading |
| --- | --- | --- |
| `M10@multi/render` | **0.723×** (12.9 → 17.9 ms), CI 0.707–0.931 | The only material MT regression. M10 constructs a **fresh multi session per repeat**, so this phase carries thread-pool spin-up and mimalloc's first-touch segment reservation. It is a per-session fixed cost, not a per-operation one — M10@multi/mesh in the same metric gains 2.270×, and the metric nets out faster. |
| single-thread booleans | 0.840–0.894× on `result.union-threads`, `result.subtract-io-cuts`, `corner-fins.union` | Same five-ish sub-10 ms stages SK-0.1 recorded, same explanation: mimalloc's per-allocation bookkeeping is not amortized at that size. Recorded as findings, not failures. |
| single-thread broadly | 0.97–0.99× across M3, M5, M12@single | Small, consistent, and the direct argument for scoping the flip to the MT fast lane rather than making it global. |
| memory | +1.80× at 1.0 mm, +1.17× at 0.5 mm, +0.42 GiB at 0.4 mm | Largely fixed overhead (segment cache), so the ratio shrinks as real data grows — same shape SK-0.1 found, at lower absolute values. |
| ceiling headroom | dlmalloc 0.66 GiB vs **mimalloc 0.24 GiB** at 0.4 mm | The real bound. mimalloc will reach the 4 GiB wasm32 ceiling one cell before dlmalloc. |

### 4.4 Peak heap, wall clock and the OOM boundary

One run per cell (the sweep's own repeat policy). Timing here is indicative —
the repeated, CI-bearing timings are §4.1. Heap is not load-sensitive.

| voxel (mm) | build | dl task (s) | mi task (s) | speedup | dl heap (GiB) | mi heap (GiB) | heap ratio | identity |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1.0 | single | 39.3 | 39.4 | 0.997× | 0.86 | 1.57 | 1.83× | **identical** |
| 1.0 | multi | 16.7 | 7.8 | 2.155× | 0.87 | 1.57 | 1.80× | **identical** |
| 0.5 | single | 242.6 | 243.4 | 0.996× | 2.16 | 2.49 | 1.15× | **identical** |
| 0.5 | multi | 45.7 | 32.9 | 1.389× | 2.18 | 2.56 | 1.17× | **identical** |
| 0.4 | multi | 77.0 | 60.1 | — ¹ | 3.34 | 3.76 | 1.13× | **identical** |

¹ the 0.4 mm mimalloc probe started at load 11.62 (the dlmalloc arm's threads
still winding down), so its wall is not comparable; it is recorded for heap and
identity only.

Two results here are new, and neither was chartered:

- **The multi win decays as the grid refines** — 2.155× at 1.0 mm to 1.389× at
  0.5 mm. Same direction SK-0.1 found (1.204× → 1.103×), same cause: finer grids
  spend proportionally more of the wall in work the allocator cannot touch.
  **Quote the win with its voxel size attached.**
- **The OOM boundary moved a full voxel size.** SK-0.1 recorded 0.4 mm failing on
  *both* allocators with `RangeError: offset is out of bounds`. It now **passes on
  both** — 16,511,132 triangles, 825.6 MB of STL, byte-identical across
  allocators. Peak heap at 0.5 mm has fallen from SK-0.1's 2.59 / 3.25–3.50 GiB to
  2.16–2.18 / 2.49–2.56 GiB, which is what bought the extra cell. This tightens
  R12 in the other direction: the first failing cell is now finer than 0.4 mm and
  has not been located.

For scale: dlmalloc multi at 0.5 mm is **45.7 s against LEAP71's published 98 s**
native figure, and mimalloc multi is **32.9 s** — the wasm build is now ~2.1×
and ~3.0× faster than the published native number on this fixture.

## 5. Table 3 — the SK-0 exit scorecard (what SK-0.2…SK-0.8 + SK-0.10 delivered)

dlmalloc both sides: `sk-0.1-baseline-dlmalloc.json` (2026-07-25, 20 samples) vs
`sk-0-exit-baseline-dlmalloc.json` (today, 20 samples). Unpaired cross-day
comparison with the conservative interval of §2. Full 120-phase table:
`sk-0-exit-scorecard.md`.

**88 phases faster, 4 regressions, 28 no measurable effect.**

### 5.1 Top-level phases

| metric | phase | SK-0.1 (ms) | exit (ms) | Δ% | speedup | 95% CI |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| M12@multi | author | 458.735 | 161.090 | −64.9% | **2.848×** | 2.762–2.902 |
| M12@single | author | 406.692 | 159.043 | −60.9% | 2.557× | 2.506–2.626 |
| M12@multi | **construct** | 34664.796 | 16685.450 | −51.9% | **2.078×** | 2.038–2.097 |
| M14 | gen2 | 5774.498 | 3179.493 | −44.9% | 1.816× | 1.803–1.838 |
| M14 | gen1 | 133.064 | 76.710 | −42.4% | 1.735× | 1.719–1.758 |
| M12@multi | mesh | 56.446 | 33.034 | −41.5% | 1.709× | 1.621–1.775 |
| M12@single | **construct** | 55259.545 | 39371.709 | −28.8% | **1.404×** | 1.397–1.415 |
| M10@multi | mesh | 44.080 | 32.675 | −25.9% | 1.349× | 1.221–1.466 |
| M12@single | mesh | 127.976 | 103.451 | −19.2% | 1.237× | 1.225–1.254 |
| M3@0.25 | mesh | 46.807 | 37.798 | −19.2% | 1.238× | 1.177–1.258 |
| M11 | mesh | 250.866 | 204.525 | −18.5% | 1.227× | 1.163–1.288 |
| M6 | perElement | 15.373 | 13.285 | −13.6% | 1.157× | 1.138–1.254 |
| M9 | facade10k | 15.673 | 14.355 | −8.4% | 1.092× | 1.052–1.136 |
| M11 | construct | 26195.151 | 25098.778 | −4.2% | 1.044× | 1.002–1.079 |
| M13 | tape | 13.070 | 12.921 | −1.1% | 1.012× | 1.008–1.018 |
| M14 | **gen0** | 4.598 | 19.724 | **+329.0%** | **0.233×** | 0.231–0.234 |

### 5.2 HeatX multi creation stages — where the program's wall went

| stage (M12@multi) | SK-0.1 (ms) | exit (ms) | speedup |
| --- | ---: | ---: | ---: |
| `kernel:io-supports.create` | 175.651 | 9.412 | **18.662×** |
| `kernel:helical-void.cool` | 5179.769 | 300.995 | **17.209×** |
| `kernel:helical-void.hot` | 5190.923 | 301.713 | **17.205×** |
| `kernel:straight-fins.cool` | 1241.981 | 350.090 | 3.548× |
| `kernel:straight-fins.hot` | 1238.182 | 352.568 | 3.512× |
| `kernel:turning-fins.hot` | 3803.266 | 1143.526 | 3.326× |
| `kernel:turning-fins.cool` | 3800.351 | 1168.312 | 3.253× |
| `kernel:outer-volume.subtract-print-web` | 11.224 | 5.925 | 1.894× |
| `kernel:flange.create` | 2549.374 | 2489.224 | 1.024× |
| `kernel:io-threads.create` | 6333.669 | 6441.633 | **0.983×** |
| `kernel:print-web.create` | 3.032 | 4.277 | **0.709×** |

`io-threads.create` is now the largest single HeatX multi stage at 6.44 s of a
16.69 s construct — **38.6% of the wall in one stage**, and the largest stage the
program did not move on dlmalloc (0.983×, i.e. unchanged since SK-0.1).

**But it is not an SK-1 target, because the allocator already fixes it.** On
mimalloc the same stage runs in **1.369 s — 4.729×, CI 4.696–4.982** (SK-0.1
measured 4.581× on the same stage, so this is stable across the whole program).
That single stage supplies **5.07 s of the 8.93 s** that mimalloc takes off
multi construct — **57% of the entire fast-lane win**. `io-threads.create` is a
dlmalloc-free-list-mutex stage and always was; the program never touched it, and
it does not need to.

### 5.3 The four regressions, and what they share

| metric/phase | speedup | absolute |
| --- | ---: | --- |
| `M14/gen0` | 0.233× | 4.6 → 19.7 ms |
| `M12@single/kernel:print-web.create` | 0.388× | 2.9 → 7.3 ms |
| `M12@multi/kernel:print-web.create` | 0.709× | 3.0 → 4.3 ms |
| `M12@multi/kernel:io-threads.create` | 0.983× | 6333.7 → 6441.6 ms |

**Three of the four are the same defect, and it is a real one.** `print-web` is a
**14-beam** lattice (`examples/helixheatx/helixHeatX.ts:565`) and M14 `gen0` is
the smallest quasicrystal wireframe; both are tiny `lattice.toVoxels()` calls.
SK-0.4's tube-complex lane carries a **fixed setup cost** (spatial bucketing,
`parallel_deterministic_reduce` split-tree construction) that is free at 10⁵
beams and dominant at 14. The same lane change that bought 17× on `helical-void`
costs 4.3× on `gen0`. The crossover point is unmeasured, and there is no
small-input fallback to the old serial path even though that path still exists
behind `PICOVOXEL_SERIAL_LATTICE=1`. Filed as a follow-up; it does not block
this baseline, and the absolute cost is ~15 ms per affected call.

`io-threads.create` at 0.983× is 1.7% and within the drift band of §2; it is
reported for completeness rather than as a finding.

## 6. Byte-identity verdict

**PASS — no divergence anywhere. This is a clean STOP-gate result.**

| check | coverage | result |
| --- | --- | --- |
| Within-block identity stability | harness-enforced, 10 repeats × 18 metrics × 4 blocks | no drift (the harness exits on any) |
| Across dlmalloc blocks (a1 vs a2) | `merge-blocks.mjs`, 16 identity objects | identical |
| Across mimalloc blocks (b1 vs b2) | `merge-blocks.mjs`, 16 identity objects | identical |
| **dlmalloc vs mimalloc, all four blocks** | **64 identity-object comparisons** | **identical** |
| Fine-cell cross-allocator, 1.0 / 0.5 / 0.4 mm | 5 (cell, build) pairs: volume hex, STL FNV, STL bytes, triangle count | **identical** |
| single ≡ multi within each allocator | sweep oracle, 1.0 and 0.5 mm, both arms | **identical** |

Identity objects carry volume hex, STL FNV-1a, STL byte count, triangle count,
vertex-array hash and thread count depending on the metric. The 0.5 mm values
reproduce SK-0.10's references exactly: 10,047,988 triangles, volume hex
`4121d9c600000000`.

**SK-0.1's blocker is gone and stays gone.** That document recorded three
mimalloc multi runs producing three different STL byte streams at 0.5 mm. The
cause was never the allocator — SK-0.10 rooted it in a signed heap-view shift in
`src/mesh.ts` — and with that fixed, 40 measured repeats per allocator across
four blocks plus five fine-cell pairs produce no divergence at all.

## 7. Recommendation

**Flip the fast lane's default to `MALLOC=mimalloc`. Do not flip the global or
the L0/`'exact'` default. Not applied by this spike.**

The case:

1. **The win is large, MT-scoped and byte-free.** 2.164× on HeatX multi
   construct with a CI of 2.141–2.178, 1.992× on multi mesh extraction, ~5× on
   most multi creation stages, and zero identity divergence in 64 comparisons
   plus five fine-cell pairs. `NON-DETERMINISM.md` §14.1 already defines the fast
   lane as "`'fast'` = F: mimalloc MT artifact"; this measurement is the evidence
   that definition was waiting on.
2. **The costs are real, small, and land on the other lane.** 45 of 73
   single-thread phases regress 0.84–0.99×. That is an argument for lane scoping,
   not against mimalloc — and L0/`'exact'` staying dlmalloc leaves the byte-locked
   oracle lane on the allocator every pin was taken under.
3. **The one genuine reservation is memory headroom, and it is bounded.**
   mimalloc's +0.42 GiB at 0.4 mm leaves 0.24 GiB to the wasm32 ceiling against
   dlmalloc's 0.66 GiB. It does not cost a voxel size today (0.4 mm passes on
   both) but it will reach the ceiling first. The fast lane should therefore
   carry a documented "coarser OOM boundary than L0" note, and the first failing
   cell should be located on both allocators before the fast lane is offered for
   fine-cell work.
4. **`M10@multi/render` at 0.723× is a per-session cost, not a per-op one**, and
   is disclosed rather than netted out. Workloads that create many short-lived
   multi sessions are the one MT shape that does not benefit.

Deliberately **not** recommended: making mimalloc the global default (the
single-thread evidence is against it), and regenerating any byte pin (nothing
moved — that is the point).

## 8. Files

All under `bench/results/webgpu-v2/`.

| file | what |
| --- | --- |
| `sk-0-exit-baseline-dlmalloc.json` | **the forward denominator for SK-1…SK-3** — dlmalloc, 20 samples/phase |
| `sk-0-exit-mimalloc.json` | the mimalloc arm, same shape |
| `sk-0-exit-block-{a1,a2}.json` | dlmalloc blocks (A), 10 repeats each |
| `sk-0-exit-block-{b1,b2}.json` | mimalloc blocks (B), 10 repeats each |
| `sk-0-exit-allocator-delta.md` | full 120-phase paired delta table |
| `sk-0-exit-scorecard.md` | full 120-phase scorecard vs `sk-0.1-baseline-dlmalloc.json` |
| `sk-0-exit-sweep-{dlmalloc,mimalloc}.json` | peak heap + identity, 1.0 and 0.5 mm, both builds |
| `sk-0-exit-oom-0.4-{dlmalloc,mimalloc}.json` | the 0.4 mm boundary probe |

Tooling committed with this spike: `bench/merge-blocks.mjs`,
`bench/compare-baselines.mjs`.

```
6ff4acda553c56802a726c9044b6b332b11e210369f1c25d30dc51a3de2407e1  sk-0-exit-allocator-delta.md
7f7e0894a907565be7b0f40d4d9e750267cbe2f437f716e915e50e5f12cae8cf  sk-0-exit-baseline-dlmalloc.json
fc2d1d56ecdf42b1d52425ae1040ad75c218e5691c8eb4685f90f1fb8714db1b  sk-0-exit-block-a1.json
e8424661354ae0ebec26c761094a68e10e06a312e94bc0541ec3c4dc848926d3  sk-0-exit-block-a2.json
6873e3eb430a07ddc80882fce76fbc4c016937b06162ff1a8e99a6ad752de79d  sk-0-exit-block-b1.json
99bbefac868e56e1c94ca3de6776f2efb3e7b7764e76e12359e5cdcf97cffceb  sk-0-exit-block-b2.json
2ee893c2a2673bb12ca3c3ac6bbc73164a8bda92f4fc1e1b8a3869a7d9e87a7a  sk-0-exit-mimalloc.json
02383e8b69bfd432492cbf6bd69b77c6bd4e37e1cde7893978af18fcb107b71d  sk-0-exit-oom-0.4-dlmalloc.json
25b927fe8322ce4c4bd98e467082e1d37bc1a5a45c22f8263f8f186433771459  sk-0-exit-oom-0.4-mimalloc.json
c4bfed5942487f3d144f1837e0a199b8abc095b641c2769c3065294c9849d06f  sk-0-exit-scorecard.md
5763babbe69851c76e55fb1fbe19dd25f27393c93038ee64d30274f367f5ef44  sk-0-exit-sweep-dlmalloc.json
1aaa9bea7a9894c30fd405403ef019e1eafd9e6d873b14458a0a1e43a130a949  sk-0-exit-sweep-mimalloc.json
```

Reproduce the two tables with:

```
node bench/alloc-ab.mjs sk-0-exit-block-a1.json,sk-0-exit-block-a2.json \
                        sk-0-exit-block-b1.json,sk-0-exit-block-b2.json
node bench/compare-baselines.mjs sk-0.1-baseline-dlmalloc.json sk-0-exit-baseline-dlmalloc.json --all
```

## 9. Open items handed forward

1. **`io-threads.create` is 38.6% of the HeatX multi wall on dlmalloc** (6.44 s of
   16.69 s) and the program never moved it — but mimalloc takes it to 1.37 s
   (4.729×), which is 57% of the fast-lane win. So it is a **top L0 target and a
   solved fast-lane one**: worth attacking only for the exact lane, or as
   evidence that the remaining L0 wall is allocator-shaped rather than
   algorithm-shaped.
2. **The small-lattice regression** (§5.3): SK-0.4's tube lane inverts below some
   beam count. Locate the crossover; a size-gated fallback to the serial lane is
   the obvious fix and the lane still exists.
3. **The OOM boundary is now finer than 0.4 mm and unlocated**, on both
   allocators. R12 should be re-tightened once it is found, and the fast lane's
   coarser boundary quantified.
4. **`M10@multi/render` 0.723×** — confirm it is session setup (thread pool +
   first-touch segments) rather than tape rendering, by timing a warm session.
