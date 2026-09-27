# Best-case native PicoGK: U5 + allocator arms, full multi-threading

**2026-08-09 · 120 new runs across 4 arms + 12 parity runs (on top of the 90
recorded) · uncommitted**

The question this campaign answers: with every improvement we have that is
expressible natively — the applied patch series, the U5 tube-complex
`RenderLattice` dispatch, an allocator swap — how fast is native PicoGK on the
upstream HeatX fixture?

Answer: **2.60× over the strongest exact arm (geometric mean; 2.92× @1.0 mm →
2.33× @0.5 mm), and effectively all of it is U5.** The allocator arms are a
native null. Regenerate every table below with
`node bench/native-heatx/compare-best.mjs`.

## Arms

The three recorded arms (`PATCHED-NATIVE.md`) plus four new ones. Allocator
insertion is `DYLD_INSERT_LIBRARIES` on the real dotnet host (the brew `dotnet`
command is a bash wrapper, and macOS strips `DYLD_*` at every platform-binary
exec — the runner execs the Mach-O host directly). Every record carries
`allocator` + `dyldInsert` — the value **the process itself saw** — and the
new dylib carries a regenerated build stamp, closing both provenance gaps.

| Arm | Binary / insert | Isolates |
| --- | --- | --- |
| `published` | LEAP 71's prebuilt dylib | recorded, 30 runs |
| `pristine-ourbuild` | pristine sources, our flags | recorded, 30 runs — the control |
| `patched` | + `patches/` series | recorded, 30 runs |
| `mimalloc` | pristine + mimalloc 3.4.5 | allocator alone |
| `tbbproxy` | pristine + tbbmalloc_proxy 2.18 | allocator alone, the upstream-shaped ask |
| `u5` | patched + `upstream/picogkruntime-tubecomplex-lattice.patch` (sha256 `92543b07…`, stamp `2026-08-09 18:34:42`) | the U5 algorithm alone |
| `best` | u5 + mimalloc | the stacked ceiling |

Protocol identical to the recorded sweeps: 1.0 → 0.5 mm × 5 round-robin
passes, one process per run, idle-gated with per-run host load. **Zero
NOT-IDLE flags across all 120 runs** (busy medians 10.5–18.0%). The u5 sweep
absorbed ambient load spikes by *waiting* (gate working as designed); any
residual bias penalizes u5.

## Task seconds (median of 5)

| voxel (mm) | published | pristine | patched | mimalloc | tbbproxy | u5 | **best** |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 19.79 | 19.52 | 19.48 | 19.66 | 19.74 | 6.87 | **6.68** |
| 0.9 | 23.06 | 22.70 | 22.61 | 23.00 | 23.10 | 8.47 | **8.20** |
| 0.8 | 27.40 | 26.87 | 26.72 | 27.23 | 27.33 | 10.38 | **10.03** |
| 0.7 | 34.01 | 33.69 | 33.37 | 34.10 | 34.23 | 13.22 | **13.19** |
| 0.6 | 44.95 | 44.53 | 44.42 | 45.09 | 45.26 | 18.36 | **18.37** |
| 0.5 | 65.36 | 64.45 | 63.94 | 65.21 | 66.20 | 28.75 | **27.40** |

## Effect axes (baseline ÷ arm; ✓ = 95% CIs separated, · = overlapping)

| voxel | mimalloc alone | tbbproxy alone | **U5 alone** | alloc on U5 | best vs patched | best vs published |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 0.99×· | 0.99×· | **2.83×✓** | 1.03×· | 2.92×✓ | 2.96×✓ |
| 0.9 | 0.99×· | 0.98×· | **2.67×✓** | 1.03×· | 2.76×✓ | 2.81×✓ |
| 0.8 | 0.99×· | 0.98×· | **2.57×✓** | 1.04×· | 2.66×✓ | 2.73×✓ |
| 0.7 | 0.99×· | 0.98×✗ | **2.52×✓** | 1.00×· | 2.53×✓ | 2.58×✓ |
| 0.6 | 0.99×· | 0.98×· | **2.42×✓** | 1.00×· | 2.42×✓ | 2.45×✓ |
| 0.5 | 0.99×· | 0.97×· | **2.22×✓** | 1.05×· | 2.33×✓ | 2.39×✓ |
| **geo** | **0.99×** | **0.98×** | **2.53×** | **1.02×** | **2.60×** | **2.64×** |

### The allocator verdict: a native null, and a useful one

mimalloc 0.99×, tbbmalloc_proxy 0.98× (one cell separated *slower*), mimalloc
stacked on U5 1.02× with every CI overlapping. Both inserts were verified live
(mimalloc pre-flight: 1.0 GiB committed through its arenas, 33 threads, STL
byte-identical to pristine), so this is a real measurement of a real
replacement, not a failed insertion:

- **openvdb's configure warning** ("Unable to find Jemalloc… recommended for
  optimum performance") **does not materialize on macOS arm64** for this
  workload. Apple's libmalloc holds its own here.
- **wasm's 2.16× mimalloc win (V0.3) is a substrate story** — emscripten's
  dlmalloc being weak under threads — **and does not transport to native.**
  mimalloc remains the right allocator for our wasm artifact (identity across
  targets), but there is no native performance case for shipping an allocator
  change, and the tbbmalloc_proxy upstream ask is dead on arrival: there is
  nothing to ask for.

### The U5 verdict

2.53× geometric mean on the whole fixture wall — previews, ten screenshots and
the STL export included — CI-separated from `patched` at every size. For scale,
the entire rest of the patch series measured 1.01× over 90 runs
(`PATCHED-NATIVE.md`). The `best` arm adds only noise-level allocator effect on
top: **the native story is U5, full stop.**

