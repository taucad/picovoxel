# SK-0.2 — direct-export ABI emission: the ccall slow path removed

**Date**: 2026-07-26 · **Branch**: `webgpu` · **Parent**: `d8ccfb5` (SK-0.1)

## Verdict

**GO, clean.** The generated ABI layer (`src/raw.generated.ts`, emitted by
`scripts/generate-raw.mjs`) now binds every one of its **147** exports as a direct wasm
export (`module._Name`). `Lattice_AddBeam` — the hot site, ~10⁵ crossings per HeatX — went
**176.6 → 56.4 ns/call (3.13×)**, inside the ≤70 ns target. The facade site callers actually
touch, `lattice.addBeam({...})`, went **255.1 → 131.6 ns/call (1.94×)**.

**No wasm rebuild was required.** `src/pico-exports.txt` already lists all 147 as
`EXPORTED_FUNCTIONS`, so every one was already reachable as `Module._Name`; the slow path was
purely a JS-side binding choice. The `pico.wasm` sha256 is **identical** across the before and
after measurements (`70304cfe70a0…`) — the entire delta below is the binding layer and nothing
else. `ccall`/`cwrap` stay in `EXPORTED_RUNTIME_METHODS` because five test files use them
directly, including the deliberately-retained ccall canary in `bench/run.mjs` (M9).

## Export census

| | before | after |
| --- | ---: | ---: |
| total generated bindings | 147 | 147 |
| direct wasm export (fast path) | **4** | **147** |
| emscripten `ccall` (marshalled) | **143** | **0** |
| `ccall`/`cwrap` calls in generated code | 147 | **0** |

147 = 140 core exports from `src/abi.json` (173 header entries − 33 viewer) + 7 own-TU
additions (`src/pico-bulk.cpp`, `src/pico-tape.cpp`).

**Root cause of the 143.** `cwrap` returns the raw export only when *every* argType is
`'number'` or `'boolean'` (`vendor/emsdk/upstream/emscripten/src/lib/libccall.js:148`);
otherwise it returns `(...args) => ccall(...)`. `'bigint'` is not in that predicate, and every
PicoGK handle is a `uint64_t` — so **143 of 147 exports take a handle and were all demoted**,
paying a string-keyed `getCFunc` re-resolution, a per-call converter loop and stack
save/restore for arguments that needed no conversion at all. The four survivors were
`Library_GetName`, `Library_GetVersion`, `Library_GetBuildInfo` and `Library_hCreateInstance`
— the only exports that take no handle. (The spike charter's "139 of 143" was close; the real
figures are 143 of 147.)

Filed upstream as **U16** in `MIGRATING-FROM-CSHARP.md` (a two-token fix, plus two adjacent
defects in the same block: the fast path skips `ccall`'s `Boolean(ret)` conversion, so `cwrap`
and `ccall` disagree on a boolean-returning numeric-args export; and the whole fast path is
`#if !ASSERTIONS`, so debug builds marshal everything).

## What the generator emits now

`bindPicoRaw` walks a generated `EXPORTS` name list, resolves `module['_' + name]`, and throws
a named error if the module does not export it.

This is **stronger** than what it replaces, not merely equal. In the shipped `-O3` glue
`getCFunc` is `(ident) => Module['_' + ident]` with the `assert` compiled out (`#if ASSERTIONS`),
and a demoted cwrap resolves it *at call time* — so a renamed or dropped upstream export used
to surface as `func is not a function` from inside `ccall`, on the first call, deep in a
wrapper. It now fails at bind time naming the export and the rebuild script. The tier-2 gate's
"a renamed one fails to bind" premise is finally literally true.

The **one** conversion a raw export cannot do for itself is `i32 → boolean`: wasm has no bool
type, and the public `PicoRaw` interface promises `boolean`. The 20 boolean-returning exports
therefore get an arity-matched `!!` wrapper (`(fn) => (a0, a1) => !!fn(a0, a1)`) — arity-matched
so the hot path never allocates a rest array. Everything else is the wasm export function
itself, stored directly in the table.

The `PicoRaw` interface — the public TS surface — is **byte-identical** to before. No caller
changed; `npx tsc --noEmit` over `src`, `test`, `bench`, `demo`, `examples`, `spikes` passes.

## Per-call cost — method

`bench/abi-call-cost.mjs` (new, retained as a regression canary). It measures three variants of
the *same* export **in one process**:

- `ccall` — a hand-built `module.cwrap(name, ret, ['bigint', …])`, i.e. the old path,
- `direct` — `module._Name`, the raw export,
- `bound` — whatever `scripts/generate-raw.mjs` currently emits.

