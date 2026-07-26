# WASM runtime: the 4 GiB boundary and the memory64 question

Program-level runtime doctrine, 2026-07-27. Question: is 64-bit WebAssembly
(memory64 / wasm64) genuinely needed to overcome this program's memory-pressure
problems, what does it cost in 2026, and how are those costs overcome by
current best practice? Sibling of `WORKLOAD-EXECUTORS.md` (executor ledger) and
`NON-DETERMINISM.md` (gate regime and lane architecture). Evidence: the SK-0
memory record (`bench/results/webgpu-v2/SK-0.1.md`, `SK-0.9.md`,
`bench/BENCHMARKS.md` R12), the B6 memory-pressure corpus axis
(`docs/research/picogk-webgpu-iteration-2-blueprint.md`, carried by the V2
spike charter), the vendored toolchain itself (`vendor/emsdk` @ emscripten
5.0.1), the ~15 wasm-substrate documents in `docs/research/`, and a 2026 web
survey (engine status, toolchain maturity, alternatives — URLs in §7).

## Verdict (executive)

**wasm64 is not needed now, and it never delivers the diagnostic case that
motivated this document. It is needed *eventually* — as a demand-selected
"large" artifact lane, not as a default — because the measured demand curve
crosses the wasm32 ceiling exactly one cell below the current corpus edge and
no wasm32-preserving mitigation reaches ≤0.3 mm single-session workloads.**

Three load-bearing facts:

1. **The product band fits; the next band does not.** HeatX peaks at 2.59 GiB
   at 0.5 mm and fails at 0.4 mm on both allocators (SK-0.1). The user-priority
   0.5–1.0 mm band is comfortably inside the ceiling (R12). Extrapolating the
   measured curve, 0.4 mm demands ~4.4 GiB, 0.3 mm ~9 GiB, 0.2 mm ~23 GiB
   (§2.1) — the first is winnable by a wasm32 memory diet, the second is not,
   and the third exceeds even wasm64's 16 GiB browser cap without out-of-core
   help.
2. **wasm64 does not buy the ASan case.** SK-0.9 §6 rejected ASan partly
   because its shadow map cannot fit a 2.7 GiB run under the 4 GiB ceiling —
   but emscripten refuses `-fsanitize=address` under MEMORY64 outright
   (`vendor/emsdk/upstream/emscripten/tools/link.py:764`: "MEMORY64 does not
   yet work with ASAN"; upstream emscripten#21029 — the core64 CI modes exclude
   ASan). The diagnostic instruments for big runs remain SK-0.9's debug-fill
   sentinel probe and the **native lane** (the same escape the stock-TBB U20
   reproducer already uses), not wasm64.
3. **The cost side has collapsed into a lane decision.** The 10 %–2× engine
   tax (S6) is real and unretired in 2026, but it is a tax on *runs that would
   otherwise fail*, provided wasm64 is confined to a feature-detected large
   lane. The lane architecture (`NON-DETERMINISM.md` §14.1), the
   artifact-digest cache key, and the Safari-exclusion machinery that
   relaxed-SIMD already requires make a secondary wasm64 artifact the
   *industry-standard* shape (Photoshop and Godot both converged on
   wasm32-primary + escape valve), and the lane is expected **Class 0 on
   geometry** versus the wasm32 default — every allocation-order dependence
   that would have made it diverge was already engineered out (SK-0.4, SK-0.6,
   SK-0.9).

The concrete wiring: three SK-1-class spikes (§6) — a memory-demand-curve
measurement, a MEMORY64 toolchain probe, and an OPFS grid-parking/streaming
spike — with named triggers that promote the wasm64 lane from probed to
shipped.

## 1. What the repo ships today, and what the ceiling actually is

`scripts/build-pico-module.sh:90-92` links every artifact with:

```
-sMALLOC=$MALLOC            # dlmalloc default; mimalloc = knob, currently NO-GO (SK-0.9)
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB
-sSTACK_SIZE=8388608
```

plus `-O3 -msimd128`, and `-pthread` +
`-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency` on the multi variant. This
is already the maximal wasm32 configuration: emscripten's default
`MAXIMUM_MEMORY` is 2 GB, and `-sMAXIMUM_MEMORY=4GB` engages the unsigned-
pointer codegen that unlocked full 4 GiB wasm32 (Chrome M83+/Firefox 2020,
<1 % code-size cost — v8.dev "4GB wasm memory"). There is no flag left to
turn; wasm32 headroom from here is *demand reduction*, not configuration.

Mechanics worth pinning, because they shape every argument below:

