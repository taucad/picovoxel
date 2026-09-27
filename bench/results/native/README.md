# Native PicoGK HelixHeatX — same-machine reference sweep

**2026-08-09 · 30 runs · uncommitted**

Why this exists: every wasm-vs-native statement in this repo (`BENCHMARKS.md`
§R11, `docs/research/picogk-*`) leaned on LEAP 71's **published** table
(`LEAP71_HelixHeatX/Documentation/table.png`, "on a MacBook Air"). That is a
different machine running a build we never ran, so "1.36× off native" and
"faster than native" were cross-machine claims. This sweep replaces the
published column with a **same-machine** denominator.

## What was run

| | |
| --- | --- |
| Fixture | `LEAP71_HelixHeatX` @ `a0a0234`, **sources unmodified** |
| C# kernel | `PicoGK` @ `389d4d9` (= origin/main, v2.2.0) |
| Native runtime | the **published prebuilt** `picogk.26.2.dylib` shipped in `PicoGK/native/osx-arm64/` (log reports build `2026-06-05 21:50:16`) — not our own PicoGKRuntime build |
| Support library | `LEAP71_ShapeKernel` @ `5460806` |
| Entry point | `Library.Go(voxelSize, HelixHeatX.Task)` exactly as the upstream tutorial prescribes |
| Timed unit | the Task delegate — voxel construction **including** viewer previews, 10 screenshot requests, 2 × `Uf.Wait(0.1 s)` and the final STL export (this is what the published table measures) |
| Machine | Apple M2 Pro, 12 cores, 32 GiB, macOS 26.5.2, .NET 9.0.16, Low Power Mode **off** |
| Protocol | 1.0 → 0.5 mm in 0.1 mm steps, 5 runs each, **round-robin** passes (all sizes, then repeat) so thermal drift spreads across sizes rather than biasing the last one; one process per run |
| Host load | 8.8–22.2% busy, recorded per run in `hostBusyPercentBefore`. The <5% target was unreachable (user's own VM + desktop apps); measured contention cost on this fixture is ~2.6% at 32.7% busy, so ≲1.5% here |

HeatX compiled against latest PicoGK **without any porting** — no API drift
needed fixing. Harness: `bench/native-heatx/` (`run-sweep.sh`, `summarize.mjs`).

## Results

| voxel (mm) | n | native median (s) | 95% CI | min–max | MAD | published (s) | machine ratio | STL (MB) | published STL |
| ---: | ---: | ---: | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 5 | **19.79** | [19.32, 20.03] | 19.32–20.03 | 0.07 | 34 | **1.72×** | 93.7 | 94 |
| 0.9 | 5 | **23.06** | [22.99, 23.18] | 22.99–23.18 | 0.07 | 38 | **1.65×** | 122.2 | 122 |
| 0.8 | 5 | **27.40** | [27.34, 27.65] | 27.34–27.65 | 0.05 | 44 | **1.61×** | 165.3 | 166 |
| 0.7 | 5 | **34.01** | [33.89, 34.22] | 33.89–34.22 | 0.12 | 54 | **1.59×** | 227.4 | 227 |
| 0.6 | 5 | **44.95** | [44.79, 45.37] | 44.79–45.37 | 0.15 | 72 | **1.60×** | 328.3 | 328 |
| 0.5 | 5 | **65.36** | [64.76, 66.42] | 64.76–66.42 | 0.49 | 98 | **1.50×** | 502.9 | 502 |

### 1. Machine calibration factor: **1.61×** (geometric mean; range 1.50–1.72)

This M2 Pro runs the identical fixture ~1.6× faster than the MacBook Air the
published table came from. **Every published-table number should be divided by
~1.6 before being used as a native reference for work on this machine.** The
ratio narrows as voxels get finer (1.72× at 1.0 mm → 1.50× at 0.5 mm), i.e. the
gap is widest on the short, fixed-overhead-heavy runs and compresses where the
work is memory-bound — a plausible signature of the two machines' memory
subsystems being closer than their core counts.

### 2. Geometry parity across the whole table

STL sizes match the published column to ≤0.3% at **every** size. Note the
published table (`LEAP71_HelixHeatX/Documentation/table.png`) carries a time
**and** an STL size on all nine of its rows, so both the time and the geometry
column above are checked against upstream at all six sizes we ran — an earlier
draft of this file wrongly said upstream published times for only 1.0 and
0.5 mm, which would have made the §1 six-size calibration unsupported. Same
part, same fixture, correctly configured.

### 3. Run-to-run stability is excellent

MAD 0.05–0.49 s; worst-case spread 2.5% (at 0.5 mm), most sizes ≤1%. Five runs
per cell was more than enough — the medians are not in doubt at ~11% host load.

## What this changes for picovoxel's claims

| voxel | native **here** | wasm multi (pre-accel, R11) | wasm ÷ native | wasm today (accelerated) | native ÷ wasm today |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 19.79 | 38.2 | 1.93× slower | ~8.4 (V0.3 mimalloc) | **~2.4× faster** |
| 0.5 | 65.36 | 133.0 | 2.04× slower | ~32.9 (SK-0-EXIT §4.4) | **~2.0× faster** |

- The **honest pre-acceleration wasm tax was ~1.8–2.15×** against same-machine
  native — consistent with the independently measured 1.95× PicoGK-level tax
  (`picovoxel-wasm-kernel-blueprint.md` §"readback was never the bottleneck"),
  and *not* the flattering 1.36× that came from comparing our M2 Pro against
  their MacBook Air.
- Today's accelerated wasm build is **~2× faster than native PicoGK on the same
  machine** — a stronger and more defensible claim than the previous
  cross-machine "~3× faster than the published number", and it no longer
  depends on hardware the reader has to take on trust.

### Caveat that runs the other way (state it when quoting the table above)

The native Task includes **10 screenshot requests (~37 MB TGA each), viewer
previews, and 2 × 0.1 s explicit render waits**; picovoxel's TS port of the
fixture drops previews and screenshots (`examples/helixheatx/helixHeatX.ts:9`)
while still exporting the STL. So the native column carries fixed overhead the
wasm column does not, which flatters wasm. That overhead is fixed-cost, so its
share shrinks with voxel size — materially at 1.0 mm, marginal at 0.5 mm.
**Quantifying it is the obvious follow-up** (it needs a preview-free native
variant, which would no longer be the upstream fixture — hence not done here).

The machine-calibration factor in §1 is **unaffected** by this: both sides of
that comparison are the same fixture with the same previews.

## Files

- `native-heatx-2026-08-09.jsonl` — 30 records (per-run task/process seconds,
  STL bytes, host load, library build, timestamps)
- `native-heatx-2026-08-09.log` — runner log incl. per-run idle gate readings
- `bench/native-heatx/` — harness (csproj, `Program.cs`, `run-sweep.sh`,
  `summarize.mjs`); regenerate this table with
  `node bench/native-heatx/summarize.mjs`