`ccall` and `direct` are therefore invariant reference rows: they pin the run-to-run
conditions, and `bound` is the only thing the change can move. Across the two runs below
(taken 9 minutes apart at different machine load) the reference rows agree to **1–4%**, which
is what makes the `bound` deltas attributable.

**Estimator**: min-of-N. `N = 9` runs of `ITERS = 200,000` iterations, first 2 runs discarded
as JIT warmup, minimum over the remaining 7. Minimum is the right statistic for a floor
measurement — noise only ever adds. Every measured window is **4.7–51 ms**, i.e. at or above
the 5 ms quantization floor (the two 4.7/5.0 ms windows are the 2-argument boolean rows;
`process.hrtime.bigint()` is nanosecond-resolution, so quantization is not a factor at these
window sizes either way).

**Machine state**: Apple M2 Pro (12 cores, 32 GiB), darwin 25.5.0, node v26.5.0, **AC power**,
`lowpowermode 0`. Load 5.15 (before run) / 4.79 (after run) — a sibling spike (SK-0.7, oneTBB
substrate) was building dependencies in a separate worktree throughout, plus the operator's
resident Codex process. The invariant reference rows are the defence against that load.

## Per-call cost — results (ns/call)

| export | variant | before | after | speedup |
| --- | --- | ---: | ---: | ---: |
| `Lattice_AddBeam` (7 args) | **bound** | **176.55** | **56.39** | **3.13×** |
| | ccall *(reference)* | 154.28 | 154.35 | 1.00× |
| | direct *(reference)* | 55.81 | 56.40 | 0.99× |
| `Lattice_bIsValid` (2 args, bool) | **bound** | **97.60** | **23.37** | **4.18×** |
| | ccall *(reference)* | 92.50 | 90.18 | 1.03× |
| | direct *(reference)* | 25.88 | 24.99 | 1.04× |
| `Voxels_bIsEmpty` (2 args, bool) | **bound** | **109.14** | **33.07** | **3.30×** |
| | ccall *(reference)* | 100.21 | 99.37 | 1.01× |
| | direct *(reference)* | 35.28 | 34.69 | 1.02× |
| `lattice.addBeam({...})` (facade) | bound | **255.12** | **131.63** | **1.94×** |

Raw samples: `sk-0.2-abi-call-cost-before.json`, `sk-0.2-abi-call-cost-after.json`.

**Target met**: `Lattice_AddBeam` at **56.4 ns ≤ 70 ns**.

### Decomposition of the 56.4 ns

`bound` now sits exactly on `direct` (56.39 vs 56.40) — the binding layer contributes nothing
measurable, which is the whole assertion. What remains inside 56.4 ns is:

- the wasm call itself with 7 arguments (2 BigInt handles, 4 f32/f64, 1 bool),
- `PicoGK::Lattice::AddBeam` doing real C++ work — a `Beam` push into a growing `std::vector`.

The 2-argument near-no-work floor for comparison is `Lattice_bIsValid` at **23–25 ns** and
`Voxels_bIsEmpty` at **33–35 ns**. So roughly half of AddBeam's 56 ns is crossing-plus-argument
cost and half is C++ work; there is no remaining JS-side overhead to remove. Going below this
requires a batched entry point (arrays of beams in one crossing), not a cheaper wrapper.

Note `Lattice_bIsValid` **bound** (23.37) measured marginally *below* **direct** (24.99): the
`!!` wrapper is free — V8 inlines it — and the 6% gap is run-order noise at a 4.7 ms window.

### The facade's remaining 75 ns

`lattice.addBeam` costs 131.6 ns against the raw call's 56.4. The ~75 ns difference is
`src/lattice.ts:48-59`: options-object destructuring with three defaults, two `writeVec3`
calls into scratch, and a **fresh `guard()` closure allocated and invoked per call**. That is
now the dominant authoring-side cost and is a legitimate SK-follow-up target — but note the
R11 finding still holds at application scale: all JS-side lattice authoring is <1.5% of HeatX
wall (0.3–0.8 s of 34–421 s), so this is a candidate, not a priority. The `guard()` closure is
the cheapest part of it to remove and is worth ~1.2M allocations per HeatX (see below).

## Macro sanity diff

Standard suite (`node bench/run.mjs`), 1 warmup + 5 measured repeats, 120 phases, diffed
against `sk-0.1-baseline-dlmalloc.json`. Result file: `bench/results/2026-07-26-d8ccfb5.json`.

**Two runs were needed.** The first launched at load 4.92 but the sibling SK-0.7 spike (oneTBB
substrate, separate worktree) spun up four saturated node processes partway through: the
harness's own per-metric telemetry recorded `M12@multi` running at **6.17 → 13.53** loadavg,
and every one of its 12-thread phases duly "regressed" 10–190% while its single-thread twins
stayed flat. That run is not a result and is not the record below. The suite was re-run once
the machine was **sustained quiet** (≤3.0 for a full minute before launch; start load **2.34**,
per-metric `M11` 2.13→2.94, `M12@single` 2.94→3.23, `M12@multi` 3.23→5.56).