## Prediction vs measurement — the pre-registered falsification fired

The spec (`docs/research/picovoxel-u5-tubecomplex-upstream-patch.md` Finding 7)
pre-registered per-size predictions from a constant accelerated-share model and
named its own falsifier: a flat-or-shrinking ratio toward fine voxels.

| voxel (mm) | predicted u5 (s) | measured u5 (s) | error | predicted ratio | measured ratio |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 7.03 *(anchor)* | 6.87 | −2.3% | 2.77× | 2.83× |
| 0.9 | 7.8 | 8.47 | +8.6% | 2.90× | 2.67× |
| 0.8 | 8.9 | 10.38 | +16.7% | 3.00× | 2.57× |
| 0.7 | 10.6 | 13.22 | +24.7% | 3.15× | 2.52× |
| 0.6 | 13.6 | 18.36 | +35.0% | 3.27× | 2.42× |
| 0.5 | 18.7 | 28.75 | +53.7% | 3.42× | 2.22× |

The ratio **shrinks** — magnitude right at the anchor, trend wrong. Holding
SK-0.4's stage ratios, the back-solved accelerated share falls monotonically
**77.5% → 59.5%** from 1.0 to 0.5 mm: the non-lattice work (mesh voxelization
through `RenderMesh`, meshing, the ~503 MB STL export) grows faster with
resolution than lattice creation does. Wall time alone cannot separate a
shrinking share from native stage ratios sitting below the wasm anchors, but
either way the constant-share model is dead — and the next native-order win at
fine voxels is **mesh voxelization, not lattices**.

## Geometry: Class 0 where it must be, Class 2 where declared, gated

**Byte counts, all 30 records per arm uniform at every size:**

| Group | STL bytes per size |
| --- | --- |
| published = pristine = patched = mimalloc = tbbproxy | identical at every size — allocator legs are **Class 0**, as required |
| u5 = best | identical to each other at every size, ≠ the exact group — **Class 2**, allocator-independent, run-to-run stable |

**Content gates** (`compare-stl.mjs`, one independently regenerated
pristine/u5 STL pair per size — byte counts matched the sweep records exactly,
corroborating determinism across separate runs):

| voxel (mm) | Δ triangles | volume (rel) | area (rel) | bounds Δ | gates |
| ---: | ---: | ---: | ---: | ---: | :--- |
| 1.0 | +12 of 1.87 M | 3.5e-7 | 1.8e-6 | 0.000000 | PASS |
| 0.9 | −4 of 2.44 M | 1.6e-6 | 1.0e-6 | 0.000000 | PASS |
| 0.8 | −652 of 3.31 M | 2.6e-5 | 7.3e-5 | 0.000000 | PASS |
| 0.7 | +4 of 4.55 M | 5.0e-8 | 6.3e-7 | 0.000000 | PASS |
| 0.6 | −4 of 6.57 M | 1.1e-6 | 4.1e-7 | 0.000000 | PASS |
| 0.5 | +64 of 10.06 M | 4.3e-7 | 9.0e-8 | 0.000000 | PASS |

Worst case (0.8 mm) sits two orders inside the ≤3% gates; bounds are
byte-identical everywhere.

## What this changes in the cross-target picture

`README.md` in this directory established "today's accelerated wasm is ~2×
faster than native PicoGK on the same machine". That was against *unpatched*
native. Against best native:

| voxel | best native (here) | accelerated wasm (V0.3 / SK-0-EXIT §4.4) | native ÷ wasm |
| ---: | ---: | ---: | ---: |
| 1.0 | 6.68 | ~8.4 | **native 1.26× faster** |
| 0.5 | 27.40 | ~32.9 | **native 1.20× faster** |

— and the native column still carries the previews/screenshots the wasm port
drops, so its lead is understated. The honest statement of the whole program:
**our wasm speed advantage over native PicoGK is mostly this one algorithm.**
Hand it upstream and native users get ~2.5×; the substrate ranking then returns
to native > wasm by ~1.2×, which is the wasm tax working as expected on a
levelled algorithmic field.

## Harness notes (found during this campaign)

- `wait_for_idle` leaked its "waiting for idle" lines into the `$(…)` capture,
  so records in sweeps that had to wait (only `u5` here) carry a wait
  transcript inside `hostBusyPercentBefore`; **the true reading is the last
  line of the field**. Fixed in `run-sweep.sh` (say → stderr inside the
  function); `compare-best.mjs` parses the last line either way.
- Allocator legs need the real dotnet host: `brew --prefix dotnet@9`/libexec/
  dotnet, with `DYLD_INSERT_LIBRARIES` set at that exec. Inserting via the
  wrapper silently no-ops (bash is a platform binary; macOS strips the var).

## Files

- `native-heatx-{mimalloc,tbbproxy,u5,best}-2026-08-09.jsonl` + matching
  `.log` — 30 records each
- `bench/native-heatx/compare-best.mjs` — regenerates every table above
- `bench/native-heatx/compare-stl.mjs` — the Class-2 content gate
- parity STLs + console log: session scratch (`parity/` — 12 runs, 6 pairs)
- the u5 dylib: session scratch `PicoGKRuntime-u5/Dist/picogk.26.2.0.dylib`
  (sha256 `92543b07…`, 14,036,064 B); rebuild = `patches/` 0001–0004 + the U5
  patch + `cmake -DCMAKE_BUILD_TYPE=Release -DUSE_BLOSC=OFF`
- patch: `upstream/picogkruntime-tubecomplex-lattice.patch` · spec:
  `docs/research/picovoxel-u5-tubecomplex-upstream-patch.md` (tau repo)
