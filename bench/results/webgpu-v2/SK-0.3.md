# SK-0.3 — bulk beam-buffer ABI: flat lattice staging, one crossing per lattice

**Date**: 2026-07-26 · **Branch**: `webgpu` · **Parent**: `85825da` (SK-0.7)

## Verdict

**GO, clean.** `lattice.addBeam()`/`addSphere()` now stage into a flat `Float32Array` and cross
the ABI **once per lattice** instead of once per element. On HelixHeatX that is **1,197,460
crossings → 37**, counter-verified against 37 `Lattice_hCreate` calls. Per beam, end to end
through the public facade: **50.1 → 39.2 ns** — the entire authoring call, destructuring and
staging included, is now cheaper than the bare ABI crossing it replaced. The HeatX `author`
stage goes **238.7 → 150.8 ms** on a paired ABAB ×5 in one process, with **disjoint** sample
ranges. Geometry is bit-identical: same volume, same byte-locked fixtures.

The public TS API is unchanged — no new method, no changed signature,
`test/surface-manifest.json` untouched.

## Layout decision: ingest-copy, not adopt-as-storage

The brief left this open ("adopt the flat buffer AS the storage if the current storage is an
AoS vector the renderer iterates"). It is exactly that — and the answer is still ingest-copy.

`PicoGK::Lattice` (`vendor/PicoGKRuntime/Source/PicoGKLattice.h:245-247`) holds
`std::vector<LatticeBeam::Ptr>` and `std::vector<LatticeSphere::Ptr>` — vectors of
`shared_ptr`, i.e. **one `make_shared` per beam** (control block + a ~64 B object carrying
start, end, two radii, a bool and a cached `BBox3`). `Voxels::RenderLattice`
(`PicoGKVdbVoxels.h:343-358`) iterates them and dereferences each. So adopting a flat buffer as
the storage would mean editing:

1. `PicoGKLattice.h` — the storage type and `AddBeam`/`AddSphere`,
2. `PicoGKVdbVoxels.h:349,354` — `*roSphere`/`*roBeam` → value iteration.

Both are inside the vendored tree that R4 keeps pristine (this repo's own C++ lives in
`src/pico-bulk.cpp` / `src/pico-tape.cpp` and links alongside), and `PicoGKVdbVoxels.h` is the
TU a sibling spike (SK-0.5) is working in. Editing either is outside this spike's scope by the
same rule that put `Mesh_GetVertices` in `pico-bulk.cpp` rather than in a patch.

So the flat buffer lives on the **TS side**, which is where the GPU upload will read it anyway,
and `Lattice_AddBeams` replays it through `Lattice::AddBeam`. That is not a compromise for
correctness — going behind `AddBeam`'s back would drop two things it does per element:

- the incremental `m_oBBox.Include(...)` that `Lattice_GetBoundingBox` reports, and
- the **degenerate-beam rule**: a round-capped beam whose endpoints coincide is turned into a
  *sphere* and lands in the other vector (`PicoGKLattice.h:213-218`).
  `src/shapekernel/latticePipe.ts:118` emits exactly that shape, so it is a live path, not a
  hypothetical.

The cost of the decision is measured, not assumed: with the crossing amortised away,
**20.9 ns of the 39.2 ns/beam is C++-side ingest** — the `make_shared`, not the boundary.
That is the residual, and it is filed as **U18** in `MIGRATING-FROM-CSHARP.md` with this
number attached. `std::vector<LatticeBeam>` is a two-line change upstream; it is not ours to
make here.

### The wire format is chosen for the GPU, not for this loop

Per beam, **8 f32 = 32 B**, `(x, y, z, radius)` per endpoint:

```
 0    1    2    3     4    5    6    7
[x0,  y0,  z0,  r0,   x1,  y1,  z1,  r1]
 └── endpoint A ──┘   └── endpoint B ──┘
```

Two `vec4<f32>` lanes. 16-byte aligned, 32 B stride, no padding under std140 *or* std430 — so
`beams.subarray(0, beamCount * 8)` is a valid `writeBuffer` source with **no repacking**, and
slab-binning for SK-0.4's tube-complex lane is a stride-8 scan. The alternative that mirrors
the C signature literally — `(x0,y0,z0, x1,y1,z1, r0,r1)` — is the same 32 B on the CPU but
becomes `vec3` + `vec3` + two scalars on the GPU, which std140 pads to 48 B. Spheres use the
same lane shape, 4 f32 = `(x, y, z, radius)`, i.e. one beam endpoint.

Round-cap flags ride in a **parallel `Uint32Array`**, one per beam, rather than in the record.
A 9th float would break the 32 B stride; a `Uint8Array` would need `HEAPU8` added to
`EXPORTED_RUNTIME_METHODS` and would have to be widened for the GPU anyway, since WGSL has no
`u8`. Both arrays go into one `_malloc` (beams, then flags) so a flush is one allocation.

## Implementation

**C++** (`src/pico-bulk.cpp`, +2 exports → 149 bindings):

```c
int32_t Lattice_AddBeams  (PKINSTANCE, PKLATTICE, const float* pfBeams,
                           const uint32_t* pnRoundCap, int32_t nCount);
int32_t Lattice_AddSpheres(PKINSTANCE, PKLATTICE, const float* pfSpheres, int32_t nCount);
```

Null pointer or non-positive count is a no-op returning 0, matching the `Mesh_Add*` precedent.

**TS** (`src/lattice.ts`): two growable typed arrays per lattice, geometric doubling from a
256-element first allocation, no per-element allocation. Flush copies the staged block into
wasm memory and crosses once.

**Ordering is preserved exactly, including across kinds.** Beams and spheres are never staged
simultaneously: `addSphere` flushes pending beams first and `addBeam` flushes pending spheres
first, so replay order into PicoGK is call order. That costs one already-taken branch per call
in a homogeneous run (HeatX: 37 flushes for 1.2M calls) and it is not optional — the
degenerate-beam rule above means the two streams are not independent.
`src/shapekernel/sh.ts:46,53` mixes them on one lattice.

**Flush points** — the three places the batch can become observable:

| site | why |
| --- | --- |
| `toVoxels()` | renders the lattice |
| `memUsage` | reports element counts |
| `handle` (escape hatch) | how `voxels.withLattice()` and any raw consumer reach it |

`dispose()` empties the batch, so `handle` on a disposed lattice flushes nothing. No public
`flush()` was added: there is nothing a caller could do with one that reading `handle` does not
already do, and adding it would change the locked public surface for no behaviour.

## Crossing counter — the exit assertion, verified

`bench/lattice-batch.mjs` wraps the wasm exports **before** `bindPicoRaw` reads them (bind
happens inside `createPicoSession`), so every `Lattice_*` crossing is counted whichever facade
is in play. Five reps per variant, alternating:

| variant | `Lattice_AddBeam` | `Lattice_AddBeams` | `Lattice_AddSphere` | `Lattice_AddSpheres` | `Lattice_hCreate` |
| --- | ---: | ---: | ---: | ---: | ---: |
| per-call *(the path replaced)* | **1,197,460** | 0 | 0 | 0 | 37 |
| **batched (this spike)** | **0** | **37** | 0 | 0 | **37** |

37 crossings for 37 lattices — one each, exactly. Identical at 3.0 mm and at the pinned 1.0 mm
(`heatxConfirm` in the result file), which is what makes the cheap-voxel-size A/B below valid:
the author stage is geometry-driven, not voxel-size-driven. HeatX uses **zero** spheres; the
sphere path is covered by the tests instead (`test/tier2.test.mjs` C6, `test/lattice-polyline.test.ts`).

## Per-beam cost — method

`bench/lattice-batch.mjs`, min-of-N in **one process**: `N = 9` runs × 200,000 beams, first 2
discarded as JIT warmup, minimum over the remaining 7. Minimum is the right estimator for a
floor — noise only ever adds.

**Machine state**: Apple M2 Pro (12 cores, 32 GiB), darwin 25.5.0, node v26.5.0, **AC power**,
`lowpowermode 0`. Load 2.76 at start → 7.61 at end — two sibling spikes were running in
separate worktrees throughout. The `raw per-call` row is the invariant reference: it is the
same export SK-0.2 measured at 56.4 ns and it reproduces at **50.1 ns** here, so the rows below
are comparable to that record and to each other.

## Per-beam cost — results (ns/beam)

| row | ns/beam | what it includes |
| --- | ---: | --- |
| `raw per-call (Lattice_AddBeam)` *(the path removed)* | **50.12** | one crossing + `make_shared` + `push_back`, scratch pre-written |
| `bulk (Lattice_AddBeams)`, amortised | **20.88** | one `_malloc` + `HEAPF32.set` + **one** crossing + `make_shared` + `push_back` |
| **`lattice.addBeam({...})` facade + flush** | **39.21** | the above **plus** option destructuring, defaults, growth checks and the staging writes |

Windows 4.2–10.0 ms (the bulk row's 4.18 ms is marginally under the 5 ms convention; at
`hrtime.bigint()` resolution quantization is not a factor, and the row is the *least* load-
sensitive of the three).

Raw samples: `sk-0.3-lattice-batch.json`.

**The headline is the third row against the first.** SK-0.2 left `lattice.addBeam()` at
**131.6 ns** (56.4 ns crossing + ~75 ns of facade). It is now **39.21 ns** — **3.36×** — and
below the cost of the bare crossing it used to sit on top of. The crossing itself has not got
cheaper; there are 32,364× fewer of them.

**Decomposition of the remaining 39.2 ns:**

- **20.9 ns** — C++ ingest (`make_shared` + `push_back`). Upstream storage; **U18**.
- **~18.3 ns** — JS: destructure 6 options with 3 defaults, one growth check, 8 f32 stores and
  a flag store. The `memcpy` floor itself is ~1 ns/beam (32 B): `HEAPF32.set` of 6.4 MB is
  microseconds, spread over 200k beams.

So the boundary is gone from this cost and what remains is real work on both sides. Further
gains need U18, not a cheaper wrapper.

## HeatX `author` stage — paired A/B

The A/B runs both variants **in one process, alternating** (`batched`, `per-call`, ×5), against
the real subject via `examples/helixheatx/run.ts`. The `per-call` variant is a faithful
re-creation of the facade this spike replaced — same option destructuring, scratch writes and
`raw.Lattice_AddBeam` per element — proxied over `createLattice`, so both variants share the
process, the JIT, the wasm instance and the machine load.

Run at 3.0 mm, where the voxel kernels are cheap and the author stage is unchanged (crossing
counts identical to the 1.0 mm confirm run, above).

| variant | author median | samples (ms) |
| --- | ---: | --- |
| per-call | **238.72 ms** | 236.19, 257.78, 238.72, 236.06, 251.90 |
| **batched** | **150.83 ms** | 154.07, 149.24, 150.83, 154.79, 146.89 |

**Δ −87.9 ms (−36.8%).** The ranges are **disjoint** — max batched 154.79 < min per-call 236.06
— so this is a claim, not a hint. Both variants produced the **identical** volume
(653902.5625, all 10 runs), which is what makes it a timing comparison at all.

Sanity on the arithmetic: 1,197,460 beams × 73.4 ns = the observed 87.9 ms. The microbench
delta for the same pair is 50.1 → 39.2 = 10.9 ns of *crossing-and-staging*; the rest is what
the per-call facade paid on top (its own destructuring, two `writeVec3` calls into scratch and
a `handle` read per beam) and cache effects the tight microbench loop does not see. Direction
and order of magnitude agree; the macro number is the one to quote.

The batched author stage at the pinned **1.0 mm** is **149.22 ms** — within 1% of the 3.0 mm
figure, confirming voxel-size independence directly.

## Macro sanity

Standard suite (`node bench/run.mjs --allow-loaded`), 1 warmup + 5 measured repeats, diffed
against `sk-0.1-baseline-dlmalloc.json`. **This run is load-contaminated and is reported as a
sanity check only — no timing claim is made from it.** Two sibling spikes held the machine at
loadavg 4.8–6.4 throughout; the harness's own quiet-machine guard refused the run and had to be
overridden with `--allow-loaded`, which is exactly the signal the guard exists to give.

Result file: `bench/results/webgpu-v2/sk-0.3-macro-loaded.json`. It is deliberately **not** in
`bench/results/`, which is where `bench/check-drift.mjs` scans: several contaminated 12-thread
rows exceed the checker's 2× threshold and would open spurious CI issues. The committed drift
baseline stays SK-0.2's quiet run.

| metric / phase | SK-0.1 baseline | loaded run | Δ | reading |
| --- | ---: | ---: | ---: | --- |
| **M12@single / author** | 406.692 ms | **153.382 ms** | **−62.3%** | the target stage; single-thread JS + ABI, the least load-sensitive row in the suite |
| **M12@multi / author** | 458.735 ms | **169.846 ms** | **−63.0%** | same stage, other build |
| M12@single / construct | 55259.545 ms | 55116.925 ms | −0.3% | flat, as expected — SK-0.3 touches ~0.3% of construct |
| M11 / construct | 26195.151 ms | 26422.069 ms | +0.9% | flat |
| M9 / raw10k *(ccall canary)* | 15.652 ms | 15.767 ms | +0.7% | flat |
| M9 / facade10k | 15.673 ms | 14.859 ms | −5.2% | SK-0.2's residual, unchanged |
| M12@multi / construct | 34664.796 ms | 38851.702 ms | **+12.1%** | **contamination** |
| M12@multi / 14 small boolean kernels | 1.9–35.3 ms | 5.3–86.0 ms | **+96…+212%** | **contamination** |

The contamination signature is unmistakable and is the same one SK-0.2 documented: **every**
regressed row is a 12-thread `M12@multi` stage while its single-thread twin is flat, and the
worst offenders are the ~2–35 ms boolean stages that can lose their whole TBB pool to a
competing process. No single-thread row moved more than 1%.

The `author` rows are worth reading despite the load — they are single-threaded JS plus ABI
crossings, and the whole ±1% band of flat single-thread rows around them says the load did not
reach them. But note the baseline is **pre-SK-0.2**, so −62% is SK-0.2 + SK-0.3 together.
Against SK-0.2's own quiet re-run (author 298.069 ms single), SK-0.3's share is
**298.1 → 153.4 ms, −48.5%** — cross-run, hence larger than the −36.8% the paired A/B measured,
and in the expected direction: the A/B's "before" variant omits the per-call `guard()` closure
that the real SK-0.2 facade allocated 1.2M times.

`M1/instantiate` +19.3% is the wasm-artefact confound SK-0.2 documented, amplified: this spike
genuinely rebuilt the module and added two exports.

The load-resistant evidence for this spike is the paired in-process A/B above and the crossing
counter, neither of which depends on machine quiet.

## Byte parity

| check | result |
| --- | --- |
| full suite (`npm test`, coverage on) | **458 passed / 49 files** (455 at SK-0.2 + 3 new) |
| coverage thresholds | **100%** statements / branches / functions / lines |
| byte-locked fixtures | **byte-identical** — all six sha256 unchanged from SK-0.2's record |
| browser gate (`npm run test:browser`) | **ALL ENGINES PASS** — chromium / webkit / firefox, 17/17 each |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `test/surface-manifest.json` | **unchanged** — the public facade graph did not move |
| HeatX single↔multi differential | STL bytes identical (suite assertion, unchanged) |

Byte-locked fixture checksums, identical to the values SK-0.2 recorded:

```
56298c702d37ed991180117019e16edf584d2f01291b34e327053ec1d74c2eec  test/fixtures/helixheatx.json
9e360d57ee590b2d3bc0ea26620eaad182ec7e0e5477904586e9d09705af6c0a  test/fixtures/latticelibrary-examples.json
b120759423e59d2319626719cf1222adf003a2f0a2213ec96a2978913ec9f1c0  test/fixtures/quasicrystals.json
5a5ee9da71e7f6920e9cc6db0f85eae0e263a350a0af8cd054729d291f718749  test/fixtures/roverwheel.json
52e2702d51b41b2b2dc18a67de1b15628ff536f78f929d25266d4ce94504218f  test/fixtures/shapekernel-examples.json
08c9a479c2e225cbcc35699422865a93998956c4e2be8e0c1c76805d6fe926b6  test/fixtures/simulation.json
```

This matters more than usual here, because unlike SK-0.2 **this spike rebuilt the wasm**. The
fixtures pin HeatX's volume hex, triangle count and STL byte count at 1.0 mm through 1.2M
beams; they are unchanged, which is the beam-order and field-order proof at application scale.

### Artefact checksums (sha256)

```
aba08e186486e805886e5d09d1730c97fb09982067e28fb33ed678213536205b  src/pico.wasm         (5,835,120 B)
c2b456869fb8b6161460a3dce556f7951b88100ee1f270c6bd39bf3cec26ac72  src/pico-multi.wasm   (5,833,218 B)
88995970834487d99c37bd52288fd6550ab63c4c21e7793a5b867426f2340bc8  src/raw.generated.ts
843c1de2cc6409a6eca4f88488de9f2ba9997d161de7c66f8a5915306aeea8d3  src/lattice.ts
82abc3f01c8f362e4a5d479caf660c31bee0bd61015dc9c4d82f2deb9ff2d086  src/pico-bulk.cpp
1fae2a157094bebf4effc6035f46e905f88eebb38096440d0e830df8f8a9820f  bench/results/webgpu-v2/sk-0.3-lattice-batch.json
bcc540519756a8e0998253368ed3bf370956adde11bc16e47c4a824abdb75afd  bench/results/webgpu-v2/sk-0.3-macro-loaded.json
```

## New standing guards

- `test/tier2.test.mjs` **C6 bulk** — builds the same 40 beams + 40 spheres twice, once through
  the per-element exports and once through the bulk pair, and asserts `Lattice_nMemUsage` and
  `Voxels_fCalculateVolume` are **exactly** equal. A wrong stride, a swapped radius lane or a
  dropped flag moves the volume. Also pins the null/zero-count no-ops.
- `test/lattice-polyline.test.ts` **SK-0.3 batched ≙ per-element** — the same oracle at the
  facade level, in the same session: 300 beams (past the doubling threshold) with both cap
  kinds, a degenerate round-capped zero-length beam, 300 spheres, and kind-switches at the
  seams, against a raw per-element lattice built from the same numbers. Exact equality.
- `test/lattice-polyline.test.ts` **handle escape hatch flushes** — the flush point that is not
  `toVoxels`, i.e. the one a future refactor is most likely to lose.
- `bench/lattice-batch.mjs` — the crossing counter and the paired author A/B. A regression that
  reintroduces per-element crossings shows up as a count, not as a timing wobble.

## Surprises

1. **The whole authoring call is now cheaper than the crossing it replaced** — 39.2 ns facade
   vs 50.1 ns for the bare `Lattice_AddBeam` export. The expected outcome was "crossing cost
   amortised toward the memcpy floor"; what actually happened is that the *facade* overhead
   SK-0.2 flagged (~75 ns of destructuring, scratch writes and a per-call `guard()` closure)
   largely evaporated too, because staging into a typed array needs no scratch, no closure and
   no pointer arithmetic per call.
2. **The residual is upstream's allocator, not the boundary.** 20.9 of 39.2 ns is
   `make_shared` per beam. The spike brief anticipated the memcpy floor as the target; the
   floor is actually ~1 ns/beam and everything above it is now C++ object construction. This is
   the whole reason U18 is worth filing with a number.
3. **HeatX authors 1,197,460 beams and exactly 0 spheres.** The sphere path had to be covered
   by tests rather than by the subject.
4. **The vendored `oneTBB` tree in this checkout was unpatched.** SK-0.7's `patches/oneTBB`
   landed from a worktree, so the main checkout still had a pristine tree and a pre-patch
   `libtbb.a` — a naive rebuild silently produced a `pico-multi.wasm` **without** the SK-0.7
   substrate fixes (20 KB smaller). Caught by comparing the rebuild against the committed
   artefact size; fixed by re-running `scripts/fetch-deps.sh` (which applies the patches and
   stamps them) and rebuilding both dependency prefixes before relinking. **A rebuild in a
   checkout that did not run the spike that patched the deps is not the same build.**
5. **The wasm link is not byte-reproducible.** A rebuild with *no* source change produced a
   different `pico.wasm` sha256 (identical size) and a `pico-multi.wasm` differing by 438 bytes.
   Geometry is unaffected — a full suite run on the unmodified rebuild was green with every
   fixture byte-identical, which is the control this spike's fixture claim rests on — but the
   binary is not a checksum-stable artefact and should not be treated as one.