**Headline: every macro phase is flat, except the one the change was predicted to move.**

| metric / phase | SK-0.1 baseline | quiet run | Δ |
| --- | ---: | ---: | ---: |
| **M12@single / author** | 406.692 ms | **298.069 ms** | **−26.7%** |
| **M12@multi / author** | 458.735 ms | **339.772 ms** | **−25.9%** |
| M11 / construct | 26195.151 ms | 26230.640 ms | +0.1% |
| M12@single / construct | 55259.545 ms | 55054.722 ms | −0.4% |
| M12@multi / construct | 34664.796 ms | 34525.107 ms | −0.4% |
| M9 / raw10k *(retained ccall)* | 15.652 ms | 15.609 ms | −0.3% |
| M9 / facade10k *(direct)* | 15.673 ms | 14.997 ms | −4.3% |
| M3@0.25 / render | 107.614 ms | 105.197 ms | −2.2% |
| M10@multi / render | 12.813 ms | 12.885 ms | +0.6% |
| M14 / gen2 | 5774.498 ms | 5858.603 ms | +1.5% |

M9 is the built-in canary: `raw10k` (a deliberately retained ccall) sat **0.3% off** its
baseline while `facade10k` — the same query through the new bindings — moved **−4.3%**. The two
rows were dead level at SK-0.1 (15.652 vs 15.673). Small, as designed: `bIsEmpty` on a real
sphere field is ~1.6 µs of C++ against a ~65 ns boundary delta.

### The `author` win is quantitatively accounted for

`author` is HeatX's pure-JS lattice construction. Counted directly (probe: wrap
`session.createLattice`, run the Task): **37 lattices, 1,197,460 `addBeam` calls, 0
`addSphere`**. R11's "~10⁵ beams" was an order-of-magnitude gloss — the real figure is 1.2M.

- predicted: 1,197,460 × 123.49 ns (the measured facade delta) = **147.9 ms**
- observed: 431.614 → 298.069 ms = **133.5 ms** against the *same-wasm-artifact* 2026-07-23
  baseline, or 108.6 ms against SK-0.1's differently-built artifact.

Observed is 73–90% of predicted, which is the expected direction: the microbench measures a
tight monomorphic loop with hot caches, while real authoring interleaves the ShapeKernel
geometry math between crossings. The win is the change's predicted effect, at the predicted
magnitude, at application scale.

### The 16 phases outside ±10%

Two are sub-1 ms timer noise (`M12@single/unattributed`, `M6/bulk`). **Twelve are faster**
by 10–26% — the two `author` rows plus ten small `M12@multi` boolean/finishing stages, which
this quieter run beat. Two moved up:

- **`M1/instantiate` +13.3%** — a **wasm artifact confound, not this change**. SK-0.1's baseline
  was taken on its own freshly-built dlmalloc `pico.wasm` (5,835,150 B); this tree ships the
  5,835,133 B artifact. On that shipped artifact the 2026-07-23 baseline recorded **9.223 ms**
  and this run **9.347 ms** — **+1.3%**. Both runs of this spike reproduced the same +13/+16%
  against SK-0.1 and ~+1% against the same-artifact baseline. (SK-0.1 established the two
  artifacts are output-identical; they are evidently not codegen-identical.)
- **`M12@multi/kernel:splitters.union` +17.9%** (1.929 → 2.275 ms) — a ~2 ms 12-thread stage
  whose SK-0.1 samples already spanned 1.444–2.206 ms. Noise on a small MT stage, and one
  `Voxels_BoolAdd` crossing: the change made that crossing ~120 ns cheaper, so a 0.35 ms move
  is 3,000× too large to attribute to it in either direction.

## Byte parity

The L0 CPU-strict oracle is untouched — as it must be, since the wasm binary is literally the
same file and no argument value changes on the way in.

| check | result |
| --- | --- |
| full suite | **455 passed / 49 files** (453 at SK-0.1 + 2 new generator assertions) |
| byte-locked fixtures | **unchanged**, `git status test/fixtures/` empty |
| browser gate (`npm run test:browser`) | **ALL ENGINES PASS** — chromium / webkit / firefox, 17/17 each |
| `npx tsc --noEmit` (src, test, bench, demo, examples, spikes) | clean |
| `test/surface-manifest.json` | **unchanged** — exact key-set equality against the live facade graph still holds |
| `npm run build` (tsdown, 30 dist files) | clean |

Byte-locked fixture checksums (unchanged before → after):

