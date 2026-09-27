# Do picovoxel's patches speed up the NATIVE PicoGK build?

**2026-08-09 · 90 runs across 3 arms · uncommitted**

Short answer: **no — +1% (geometric mean), and 5 of 6 sizes have overlapping
confidence intervals.** That is not a disappointing result so much as a
*locating* one: it says out loud where picovoxel's acceleration actually lives,
and it makes the one big native win that remains available concrete and
costed. Detail and attribution below.

## Method

Three arms, same fixture (`LEAP71_HelixHeatX` @ `a0a0234`, sources unmodified),
same harness, same protocol as `README.md` (1.0 → 0.5 mm, 5 round-robin passes,
one process per run, host load 8–22% recorded per run).

| Arm | Binary | Isolates |
| --- | --- | --- |
| `published` | the prebuilt dylib LEAP 71 ships in `PicoGK/native/osx-arm64` | what a normal PicoGK user gets |
| `pristine-ourbuild` | pristine sources, **our** cmake flags (Release, `USE_BLOSC=OFF`, homebrew TBB 12.18 / boost) | the build-environment delta — **the control** |
| `patched` | + every applicable `patches/` series, **same flags as the control** | our patches, cleanly attributed |

The control arm is the methodological point. Comparing our patched build
directly against the published dylib would fold two different effects into one
number, and the control shows that fold would have been worth ~1.5% — the same
order as the patch effect itself.

**Patches applied** (all cleanly, `--fuzz=0`): PicoGKRuntime `0001` parallel
disjoint-slot mesh flatten (U19), `0002` post-fill prune (U21), `0003` lattice
parameter accessors, `0004` lattice beam value storage (U18); openvdb `0001`
flat quad output (U19/U10).

**Patch deliberately excluded**: oneTBB `0001-wasm-substrate-edges` — all three
hunks are inside `#if __EMSCRIPTEN__`, so it is a *provable* no-op for a native
build. Excluded, not forgotten.

## Results

| voxel (mm) | published | pristine (our build) | patched | patched ÷ pristine | STL identical across all 3 arms? |
| ---: | ---: | ---: | ---: | ---: | :--- |
| 1.0 | 19.79 | 19.52 | 19.48 | 1.00× | yes — 93,721,484 B |
| 0.9 | 23.06 | 22.70 | 22.61 | 1.00× | yes — 122,184,884 B |
| 0.8 | 27.40 | 26.87 | 26.72 | 1.01× | yes — 165,332,484 B |
| 0.7 | 34.01 | 33.69 | 33.37 | 1.01× | yes — 227,361,084 B |
| 0.6 | 44.95 | 44.53 | 44.42 | 1.00× | yes — 328,300,684 B |
| 0.5 | 65.36 | 64.45 | 63.94 | 1.01× | yes — 502,871,684 B |

- **Patch effect: 1.01×.** Only the 0.7 mm cell separates at 95% confidence;
  the rest overlap. Treat this as "≤1.5%, indistinguishable from zero at most
  sizes".
- **Build-environment delta: 1.3–1.9%** (published → pristine, consistently
  faster). Newer homebrew TBB, different toolchain, `USE_BLOSC=OFF`.
- **Geometry parity is exact** — byte-identical STL sizes across all three
  binaries at every size, which is the correctness claim these Class 0/1
  patches make. The patches did what they promise; they just don't move this
  wall.

## Why ~1% — the attribution

HeatX's native wall is dominated by lattice/voxelization *creation*
(~85%; `picogk-webgpu-iteration-2-blueprint.md` AR7 measured ~30 s of a 35.5 s
wall, and **zero** implicit fills). Against that, the applied patch set's known
absolute effects are small:

| Patch | Known effect | Share of a 65 s HeatX wall |
| --- | --- | --- |
| U19 parallel flatten + flat quads | mesh extraction 1.37× (SK-0.6) | extraction is ~1% of the wall → ≲0.3% |
| U21 post-fill prune | −68% tree slack on `RenderImplicit`, −36% ProjectZSlice, −5.5% RenderLattice | HeatX has **no** implicit fills; benefit is downstream-iteration, not this wall |
| U18 beam value storage | <2 ns/beam (honestly re-measured; the 20.9 ns figure was retired) | ~1.2 M beams ≈ 2.4 ms → ~0.004% |

Sum ≈ well under 1%. The measurement agrees with the arithmetic.

**The wins that make picovoxel fast are not in `patches/`:**