- **wasm linear memory never shrinks.** `memory.grow` is monotonic; the
  memory-control proposal's `memory.discard` would relieve resident-set, but it
  is Phase 1 with no engine shipping anything (WebAssembly/memory-control;
  design#1300). Consequence: a session's heap size *is* its high-water mark —
  which is exactly why `bench/heatx-sweep.mjs:105` reads
  `HEAPU32.buffer.byteLength` at end-of-task as the peak, and why one fine-cell
  op permanently inflates a long-lived session.
- **The nominal 4 GiB is not reliably usable.** V8's own guidance is to treat
  allocation failure as a first-class path ("there just won't be enough free
  memory on many users' machines"); Chrome has throttled instances to ~2 GB
  under multi-instance/VA pressure (emscripten#20946); iOS Safari OOMs at
  `WebAssembly.Memory` init with 2 GB maximums on some devices (godot#70621).
  Realistic cross-population planning number: **~2–3.5 GiB**, with our own
  M-series/desktop evidence supporting ~3.5 GiB (mimalloc runs at 3.50 GiB
  passed; SK-0.1).
- **The OOM signature is known and partially hardened**: a failed `_malloc`
  near the ceiling surfaces as `RangeError: offset is out of bounds` from a
  heap view; the facade maps malloc-returns-0 to the typed `PICO_OUT_OF_MEMORY`
  (`src/context.ts:87-95`), but allocation failures *inside* C++ (OpenVDB node
  allocation mid-fill) still abort — R12's failure mode, dying in a *small*
  allocation after long-lived intermediates consumed the heap. wasm-side
  `std::bad_alloc` handling is not a substitute for staying off the ceiling;
  a fill that fails halfway leaves a partial grid no gate certifies.
- **Per-thread stacks and allocator overhead live inside the same 4 GiB**:
  12 × 8 MB worker stacks ≈ 96 MB (`wasm-memory-boundary-deficiency-audit.md`
  A5), mimalloc's segment cache costs +0.26–0.9 GiB at fine cells (SK-0.1
  sweep), and dlmalloc fragmentation near the ceiling makes the last few
  hundred MB unreliable (OCCT's wasm32 port died at ~1.5 GB against a 2 GB
  max — Unlimited3D).

## 2. Question 1 — is wasm64 genuinely needed?

### 2.1 The measured demand curve

SK-0.1's HeatX sweep (dlmalloc, single≡multi peaks within noise) is the
program's demand curve; peaks are linear-memory high-water marks:

| voxel (mm) | peak heap (GiB) | STL (MB) | status |
| ---: | ---: | ---: | --- |
| 1.0 | 0.87 | 93.7 | pinned fixture scale |
| 0.9 | 0.97 | 122.1 | |
| 0.8 | 1.07 | 165.2 | |
| 0.7 | 1.49 | 227.1 | fine-cell identity gate scale |
| 0.6 | 1.67 | 328.0 | |
| 0.5 | 2.59 | 502.4 | **last passing cell** (2.68–2.74 GiB in SK-0.9 probes) |
| 0.4 | — | ~785 est | **fails, both allocators** (`RangeError`; SK-0.1 B6) |
| 0.3 | — | ~1,400 (published) | fails (R12; "~4.6× the 0.5 mm narrow-band footprint") |
| 0.2 | — | 3,400 (published) | fails a fortiori (published native: 1240 s) |

The local scaling exponent is not constant — ln-ratio slopes run 1.6 (0.7→0.5)
to 2.4 (0.6→0.5) as fixed overheads amortize away and the surface-dominated
narrow band (( 1/h )²) mixes with volume-scaling intermediates (( 1/h )³).
Using the steepest measured slope (2.4, the conservative choice for a capacity
argument):

| cell | extrapolated demand | vs wasm32 (≈3.5 GiB usable) | vs wasm64 (16 GiB JS-API cap) |
| ---: | ---: | --- | --- |
| 0.4 mm | ~4.4 GiB | **over** — consistent with the observed failure | fits easily |
| 0.3 mm | ~8.8 GiB | far over; no diet reaches it | fits |
| 0.2 mm | ~23 GiB | — | **over the 16 GiB cap** — needs out-of-core regardless |

The extrapolation is exactly the kind of number the program's rules say must
be measured, not assumed — hence spike M1 (§6). But the qualitative shape is
already decided by the two measured endpoints: **the ceiling sits one cell
below the corpus edge**, and the published PicoGK workload table (0.2 mm /
3.4 GB STL) extends two more cells past anything wasm32 can hold.

Where the bytes are matters for the mitigation menu:

- **Long-lived grid intermediates dominate.** R12's autopsy: the HeatX
  assembly holds fins + voids + structure grids *concurrently*; death came in
  a small flange-cylinder mesh build after the heap was consumed. This is
  construction-time concurrency, not a single oversized object.
- **Booleans transiently double operands.** The eager whole-operand deep copy
  (2 full-grid materializations per boolean, `WORKLOAD-EXECUTORS.md`
  modify/combine) adds a transient of operand size at exactly the moment the
  heap is fullest. U20's measured −73.7 MB/boolean at 1.0 mm scales to
  GiB-class transients at fine cells.
- **Extraction adds mesh arrays in-heap** (~180 MB at 0.5 mm: 14.8 M f32
  vertices + 30.1 M u32 indices, SK-0.9 §5) before the facade copies them out;
  STL/GLB bytes themselves are assembled **JS-side** (`src/stl.ts`), outside
  linear memory — the export path is already partially off-heap.
- **Allocator overhead is a real term**: mimalloc's +0.66–0.91 GiB at 0.5 mm
  is the difference between 65 % and 87 % of ceiling at the same geometry.

### 2.2 The B6 / product scenarios that exceed 4 GiB

| Scenario | Demand estimate | Evidence basis | Verdict |
| --- | --- | --- | --- |
| HeatX-class assembly ≤0.4 mm | 4.4–9 GiB (0.4–0.3 mm) | SK-0.1 sweep + slope | **exceeds wasm32**; 0.4 mm marginal-winnable by diet (§4.3), ≤0.3 mm is not |
| 10⁷-beam lattice | tube-complex peak scales linearly from **+61.6 MiB @10⁵ beams** (thread-count-independent, SK-0.4) → **~+6 GiB @10⁷**, before authoring storage (~10⁷ × (32 B staging + ~60 B upstream `shared_ptr`/`LatticeBeam`, U18) ≈ 0.9 GiB) and the voxel grids themselves | SK-0.4 §7; SK-0.3/U18 | **exceeds wasm32** at 10⁷; HeatX's real count is 1.2×10⁶ (SK-0.3), so this is one order of growth away, not two |
| Assembly-scale booleans | operand + result + eager copy ≈ 3× largest grid transient | WORKLOAD-EXECUTORS booleans row | borderline; **T6 `.consume()` / `csgUnionCopy` fixes this without wasm64** — it is a deficiency, not a capacity case |
| ASan-instrumented fine-cell run (diagnostic) | 2.7 GiB run × ASan's ~2–3× (shadow ⅛ of address space + redzones + quarantine) ≈ 6–9 GiB | SK-0.9 §6 | **not served by wasm64 at all** — emscripten hard-errors on MEMORY64+ASAN (§2.3) |
| mimalloc re-enablement headroom | +0.26–0.9 GiB on top of any of the above | SK-0.1 | comfort, not need — and currently moot (SK-0.9 NO-GO on correctness) |

### 2.3 Product need vs diagnostic need vs headroom comfort

**Product need — real but not current.** Every shipping product surface today
operates at 0.5–1.0 mm (R12: "the user-priority 0.5–1.0 mm band is comfortably
inside the ceiling"). The B6 axis exists precisely because GPU-resident relief
is chartered as a *capacity* thesis; nothing in the current corpus requires
>4 GiB. The need materializes on any of: sub-0.45 mm production cells,
≥5×10⁶-beam lattices, or multi-part assembly sessions that accumulate
high-water marks (memory never shrinks — one fine-cell op strands the
session's heap at peak forever).

**Diagnostic need — mooted for wasm64.** SK-0.9 §6's three-count rejection of
ASan stands, and the toolchain adds a fourth: the vendored emscripten 5.0.1
*refuses to link* MEMORY64+ASAN (`tools/link.py:763-764`), and upstream's
wasm64 CI modes exclude sanitizers (emscripten#21029, still open 2026).
`-sSAFE_HEAP` under MEMORY64 also carries an open bug (#25127). So the
"rebuild big and sanitize" fantasy has no toolchain under it. The actual
diagnostic ladder for memory bugs at scale is unchanged: (1) SK-0.9's
debug-fill sentinel probe (memset suspect arrays to a recognizable pattern,
assert no sentinel survives — allocator-preserving, one rebuild); (2) the
patch-toggle matrix (SK-0-P0 shape); (3) the **native build** — PicoGKRuntime
+ OpenVDB compile natively, native ASan/TSan have no shadow ceiling, and the
program already committed to a native reproducer for U20
(`NON-DETERMINISM.md` §11.3). wasm64 contributes nothing to this ladder.

**Headroom comfort — real, small, and purchasable cheaper.** mimalloc's
footprint, 8 MB thread stacks, growth-near-ceiling fragility: all are
addressed by the already-registered wasm32 items (A5 stack trim, T8 initial
sizing, R12's dispose discipline) at zero engine tax.

**Answer: yes, wasm64 is genuinely needed — for the ≤0.4 mm and 10⁷-beam
demand curves only, on a horizon the operator controls, and for nothing else
currently named.** The diagnostic argument, which motivated this document,
is definitively *not* a wasm64 case.

## 3. Question 2 — what wasm64 costs in 2026

### 3.1 The bounds-check tax: 10 % mean, 10 %–2× tail, unretired

wasm32 engines bounds-check for free: a 4–8 GiB virtual reservation guarantees
any 32-bit index lands in guarded address space, and OOB traps via signal
handler. A 64-bit index can address anything, so that trick dies and engines
insert per-access machinery. Current published numbers (no 2025–2026 refresh
supersedes them; both engine teams still cite them):

- **SpiderMonkey** (spidermonkey.dev, 2025-01-15, "Is Memory64 actually worth
  using?"): 10 % to >100 % (2×) slower, workload-dependent; explicit
  conclusion — "the only reason to use Memory64 is if you actually need more
  than 4 GB."
- **V8** (WebAssembly/memory64#31, emscripten suite): mean ≈ **10 %** slower,
  worst cases 1.16–1.37×, code size +10–15 %. V8 shipped
  trap-handler-based memory64 bounds checking before enabling by default:
  the index is **clamped with `cmp`+`cmov` (x64) / `Cmp`+`Csel` (arm64)**
  against memory size and a 32 GiB guard reservation converts OOB to a
  signal-handled trap — branch-free, Spectre-conscious, but the cmov still
  lengthens the load's dependency chain versus wasm32's zero-cost check.
- Academic bracket (IISWC'22 "Leaps and bounds"): explicit bounds checks can
  cost up to 6.5× in the worst configurations vs guard-page wasm32's ~20 %-of-
  native; this is the ceiling wasm64 codegen risks on hostile access patterns.

For this codebase the workload profile is dense typed-array-style access over
OpenVDB leaves and tape evaluation — the memops/matrix end of the V8 table
(~1.16×) is the honest planning number for hot loops, ~1.10× overall. Note
the tax lands on the *CPU lanes the program just spent SK-0 accelerating*: a
1.10–1.16× tax claws back roughly half of, e.g., SK-0.6's extraction repair.

### 3.2 Pointer bloat on OpenVDB trees — bounded by leaf dominance, exact on internal nodes

In-memory pointers double (4→8 B). Where it bites, from the vendored headers
(`build/wasm-prefix-mt/include/openvdb/tree/`):

- **InternalNode slot arrays double exactly.** `InternalNode::mNodes` is an
  array of `NodeUnion<ValueType, ChildNodeType>` — `max(sizeof(ptr),
  sizeof(float))` = 4 B on wasm32, 8 B on wasm64. Default `FloatTree`
  (5,4,3): a level-2 internal node's union array goes 128 KiB → 256 KiB, a
  level-1 node 16 KiB → 32 KiB.
- **LeafNodes barely move.** A leaf is dominated by its 512 × f32 buffer
  (2 KiB) + masks; per-leaf pointer overhead is a handful of words. Narrow-
  band level sets are leaf-dominated by construction, so the tree-wide delta
  is the internal-node fraction — order **+5–10 %** of grid bytes, plus
  allocator chunk-header growth.
- **Beam storage doubles its pointer part**: upstream `Lattice` holds
  `std::vector<std::shared_ptr<LatticeBeam>>` (U18) — control blocks and
  vector slots are all pointers. At 10⁷ beams that is another ~100–200 MB of
  pure width tax. (U18's flat-storage fix deletes this term for both worlds.)
- Mesh/STL arrays (f32/u32) and the tape stream are width-invariant.

The irony is worth recording: **wasm64 slightly raises the demand curve it
exists to escape** (+5–10 % on grids, +10–15 % code). Fine at 16 GiB; not
free.

### 3.3 The 16 GiB cap — wasm64 is not "unlimited"

Both Chrome and Firefox cap memory64 memories at **16 GiB** via the JS API
(`kV8MaxWasmMemory64Pages` = 262,144 pages, verified; SpiderMonkey
ByteLengthLimit 16 GB; raising it is tracked in WebAssembly/spec#1892). The
0.2 mm HeatX cell (~23 GiB extrapolated) exceeds it. wasm64 moves the ceiling
one workload class out — it does not abolish ceilings, and out-of-core (§4.3)
remains the only unbounded answer.

### 3.4 Boundary and glue costs: BigInt at every pointer crossing

Under MEMORY64=1 every pointer/`size_t` crossing the JS boundary is an i64 →
**BigInt** (the setting implies `WASM_BIGINT`, already our default). Emscripten
marshals pointers as "i53" doubles where declared (`-sSIGNATURE_CONVERSIONS`,
`p` type), which is sound to 2⁵³ and avoids BigInt allocation on declared
sites — but hand-written glue that assumed Number pointers breaks (the OCCT
wasm64 port's chief pain; emscripten#16975). Our exposure is structural but
small: handles are *already* `bigint` end-to-end (SK-0.2's direct-export
binding relies on it — zero conversion), and the pointer-typed surface is the
generator's `'number'`-typed buffer args (`scripts/generate-raw.mjs`) plus
`addFunction` signature strings (`'fi'` → pointer-bearing under wasm64) — the
"31 u32-pointer sites + addFunction sigs" W1 T7 flagged. This is a mechanical
audit, not a redesign; SK-0.2's 56.4 ns/33.1 ns crossing numbers must simply be
re-measured on the wasm64 artifact (M2 exit assertion, §6).

### 3.5 The engine floor: no Safari, and none announced

Memory64 is a Wasm 3.0 standard (2025-09-17) shipped in **Chrome 133**
(2025-02), **Firefox 134** (2025-01), **Node 24**, Deno 2.2, wasmtime 30 —
and **not in any Safari through 26.5 / the Safari 27 beta** (caniuse; WebKit's
26.0 and WWDC26 feature posts are silent; JSC has a `useWasmMemory64` option
and active commits, but Safari 27's headline wasm feature is JSPI, not
memory64). The vendored emscripten's feature matrix says it plainly:
`Feature.MEMORY64: safari: UNSUPPORTED` (`tools/feature_matrix.py:97-102`).

Consequences: a wasm64 artifact **cannot be the default** for a
browser-delivered product; the three-engine browser gate
(`scripts/browser-gate.mjs` — chromium + webkit + firefox) can only ever run a
wasm64 lane on two engines; and the failure mode is module rejection at parse,
exactly the class the repo already handles for relaxed-SIMD
(`safari-wasm-relaxed-simd-incompatibility.md`: Safari rejecting
`-mrelaxed-simd` modules is why that flag is "last" and artifact-paired).
Same disease, same cure: feature-detect and select the artifact.

### 3.6 Artifact-matrix multiplication

`NON-DETERMINISM.md` §9 prices the dual-support cost of the fast lane at +2
artifacts and +2 dep prefixes *only at the relaxed-SIMD flip*. A wasm64 lane
compounds this:

| Item | Delta for a wasm64 "large" lane |
| --- | --- |
| wasm artifacts | **+1** (`pico-large-multi.wasm` — MT only; a serial wasm64 artifact has no consumer: L0 stays wasm32 by definition, and a capacity lane that runs 2–3× longer single-threaded is self-defeating) |
| dep prefixes | **+1** (`wasm-prefix-64-mt`: wasm32/wasm64 objects cannot link together — emscripten#19847 — so oneTBB + OpenVDB archives rebuild under `-sMEMORY64`; the H1/H1b stale-prefix hazards apply verbatim) |
| glue | pointer-signature audit (§3.4) + loader feature-detection branch (wasm-feature-detect ships a memory64 probe) |
| byte pins | zero — all pins attach to L0 (wasm32 serial), untouched |
| oracles | +1 cross-lane G0 identity check (large vs default at pinned + fine cells) |
| browser gate | wasm64 lane runs chromium + firefox only; webkit row is structurally absent until Safari ships |
| CI wall | + one suite pass on the large artifact (bounded by the same nightly/per-commit split as the fast lane) |

Determinism is the non-cost worth stating: wasm64 changes **no arithmetic**
(same IEEE ops, `-msimd128` unchanged and orthogonal — no documented
memory64×SIMD interaction), only addresses and pointer widths. Post-SK-0.6
(allocation-order-independent extraction), post-SK-0.4 (deterministic-reduce
lattice), and with booleans on the eager-copy path, the wasm64 lane is
expected **Class 0 on the G0 identity tuple** against the wasm32 default —
run-to-run, single≡multi, and cross-lane. That expectation is exactly M2's
acceptance assertion, and it means the lane adds an artifact axis but *not* a
determinism axis to the `NON-DETERMINISM.md` matrix. (Threads are fine:
shared i64 memories are in the standard and shipped with it; emscripten
pthreads+MEMORY64 is CI-tested; COOP/COEP requirements unchanged.)

### 3.7 Toolchain-maturity ledger (2026-07)

| Component | wasm64 status | Source |
| --- | --- | --- |
| emscripten core | **Mature.** Non-experimental since 3.1.72 (2024-11, phase-4 vote); full core64 CI incl. pthreads/SIMD/dynamic linking; `-sMEMORY64` deprecated in favor of `-m64`/`--target=wasm64` in 6.0.1 (spelling only). Vendored 5.0.1 carries full support (`settings.js:261`, `MEMORY64=1|2`) | ChangeLog; settings.js |
| `MEMORY64=2` | wasm64 for clang/lld, lowered to wasm32 by Binaryen — a **64-bit-cleanliness test mode** on wasm32 engines, effectively link-time-only (one set of `=2` libs serves both final modes) | settings.js:255-261; emscripten#26263 |
| dlmalloc / mimalloc | Both build under `-m64` (plain base-cflags inheritance in `system_libs.py`); **no documented mimalloc×MEMORY64 incompatibility, but no production testimony either** — "builds, lightly battle-tested" | system_libs.py:72-73; issue search |
| ASan / SAFE_HEAP | **ASan excluded** (link.py:764; #21029); SAFE_HEAP has an open wasm64 bug (#25127) | vendored source; tracker |
| pthreads + SAB | Works, CI-tested; shared i64 memories shipped with the proposal | #24630, #26017 |
| Embind | Flakiest area (Promise→BigInt #25468, std::string #24323) — **we don't use embind**; not our exposure | tracker |
| emdawnwebgpu | **Explicitly supports MEMORY64** (README lists it among depended-on settings; pointers marshal as i53/BigInt; `NULLPTR = 0n`); buffer mapping is the same 1-copy heap-shadow under either width | dawn src/emdawnwebgpu/README.md; library_webgpu.js |
| oneTBB / OpenVDB | No *official* wasm64 claim from either upstream; expect pointer-cast warnings and `size_t` audits, same class as the existing wasm port work. Triple: `wasm64-unknown-emscripten`, `CMAKE_SIZEOF_VOID_P=8` | oneTBB WASM_Support.md; Emscripten.cmake |
| Node | Native memory64 needs Node ≥24 (emscripten's embind tsgen self-lowers below that); repo floor is already Node 26.x | link.py:2031-2037; test suite |
| Precedent | **OCCT/DRAWEXE** shipped a working wasm64 CAD build (>4 GB verified; BigInt-glue and dep-rebuild pain documented); **Godot 4.7** ships optional wasm64 web export; **Photoshop deliberately stayed wasm32** + OPFS paging; Unity: nothing | Unlimited3D 2025-02; godot#102378; Chrome dev blog |

The toolchain is not the blocker. The blockers are Safari, the tax, and the
fact that nothing in the current corpus needs it yet.

## 4. Question 3 — how the costs are overcome by 2026 best practice

### 4.1 The hybrid pattern: wasm32 default + demand-selected wasm64 "large" lane

The pattern actual shippers converged on (Photoshop: wasm32+OPFS; Godot:
wasm32 primary, wasm64 opt-in export; engine teams' unanimous guidance) maps
onto this program's existing lane architecture with almost no new design:

- **A lane is a named artifact bundle** (`NON-DETERMINISM.md` §14.1), chosen
  at `createPico()` — session-scoped because allocator/codegen are link-time.
  `'large'` becomes a third bundle: the wasm64 MT artifact, selected when
  (a) the environment supports memory64 (feature-detect probe) and (b) the
  session declares a demand hint (`createPico({ lane: 'large' })` explicit,
  or `'auto'` promoting on a declared workload bound — *never* mid-session,
  because memory never shrinks and artifacts don't hot-swap).
- **Cache keys are already correct**: the key captures wasm artifact digests
  (`kernel-worker.ts` per §14.1), so wasm64-lane results key separately for
  free; `laneId` should still name it explicitly per the §14.1 composition
  rule. Expected Class-0 geometry (§3.6) means cross-lane cache poisoning is
  a non-issue *once M2 proves the identity*, but the key separation stands
  regardless — that is the §14.1 discipline.
- **Fallback is graceful by construction**: no memory64 → wasm32 artifact +
  the §4.3 diet + a typed `PICO_OUT_OF_MEMORY` at the old boundary. Safari
  users get exactly today's envelope.
- **The tax becomes rational**: 10–16 % slower applies only to sessions that
  would otherwise *fail*. Against a `RangeError` at 60 % of a 5-minute build,
  1.16× is not a cost, it is the product.

### 4.2 Per-cost mitigation table

| Cost (§3) | 2026 best practice | Already in repo discipline? | Residual |
| --- | --- | --- | --- |
| 10 %–2× engine tax | confine to the large lane; V8's cmov+guard codegen (shipped) holds the mean near 10 % | lane architecture exists (§14.1); artifact selection precedent = relaxed-SIMD pair | ~10–16 % on lane users; L0/default untouched |
| Pointer bloat | leaf-dominated data structure (nature of narrow-band VDB); U18 flat beam storage kills the worst `shared_ptr` case; 32-bit *indices* stay 32-bit (tape slots, IndexGrid, NanoVDB-style linearization) | U18 filed; index-based GPU substrate already chartered (S-A) | +5–10 % grid bytes on the lane |
| 16 GiB cap | treat wasm64 as one-workload-class relief; out-of-core beyond (§4.3) | B6 axis already frames capacity as tiered | 0.2 mm-class needs out-of-core regardless |
| BigInt boundary | `p`-type signature conversions (i53); direct-export binding pattern | SK-0.2 landed the binding layer; handles already bigint | audit of ~31 pointer sites + `addFunction` sigs (M2) |
| Safari absence | feature-detect + artifact selection; wasm32 fallback | browser-gate + relaxed-SIMD machinery | large lane is 2-engine until JSC ships (`useWasmMemory64` exists; watch WebKit) |
| Artifact matrix | MT-only large artifact (+1, not +2); prefixes rebuilt once; pins zero-change (all on L0) | §9 dual-support framework prices it | +1 artifact, +1 prefix, +1 CI pass |
| Toolchain edges | vendored emsdk pins the toolchain; `MEMORY64=2` builds as a cheap 64-bit-cleanliness CI canary without shipping anything | H1/H1b rebuild hygiene documented | oneTBB/OpenVDB wasm64 patches are ours to carry (upstreamable) |

### 4.3 The alternatives that keep wasm32 (and what each actually reaches)

**(a) Memory diet — the first claim on the 0.4 mm cell.** Ranked by measured
or estimated yield: T6 `.consume()`/`csgUnionCopy` (kills the boolean double-
materialization — the single largest *transient*; already chartered, gated on
§11.3); explicit intermediate disposal in subjects (R12 names it, costs C#
port fidelity — make it a documented subject-side option, not a runtime
change); A5 thread-stack trim (~84 MB); streaming export (STL is already
JS-side; keep it there and stream to OPFS for the 1.4–3.4 GB cells so the JS
heap doesn't blow instead); mimalloc-off (already default). Honest estimate:
diet moves the boundary from 0.4 to ~0.35 mm — one cell, no further. M1
measures instead of estimating.

**(b) GPU-resident intermediates — the chartered B6 thesis.** Parking grids
in WebGPU buffers puts them outside linear memory: desktop adapters reach
multi-GB `maxBufferSize` after explicit limit requests (Apple M-series:
`maxBufferLength`-derived, unified-memory-scaled; spec defaults are only
256 MiB/128 MiB — request limits at `requestDevice`). This is SK-3.2
residency work already chartered, and NanoVDB's 32-bit-offset linearized
grids are precisely the shape that avoids re-inflating pointers on the way.
Limits: per-binding caps force chunked bind groups; data must round-trip
(1-copy floor, `wasm-memory-boundary-deficiency-audit.md` B1/B7) for every op
not yet ported; mobile adapters give little. GPU residency relieves the
*resident* set; it does not let an un-ported CPU op operate on an evicted
grid.

**(c) OPFS out-of-core — the proven unbounded path, with a construction-time
caveat.** Photoshop's scratch-disk-on-OPFS is the production precedent for
"documents larger than the address space"; `createSyncAccessHandle` sustains
~1 GB/s in a worker (NVMe-bound); emscripten's WasmFS has an OPFS backend so
C++ file IO can hit it directly. OpenVDB brings native machinery: **delayed
leaf loading** (leaf buffers marked out-of-core on read from a mapped
`io::File`, materialized on first access, `Tree::unallocatedLeafCount()`
observable) plus half-float and Blosc-paged leaf compression. The caveat that
decides where this applies: delayed load keys off `io::MappedFile` — real
mmap, which the browser does not have; emscripten emulates mmap by
read-into-heap, which defeats the purpose naively, so a real shim = OPFS
sync-handle pread behind a MappedFile-compatible interface (M3 probes exactly
this). **And delayed loading is a read-path feature** — our OOM is
construction-time concurrency (§2.1). The applicable pattern is therefore
**grid parking**: serialize completed intermediates (fins grid while voids
build) to OPFS, free... except wasm memory never shrinks — parking caps the
*concurrent working set growth* and future sessions' high-water, not the
already-grown buffer. Parking pays serialize/deserialize at ~1 GB/s against
grids that took 10–100 s to build — sub-5 % wall for GiB-class grids. It
composes with wasm64 (out-of-core past 16 GiB) rather than competing.

**(d) Worker heap partitioning — for sharded products, not for one kernel.**
N workers × ≤4 GiB works in Firefox; **Chrome has throttled every instance to
~2 GB under aggregate pressure** (emscripten#20946, undocumented heuristic,
unresolved) — so budget half the naive arithmetic. No shared pointers:
cross-shard traffic is `.vdb`/transferable bytes. This fits *session-per-part*
product shapes (Tau already isolates kernels per worker session) and does
nothing for one 9 GiB HeatX assembly whose grids must meet in one boolean.
DuckDB-wasm and sqlite-wasm — the "big data in wasm32" citations — actually
use out-of-core (c), not sharding; the published pattern agrees with our
ranking.

**(e) Dead ends, recorded to prevent re-litigation.** **Multi-memory**:
standardized (Wasm 3.0), shipped Chrome 120/Firefox 125, **no Safari**, and —
decisively — no C/C++ toolchain can place data in a second memory (LLVM has
feature plumbing only; emscripten discussion #19208: single unified address
space; `wasm-memory-boundary-deficiency-audit.md` B8 reached the same verdict
for staging). **Custom-page-sizes**: Phase 3, aims *downward* (sub-64 KiB
pages for embedded); explicitly does not raise the 4 GiB wasm32 ceiling.
**Memory-control / `memory.discard`**: the only proposal that would ever let
linear memory shrink — Phase 1, prototype-stage, no browser ships anything;
plan as nonexistent for years (the program already tracks it for the GPU
mapping mode, B3). **JS-side ArrayBuffer overflow slabs**: real pattern
(outside linear memory, renderer-limited), but strictly dominated for us by
(b) and (c) — same copy-in/copy-out with less capacity than OPFS and less
compute adjacency than GPU buffers.

## 5. Question 4 — verdict and program wiring

### 5.1 The recommendation

1. **Do not build a wasm64 lane now.** Nothing in the shipped corpus or the
   SK-1–SK-3 gates needs >4 GiB; the diagnostic case is toolchain-void; the
   default stays `wasm32 -sMAXIMUM_MEMORY=4GB` exactly as built today.
2. **Probe it once, cheaply, so the lane is a decision away instead of a
   porting project away** (M2 below): the toolchain is mature, the precedent
   (OCCT) says the port is mechanical, and the probe converts "we believe the
   lane is Class 0 and ~1.1× slower" into measured fact. A `MEMORY64=2` CI
   canary keeps the tree 64-bit-clean for pennies thereafter.
3. **Spend wasm32 headroom first, in this order**: T6/`csgUnionCopy`
   (transient kill), M1's measured diet items, GPU residency (SK-3.2, the B6
   thesis), OPFS grid parking (M3) — each is either already chartered or
   probed below, each benefits every engine including Safari, and together
   they plausibly hold the entire 0.4 mm band on wasm32.
4. **Promotion triggers** (any one promotes the wasm64 lane from probed to
   built-and-gated):
   - a product fixture whose **measured** (M1) demand exceeds 3.5 GiB after
     the diet items land;
   - a chartered workload class at ≤0.35 mm or ≥5×10⁶ beams;
   - GPU-resident relief (SK-3) measured insufficient for a B6 fixture the
     product actually needs;
   - Safari shipping memory64 (removes the 2-engine asterisk and re-prices
     the lane as a potential future default).
5. **Never**: wasm64 as a performance path (it is a strict slowdown — the
   `WORKLOAD-EXECUTORS.md` measured-dead entry stands, now with this document
   behind it); wasm64 for sanitizers (toolchain-refused); multi-memory or
   custom-page-sizes for capacity (dead ends, §4.3e).

### 5.2 Spike shapes for the SK-1/SK-2 charter

| # | Spike | Question | Effort | Exit assertions |
| --- | --- | --- | --- | --- |
| M1 | **Memory demand curve, measured** | per-stage peak-heap attribution (grid / boolean transient / mesh+extract / staging / allocator / stacks) across 0.7→0.35 mm HeatX + a 10⁵→10⁷ beam lattice sweep + a boolean-transient probe; instrument = growth-event hooks + `HEAPU32.buffer.byteLength` high-water per `kernel:*` stage | S | (a) fitted scaling exponent with CI replaces §2.1's 1.6–2.4 spread; (b) per-stage share table at 0.5 mm; (c) diet-headroom number: projected 0.4 mm peak after T6 + disposal + stack trim; (d) B6 fixture demand table (the charter's "peak-heap delta recorded" made systematic) |
| M2 | **MEMORY64 toolchain probe** | build `wasm-prefix-64-mt` (oneTBB + OpenVDB under `-sMEMORY64=1`) + `pico-large-multi.wasm`; audit the ~31 pointer-typed glue sites + `addFunction` sigs; run the suite and the G0 oracle | M | (a) deps + module link, suite green at pin scales; (b) **G0 identity vs the wasm32 default lane** — run-to-run triples, single≡multi, cross-lane, at 1.0 **and** 0.7 mm (ground rule 6); (c) 0.4 mm HeatX **completes**, peak recorded (the capacity claim, demonstrated); (d) M12-class slowdown vs wasm32 measured with CI, quoted against the 10–16 % planning band; (e) SK-0.2 ABI micro re-run on the wasm64 artifact (BigInt/i53 boundary cost); (f) feature-detect + artifact-selection glue demonstrated in the loader; kill = any G0 divergence (would falsify §3.6's Class-0 expectation and demand diagnosis before any lane ships) |
| M3 | **OPFS grid parking + streaming export** | `.vdb` bytes-pointer ABI (A7's fix) → OPFS sync-handle park/restore of a completed intermediate mid-chain; streamed STL sink for ≥1 GB exports; MappedFile-shim feasibility note for delayed leaf loading | M | (a) park→drop→restore→boolean produces the **G0-identical** result vs never-parked (grid-equality, the `.vdb` round-trip oracle class); (b) park+restore wall <5 % of the producing stage's wall at 0.5 mm; (c) streamed STL byte-identical to in-memory export (canonical-serialization rider applies); (d) written verdict on delayed-leaf-loading-in-wasm (shim cost vs WasmFS-OPFS) — build or kill, with numbers |

M1 blocks nothing and should ride the next bench session. M2/M3 are
independent of each other and of SK-1's GPU spikes; neither touches L0.

### 5.3 Amendments to sibling documents

- **`WORKLOAD-EXECUTORS.md`** measured-dead list: the memory64 entry stays,
  reworded to point here — "memory64 as a performance path (10 %–2× engine
  tax; **capacity lane only, demand-triggered — see `WASM-RUNTIME.md`**)."
- **`NON-DETERMINISM.md`** §5 substrate-lever table gains a row: memory64 —
  expected Class 0 (no arithmetic change; addresses engineered out of
  observability by SK-0.4/0.6) — verdict "large-lane only, M2 gates it";
  §14.1's lane enumeration gains `'large'` as an artifact-granularity lane
  with the same session-scoping and cache-key rules as `'fast'`.
- **`docs/research/picogk-cpu-fast-lane-workstream.md`** W1 T7 ("memory64
  build, escape hatch, unscheduled") is superseded by §5.1–§5.2 of this
  document: the escape hatch now has a probe shape, exit assertions, and
  promotion triggers.
- **SK-0.9 §6** gains a rider: route (2) (ASan-shadow-vs-ceiling) is
  permanent, not situational — wasm64 cannot relieve it (link.py:764); the
  sentinel debug-fill probe is the standing instrument at every scale.

## 6. What must never be relaxed (the §13 additions)

- The **L0 oracle lane stays wasm32** even after a wasm64 lane ships: every
  byte pin, the three-engine browser gate, and the GPU bring-up reference
  attach to it, and it must keep running on the one engine wasm64 cannot
  reach.
- **No capacity fix may substitute for the OOM contract**: allocation failure
  surfaces as typed `PICO_OUT_OF_MEMORY` at the facade, never as a partial
  grid — a fill that died halfway is Class X, and no lane, diet, or paging
  scheme is permitted to convert a hard failure into a silent truncation.
- **Fine-cell identity gates run on every lane that claims a cell** (ground
  rule 6): a wasm64 lane that unlocks 0.4 mm runs its triples and
  single≡multi differentials *at 0.4 mm*, not at the scales wasm32 could
  already reach — the U20 lesson (green-and-blind pins) applies with force to
  the first lane whose whole purpose is cells no other lane can check.

## 7. References

In-repo evidence: `bench/results/webgpu-v2/SK-0.1.md` (sweep, peak heap, OOM
boundary, mimalloc overhead) · `SK-0.9.md` §5–§6 (2.68 GiB probe, ASan
rejection) · `SK-0.4.md` §7 (+61.6 MiB @10⁵ beams) · `bench/BENCHMARKS.md`
R12 (0.3 mm autopsy, mitigation list) · `NON-DETERMINISM.md` §9, §14.1 ·
`WORKLOAD-EXECUTORS.md` (measured-dead entry, booleans row, U18) ·
`scripts/build-pico-module.sh` · `vendor/emsdk/upstream/emscripten`:
`src/settings.js:255-261`, `tools/link.py:763-764,1545,1680-1691,2031-2037`,
`tools/feature_matrix.py:97-102`, `tools/system_libs.py:72-73` ·
`build/wasm-prefix-mt/include/openvdb/tree/{InternalNode,LeafNode}.h`.

tau-brain: `docs/research/picogk-webgpu-research-survey.md` S6 ·
`wasm-memory-boundary-deficiency-audit.md` (A5, B0–B8) ·
`emdawnwebgpu-memory-boundary-audit.md` · `picogk-cpu-fast-lane-workstream.md`
T6–T8 · `safari-wasm-relaxed-simd-incompatibility.md` ·
`wasm-heap-view-detachment.md` · `wasm-rab-integration-node-status.md` ·
`picogk-webgpu-iteration-2-blueprint.md` (B1–B9 corpus axes).

Web (cited without ingestion; ingestion-worthy under the rights gate:
spidermonkey.dev post, v8.dev 4 GB post, memory64 Overview.md — all
first-party engine/spec sources):

- Engine status/cost: [spidermonkey.dev "Is Memory64 actually worth using?"](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html) (10 %–2×; 16 GiB cap; "only if you need >4 GB") · [WebAssembly/memory64#31](https://github.com/WebAssembly/memory64/issues/31) (V8 ~10 % mean, +10–15 % size) · [v8.dev 4 GB wasm memory](https://v8.dev/blog/4gb-wasm-memory) · [Wasm 3.0 announcement](https://webassembly.org/news/2025-09-17-wasm-3.0/) · [Chrome 133 intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/5vTbd1dttwc/m/Z4UFehJBAgAJ) · [Firefox 134 intent](https://groups.google.com/a/mozilla.org/g/dev-platform/c/I-MywEnFxKc) · [caniuse memory64](https://caniuse.com/wf-wasm-memory64) (Safari absent through 26.5) · [WebKit Safari 27 beta post](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/) (JSPI, no memory64) · [spec#1892](https://github.com/WebAssembly/spec/issues/1892) (>16 GB) · IISWC'22 "Leaps and bounds" (bounds-check bracket).
- Toolchain: [emscripten ChangeLog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md) (3.1.72 non-experimental; 6.0.1 `-m64`) · [#21029](https://github.com/emscripten-core/emscripten/issues/21029) (ASan×wasm64) · [#25127](https://github.com/emscripten-core/emscripten/issues/25127) (SAFE_HEAP) · [#19847](https://github.com/emscripten-core/emscripten/issues/19847) (no mixed-width link) · [#26263](https://github.com/emscripten-core/emscripten/issues/26263) (`=2` link-time-only) · [emdawnwebgpu README](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/emdawnwebgpu/README.md) (MEMORY64 supported) · [oneTBB WASM_Support.md](https://github.com/uxlfoundation/oneTBB/blob/master/WASM_Support.md) · [Unlimited3D OCCT wasm64](https://unlimited3d.wordpress.com/2025/02/07/wasm64-is-here/) · [godot#102378](https://github.com/godotengine/godot/pull/102378) · [godot#70621](https://github.com/godotengine/godot/issues/70621) (iOS 2 GB OOM).
- Alternatives: [Chrome dev blog — Photoshop OPFS scratch disk](https://developer.chrome.com/blog/how-photoshop-solved-working-with-files-larger-than-can-fit-into-memory) · [emscripten#15950](https://github.com/emscripten-core/emscripten/issues/15950) (WasmFS OPFS backend) · [emscripten#20946](https://github.com/emscripten-core/emscripten/issues/20946) (Chrome ~2 GB/instance throttle) · [emscripten discussion #19208](https://github.com/emscripten-core/emscripten/discussions/19208) (multi-memory unusable from C++) · [custom-page-sizes Overview](https://github.com/WebAssembly/custom-page-sizes/blob/main/proposals/custom-page-sizes/Overview.md) (does not raise the ceiling) · [WebAssembly/memory-control](https://github.com/WebAssembly/memory-control) (Phase 1; `memory.discard`) · [design#1300](https://github.com/WebAssembly/design/issues/1300) (memory never shrinks) · OpenVDB [LeafNode.h delayed loading](https://www.openvdb.org/documentation/doxygen/LeafNode_8h_source.html) + [Compression.h](https://www.openvdb.org/documentation/doxygen/Compression_8h_source.html) (`OPENVDB_DISABLE_DELAYED_LOAD`, `io::MappedFile`) · [MDN createSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle) (~1 GB/s worker sync IO per renderlog measurement) · [duckdb-wasm#1241](https://github.com/duckdb/duckdb-wasm/discussions/1241) (streaming, not sharding) · [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits) (256 MiB/128 MiB defaults; request adapter limits).