```
56298c702d37ed991180117019e16edf584d2f01291b34e327053ec1d74c2eec  test/fixtures/helixheatx.json
9e360d57ee590b2d3bc0ea26620eaad182ec7e0e5477904586e9d09705af6c0a  test/fixtures/latticelibrary-examples.json
b120759423e59d2319626719cf1222adf003a2f0a2213ec96a2978913ec9f1c0  test/fixtures/quasicrystals.json
5a5ee9da71e7f6920e9cc6db0f85eae0e263a350a0af8cd054729d291f718749  test/fixtures/roverwheel.json
52e2702d51b41b2b2dc18a67de1b15628ff536f78f929d25266d4ce94504218f  test/fixtures/shapekernel-examples.json
08c9a479c2e225cbcc35699422865a93998956c4e2be8e0c1c76805d6fe926b6  test/fixtures/simulation.json
```

### Artefact checksums (sha256)

```
70304cfe70a0dc93adf7a4f8c294845cc63af163b8483ecf57697cfcf1794744  src/pico.wasm            (5,835,133 B)
fc9cf68f31a521b08ae5d56e6b5d3bdd3c4dda099b79278574d828f08a54777c  src/pico-multi.wasm
b149c5e769671439cbc81b08bd5e872c1027b1be4b94ee7b9129510cd26193bb  src/raw.generated.ts     (post-change)
13de0913299cfd7a3f687926911750a5c180faa3402c09ea07bc33bb1df9ea45  bench/results/2026-07-26-d8ccfb5.json
219fc7786995e21e03b34bcda6af63f1d1a6f3f25e6eaf0575fc251258c71d0b  bench/results/webgpu-v2/sk-0.2-abi-call-cost-before.json
6ee4c83f5193465addf4a3d67ead25a59b9385e7b682d60aedf96b11008ca5c2  bench/results/webgpu-v2/sk-0.2-abi-call-cost-after.json
```

Both wasm artefacts are the ones this tree already shipped — **no rebuild occurred**, and both
microbench runs report the same `pico.wasm` sha256 in their own fingerprint blocks. The
contaminated first macro run is deliberately **not** committed: it was overwritten in place by
the quiet re-run at the same result path.

The browser gate matters more than usual here: it proves the direct-export table binds and
runs on three independent engines, not just V8, including the exact-hex-float oracles
(`sphere volume EXACT vs node`, `tape gyroid volume EXACT vs node`).

## New standing guards

- `test/generate-raw.test.ts` — *no binding goes through ccall/cwrap*; *boolean returns keep
  the i32 → boolean coercion*, including "the wrappers must not spread" (a rest-arg wrapper
  would silently reintroduce a per-call allocation on 20 exports).
- `bench/abi-call-cost.mjs` — the three-variant canary. `bound` drifting off `direct` means the
  generator regressed.
- `bench/run.mjs` M9 — `raw10k` is now a **deliberately retained ccall**, held fixed so the
  metric's history stays comparable. It is a *weak* canary and is documented as such: the two
  rows sit within a few percent, because `bIsEmpty` on a real sphere field costs ~1.6 µs of
  C++ and the ~65 ns boundary delta disappears into it. The isolated per-call number is
  `bench/abi-call-cost.mjs`'s job, not M9's.

## Surprises

1. **The census was 143/147, not 139/143** (charter estimate). The four fast-path survivors are
   exactly the four exports that take no handle — the split was structural, not incidental.
1. **HeatX makes 1,197,460 `addBeam` calls, not ~10⁵.** The long-standing R11 figure is off by
   an order of magnitude. It does not change R11's conclusion (authoring is still <1.5% of
   wall) but it does change the arithmetic on every per-call claim about this workload, and it
   is why the `author` phase moved 26% on an ABI-only change.
2. **No rebuild was needed.** The audit framing implied a build-flag change (`EXPORTED_FUNCTIONS`);
   in fact `src/pico-exports.txt` was already complete and the slow path was entirely a JS
   binding choice. Nothing in `scripts/build-deps-wasm.sh` or the link step was touched.
3. **`cwrap`'s wrapper is worse than raw `ccall`.** `bound` (176.6) was consistently *above* the
   hand-built `ccall` reference (154.3) on AddBeam — `cwrap`'s fallback is
   `(...args) => ccall(...)`, so demoted bindings pay a rest-array allocation and an extra frame
   *on top of* the marshalling. Removing it recovered more than the ccall/direct gap alone.
4. **The generator architecture ported cleanly.** The signature table it already emitted carried
   exactly the metadata the direct path needs (names, and which returns are boolean); the
   emitter shrank rather than grew. The one thing that had to be kept was the boolean
   coercion — everything else `ccall` was doing for these signatures was work that did not need
   doing.