| picovoxel win | Magnitude | Why native C# can't see it |
| --- | --- | --- |
| mimalloc allocator lane | **2.16×** MT (SK-0-EXIT / V0.3) | a *link-time* choice for our wasm artifact, not a source patch. Native PicoGK uses system malloc — and openvdb's own configure warns here: *"Unable to find Jemalloc… recommended for optimum performance"* |
| Tube-complex lattice (U5) | **6.05× @1.0 mm / 13.2× @0.5 mm** | the accessor half is patched (`0003`); the `Voxels::RenderLattice` dispatch rewrite **was never written as a patch** — the ledger records it as "blocked on a build" |
| `csg*Copy` booleans, `fastRenorm` offsets, `bIsEqualFast`, batched queries, `ProjectZSliceFast`, `IntersectImplicitFast` | 1.4× – 241× | picovoxel *sibling TUs* + TS facade. C# calls the upstream exports, which these deliberately do not replace |
| oneTBB substrate fixes | 31× on `machine_pause` | emscripten-only by construction |

So this experiment measured the ~1% slice of our work that is currently
expressed as upstream-shaped source patches. It did not measure "our
acceleration", because most of that is architecture the C# binding never
reaches.

## What this unlocks (the actually interesting outcome)

The U5 ledger row has said "patch pending — **blocked on a build**" since SK-0.4
— the tube-complex dispatch needs to compile and run against upstream's own
call sites, and we had no native build to do that in. **We now have one**, plus
a 90-run baseline and a harness that swaps dylibs by label. Two concrete,
costed follow-ups:

1. **U5 tube-complex lattice as a real patch** — targets the ~85% of the wall
   that is lattice creation, with a measured 6–13× on that stage in our own
   tree. This is the one change plausibly worth *tens of percent* natively, and
   it converts U5 from a prose ledger row into a patch a maintainer can apply.
2. **Allocator arm** — install jemalloc (or link TBB malloc explicitly) and
   re-run. Our own allocator flip was worth 2.16× on the MT wasm lane, and
   openvdb's configure explicitly asks for it. Cheap: one rebuild + one sweep.

Both are single-variable experiments against the control arm already recorded
here. Neither was run, because neither was in scope for "measure our current
patches".

> **DONE 2026-08-09, same day — both follow-ups ran** (120 further runs; see
> `BEST-CASE.md` in this directory, regenerate with
> `node bench/native-heatx/compare-best.mjs`). Outcome: (1) the U5 patch is
> real (`upstream/picogkruntime-tubecomplex-lattice.patch`, spec
> `docs/research/picovoxel-u5-tubecomplex-upstream-patch.md`) and measures
> **2.53× geometric mean on the whole fixture wall** (2.83× @1.0 mm → 2.22×
> @0.5 mm, every size CI-separated) — "plausibly worth tens of percent"
> undershot by an order. (2) The allocator arm is a **native null**: mimalloc
> 0.99×, tbbmalloc_proxy 0.98×, mimalloc-on-U5 1.02×, all CI-overlapping —
> openvdb's configure warning does not materialize on macOS arm64 system
> malloc, and wasm's 2.16× mimalloc win is a substrate story that does not
> transport to native.

## Provenance note (a gap found and closed)

The library build stamp recorded in each JSONL is `2026-07-17 19:25:13` for
**both** our arms: the scratch copies inherited a modified `API/PicoGKBuild.h`
from the working tree, and the `git checkout` meant to reset it silently no-op'd
because the copies carry no `.git`. So the stamp does **not** distinguish the
arms. The arm identity is instead established by:

1. **source ground truth** — `FinalizeBulk` appears twice in the patched
   `Source/PicoGKMesh.h`, zero times in pristine (the patch's inline methods are
   inlined away, so they are absent from `nm` in both — source, not symbols, is
   the check);
2. **binary identity** — sha256 `87dbd931…` (pristine, 13,965,856 B) vs
   `3685041c…` (patched, 14,009,520 B);
3. **runner logs** — each sweep logged the absolute path of the dylib it copied
   into the app directory before running.

If these arms are re-run, delete `API/PicoGKBuild.h` from the copy first so the
build regenerates a distinct stamp per arm.

## Files

- `native-heatx-published-2026-08-09.jsonl` / `-pristine-ourbuild-` / `-patched-`
  — 30 records each, plus matching `.log`
- regenerate these tables: `node bench/native-heatx/compare-arms.mjs`
- patched source tree + both dylibs: session scratchpad (not copied into the
  repo; rebuild with `patches/` + `cmake -DCMAKE_BUILD_TYPE=Release -DUSE_BLOSC=OFF`)
