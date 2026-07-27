# Non-determinism: byte parity vs geometry parity as the program gate

Operator-directed analysis, 2026-07-26. Question: is byte parity the correct
overarching constraint on the PicoGK V2 acceleration program, or should the
gate relax to a rigorously designed geometry parity, accepting benign
non-determinism for performance? Evidence: a four-agent review of every compute
entry point in `WORKLOAD-EXECUTORS.md` against the full V1+V2 record (SK-0.1–
SK-0.8, the P0 investigation, the A-audits, the R-surveys, the harmonic
architecture, and the vendored source). Companion column in
`WORKLOAD-EXECUTORS.md` ("Non-det headroom").

## Verdict (executive)

**Byte parity is the wrong program-wide gate and the right per-lane service.**
The correct regime is three-tier and per-op-family:

1. **Exact-geometry identity — never toleranced, all lanes.** Canonical grid
   hash (sorted coord+value), volume as hex float64, triangle/vertex counts,
   order-invariant mesh multiset hash. Applied as run-to-run triples,
   single≡multi differentials, and cross-lane checks, **at fine cells
   (≤0.7 mm) as well as pinned scales**. This is what actually catches races.
2. **SK-0.8-shaped tolerance gates for value-changing lanes** (F CPU-fast,
   L1 GPU-tolerant): volume/area rel ≤3%, bounds ≤1 voxel, narrow-band SDF
   max ≤1 / mean ≤0.25 voxel, `checkLevelSet` EMPTY as a hard boolean, mesh
   validity, analytic cross-scoring where closed forms exist.
3. **Byte identity retained on the L0 serial lane only** — pins, export
   canonicalization, CI anchoring, GPU bring-up oracle. L0 stays dlmalloc +
   `-msimd128` + musl: every existing byte pin attaches to it unchanged, so
   the regime shift costs **zero pin regeneration**.

The product dichotomy the operator sketched (fast non-deterministic agentic
lane / reproducible export lane) is not a new design: the charter's
L0/F/L1/L2 determinism lanes already encode it. The decision being made here
is the **default consumer mapping** — F/L1 primary for interactive/agentic
use, L0 demoted to export, CI, and oracle duty.

Estimated corpus effect of the CPU-side flips alone (§10): **~25–40% wall
reduction on the bench corpus** (≈1.25× on HeatX-class end-to-end MT runs;
2–4× on offset- and extraction-dominated interactive iterations), before any
GPU lane lands. The GPU lanes carry the order-of-magnitude upside they were
already chartered to measure and are *enabled*, not merely permitted, by this
regime — every GPU lane is Class 2 by nature and was never going to pass a
byte gate.

## 1. Taxonomy

Divergence classes (used throughout; from the substrate review):

| Class | Meaning | Example in the record | Admissible? |
| --- | --- | --- | --- |
| 0 | byte-identical | L0 lane; the browser gate's 3-engine hex-float exactness | trivially |
| 1 | identical geometry, permuted bytes (serialization/allocation order) | mimalloc MT STL streams: identical volume hex + 10,048,032 tris, different order (SK-0.1) | yes, under identity oracles |
| 2 | bounded numeric drift, geometry equivalent within gates | GPU f32 crossing lerp; `fastRenorm` FIRST_BIAS (SK-0.8); relaxed-SIMD FMA | yes, under tolerance gates + health booleans |
| 3 | fixed per engine+hardware, varies across engines/machines | relaxed-SIMD by spec; Dawn `math_mode(relaxed)` | per-lane, machine-scoped surfaces only |
| 4 | run-to-run non-deterministic on one machine | GPU atomic-bump arena addresses (values invariant) | only where provably value-invariant |
| X | wrong geometry | U20 merge race (dropped subtrees); U2 seal bug | **never** |

Determinism axes are distinct from classes: run-to-run, build-to-build,
machine-to-machine, engine-to-engine. The fast lane needs **run-to-run
geometry determinism only** (caches, oracles, user trust). The export/CI lane
needs all four axes — and already has them on L0.

## 2. First principles

**What byte parity buys.** (a) A maximally sensitive tripwire with zero
design cost — any behavioral change is detectable. (b) A debugging anchor:
bisection, A≡B differentials, and GPU bring-up against a bit-exact CPU
reference. (c) Content-addressability of artifacts. (d) A trivially cheap
check.

**What it costs, measured.** (a) The mimalloc veto: 1.208× MT construct
[CI 1.171–1.262], 1.998× M10 MT mesh, 4.58× on the largest creation stage —
held hostage by triangle emission order (Class 1). *[ERRATUM 2026-07-27,
SK-0.9: the 0.5 mm MT case was misclassified by everyone including SK-0.1 —
the multiset oracle's first run showed those streams contain NaN-coordinate
records behind bit-identical volume/count/byte-count invariants, i.e.
Class X, a stale-slot read that dlmalloc masks with zero-filled fresh pages.
The mimalloc wins stay unspendable until the defect is rooted; the argument
this paragraph makes survives on the single-thread record, which SK-0.9
showed is now byte-identical cross-allocator. See §11 outcomes and
`bench/results/webgpu-v2/SK-0.9.md`.]* *[ERRATUM TO THE ERRATUM, SK-0.10:
Class X was right, the cause was not. There is no stale-slot read and no
zero-page masking — the NaN records came from `src/mesh.ts` reading its own
staging buffer through a **signed** shift, which goes negative past 2 GiB and
which `subarray` silently clamps. mimalloc only chose the address. Fixed; the
0.5 mm MT case is now Class 0 (byte-identical to the dlmalloc ST reference,
5 runs), so this paragraph's "held hostage by emission order" reading is
restored on BOTH paths and the wins are spendable pending the exit baseline.
See `bench/results/webgpu-v2/SK-0.10.md`.]* (b) The `fastRenorm`
paradox: the byte lock pins HJWENO5×3, which is measurably **slower and less
accurate** than the available SECOND_BIAS×3 (0.094% vs 0.050% volume error
against the closed form, at 2.1×) — SK-0.8's own words: "it is still not the
default, because the default is byte-locked" is the policy under review stated
as a tautology. (c) The algorithm freeze on `RenderLattice`: a run-to-run
deterministic, ~1-ulp-equivalent tube-complex lane measured at up to 20.4× on
the worst serial stage, blocked only by pin-regeneration ceremony. (d) Every
GPU lane, categorically.

**The decisive re-reading of the record.** Both catastrophic catches in this
program's history — the U20 merge race and the dlmalloc fine-cell regression —
were made by **geometry-class invariants (volume hex + triangle count) at
scales the byte pins did not cover**. The byte-locked suite was green for the
U20 defect's entire life ("green *and* blind"); detection came from an
out-of-suite sweep, and the *diagnosis* that exonerated SK-0.6 and localized
the mechanism was carried entirely by geometry deltas (volume moved →
construction, not extraction; triangles always fewer → dropped, not
perturbed). **The binding failure variable was parameter-space coverage, not
gate type.** Conversely the one pure-byte catch (mimalloc ordering) is
precisely the class the operator proposes to stop paying for — and §11 shows
even that catch is not yet safely classified.

**The representation argument.** A voxel kernel's semantic contract is
tolerance-based by construction — the voxel size *is* the tolerance; every
surface it reports is already a reconstruction within a half-voxel band. The
CAD industry's movement from B-rep exactness to implicit/voxel representations
(the operator's framing) is a move to exactly this semantics: mathematically
principled *fields*, sampled at declared resolution. Demanding bit-exactness
of the sampling machinery is a category error as a *product* contract — while
remaining a superb *engineering instrument*. The regime above keeps the
instrument and corrects the contract.

**The counter-argument, honestly stated.** Byte identity is the only oracle
that needs no thought: every geometry gate is a designed artifact that can be
designed wrong (a volume-only gate passes 9% area drift — SK-0.8 measured
exactly that). Two answers: first, the identity tier (tier 1) is *not* a
tolerance gate — it is bit-exact on geometry invariants, order-free only in
serialization, so its sensitivity to real defects matches the byte gate
wherever coverage matches (the P0 table in the modify/combine review shows
detection parity row by row). Second, the tolerance tier is only ever applied
to lanes whose *purpose* is bounded numeric change, and it carries hard
booleans (`checkLevelSet` EMPTY rejected 6 of 8 renorm settings that volume
tolerances passed) — the gate that discriminates is not softer, it is
differently shaped.

## 3. The three hard lessons the gates must encode

1. **Tolerance gates cannot police Class X.** U20's worst run lost 0.64% of
   triangles; its smallest, 0.4% — both comfortably inside any 3% band. Only
   exact identity (run-to-run, single≡multi, cross-build) catches races.
   Therefore: booleans and every order-free-exact op keep **exactness gates**
   (canonical hash, not tolerance). Tolerance applies only where numeric
   change is the *point* (PDE family, GPU f32).
2. **Coverage is the gate's spine.** Every pin at ≥1.0 mm was blind to a
   defect that exploded below 0.8 mm; U2's seal bug is scale-gated the same
   way. Every gate — exact or toleranced — runs at fine cells (≤0.7 mm) and,
   for scale-sensitive semantics, at multiple scales.
3. **The benign/malign boundary is structural and reviewable.** Every safe
   relaxation in the record shares one shape: per-element results under a
   commutative-associative combiner (min/max, single-writer slots, keyed
   outputs). Every Class-X incident involves concurrently mutated shared
   intermediate state with observable consumption order (U20's mask,
   flood-fill sign races). This becomes a design-review gate for all future
   kernels: *no observable consumption order on shared mutable state;
   combiners must commute* — enforced up front, verified by permutation
   oracles (e.g. shuffle beam insertion → identical canonical hash) and
   fine-cell identity triples behind.

## 4. Per-op findings (fleet synthesis)

Full detail in the four review transcripts; the ledger column carries the
per-row summary. Highlights that drive the recommendation:

**Construction** (min-composition and single-writer fills are order-independent
by algebra — determinism is nearly free here; the byte taxes are numeric pins
and algorithm freeze):
- `RenderImplicitTape`: bit-exact MT already; headroom is Class 2 — W1's
  f32x4 tape + vectorized transcendentals (1.3–3× on eval phases; the
  "gyroid unlock": trig is the post-TP7 residue, sin ≈ 7× FMA on Apple) and
  the GPU deep-tape kernel (G1, ≥5× bar). Interval-widening rider mandatory:
  a mis-widened interval evaluator mis-prunes blocks — Class X, not Class 2.
- `RenderLattice`: the sharpest case. Parallel TU ~thread-count (Class 1,
  schedule-independent by the tape-fill proof); tube-complex lane measured
  2.5–4.1× ST / 3.0–20.4× 12T at ~1e-7 rel deltas, 3/3 run-stable (SK-0.4
  records); GPU G4 atomicMin round-cone kernel is order-benign *because min
  commutes*. Byte gate's only contribution here is ceremony.
- `meshToLevelSet`: already MT-deterministic via min-combine; one latent
  tie-order dependence (closest-prim index at exact ties) should be pinned
  (lowest-index rule) before the GPU port. GPU P7 needs a **sign-inversion
  hard gate** (thin-shell fixture) — flood-fill races are this op's Class X.

**Modify/combine**:
- Booleans: **no Class 2 exists** — min/max has no legitimate numeric
  frontier; the geometry gate here is *exact* (canonical hash). The winning
  successor to the reverted U20 design is `csgUnionCopy` (shared-nothing,
  const inputs, thread-local segments + merge — the shape this repo has
  proven deterministic at production scale), which also deletes the facade's
  result clone: better than the reverted design's own ceiling, possibly
  byte-identical anyway post-SK-0.6. U20 itself: close reading of `Merge.h`/
  `NodeManager.h` shows the mask access pattern is *designed* task-confined
  and the patch drove upstream's own code shape faithfully — which elevates a
  third suspect the toggle matrix could not see: **substrate interaction**
  (all four toggle configs ran patched oneTBB on emscripten pthreads). A
  native stock-TBB reproducer (~a day) decides it; upstream `Merge.h` is
  unchanged 122 commits past our pin, so a repro would be a novel upstream
  report.
- Offsets: the money row. Renorm = 93.9–97.5% of the wall; FIRST_BIAS×3
  certified 3.49–3.95×; scheme-swap ceiling 4.2× (measured stencil-cost
  ratio); GPU P5 re-posed per-sweep (17.0/13.2/29.3/43.2 ms bars). The SK-0.8
  gate is the L1 template verbatim, including the load-bearing area metric
  and the hard health boolean.
- `ProjectZSlice`, `bIsEqual`: pure deficiencies — their wins (6–100×
  stage-relative) are Class 1 or gate-independent; no policy question. U2's
  seal fix is the reverse case: a *correctness* fix currently frozen by byte
  pins; geometry pins with semantic oracles (seal-count-correct, per scale)
  survive the bugfix.

**Interrogate/export**:
- `volumeToMesh`: SK-0.6 is the program's proof that Class-1 problems can be
  engineered away at **negative cost** — the deterministic disjoint-slot
  layout *was* the performance fix and *is* the WGSL port's required shape.
  GPU extraction: topology Class 0 (bit-exact f32 compares), positions
  Class 2 confined to two named arithmetic sites, ordering Class 1
  (canonical slots free).
- `fCalculateVolume`: bit-exact hex at ~zero cost — **the program's cheapest,
  strongest canary; keep exact on every lane.** Same for `GetProperties`
  (five hex pins; it is the L1 gate's own measuring instrument — a ruler is
  not tolerance-gated against itself).
- Queries (`closestPoint`, `raycast`): deterministic today only because they
  are slow; the API contract is already "a closest point" (scan-order tie
  artifact). Algorithm fixes are Class 2 by nature with the SDF itself as
  oracle; batched GPU forms are keyed-slot → ordering vacuous. 10–1000×
  per-query headroom.
- **`.vdb` export has been geometry-stable/byte-unstable since day one**
  (upstream random 128-bit header UUID; compression off in wasm) and every
  consumer — including this repo's round-trip tests — is grid-equality-based
  and never noticed. One of three export formats already lives the operator's
  dichotomy. Fix (content-hash UUID) is ~free and needed for any
  content-addressed artifact store regardless of this decision.
- Tau product surfaces: geometry/export caches are **input-addressed**
  (dependency hashes) — output byte-instability does not break invalidation;
  thumbnails are order-invariant; geospec is itself a geometry-parity gate
  (and caught real kernel bugs); the flagship LEAP71 parity signal is
  size-±10%. **No product surface found in either repo requires byte-identical
  exports.** The real consumers of byte identity are internal oracles.

## 5. Substrate levers (WASM 2026)

| Lever | Class | Verdict | Evidence |
| --- | --- | --- | --- |
| mimalloc (link-time) | ~~1~~ ~~→ **X on MT** (SK-0.9)~~ → **0 on MT** (SK-0.10) | ~~DO NOT FLIP — blocked on a correctness defect~~. **UNBLOCKED (SK-0.10)**: the "91.8% `INVALID_IDX`" was our own signed-shift heap-view read in `src/mesh.ts` (2 GiB pointer + `>> 2` + `subarray` clamping), not the allocator and not extraction. Fixed; mimalloc multi is byte-identical to the dlmalloc ST reference at 0.5/0.6/0.7 mm ×5. Flip gated only on the exit-baseline measurement; L0 stays dlmalloc regardless | SK-0.1: 1.208× construct, 2× mesh; SK-0.6: 3.9× mesh scaling, byte-identical on M10; A8: 113× microbench; SK-0.10: 15/15 clean, ≡ reference |
| `fastRenorm` scheme (runtime opt-in, landed) | 2 | **default-on fast lane**; consider SECOND_BIAS accuracy case upstream | SK-0.8: 3.49–3.95×, all gates pass, 28% min margin |
| Vectorized transcendentals (T2) + f32x4 tape (T1) | 2 | fast-lane, W1 kill bars, interval-widening rider | A8 F8 census (5 ops); TP7a's 1.91× precedent; est 1.5–3× trig-heavy eval |
| `-mrelaxed-simd` | 3 | **last** — Safari can't parse it (module rejection → second artifact pair + dep prefixes), +2.4% measured pre-tape | W1 T3; safari-wasm doc |
| `-ffast-math` / `-flto` | — | **measured dead, closed** (+1.6% inside noise / net negative); never blanket-relax | W1 measured-dead register |
| Wasm scalar/SIMD FP | 0 | IEEE-deterministic by spec; no FTZ/mode bits; NaN payloads fenced by tape discipline | substrate review §2 |
| Threads/TBB scheduling | 0/1 | already schedule-independent by construction where it matters; `PTHREAD_POOL_SIZE=hardwareConcurrency` is a machine axis, not a determinism axis, while identity oracles stay in CI | pico-tape.cpp:23-30; SK-0.7 |
| Engine variance | 0 on L0 | 3-engine hex-float exactness is gate-proven for the serial `-msimd128` module; JS-callback path was always 0.5%-tolerant | browser gate; SK-0.5 |
| GPU (Dawn/Metal) | 2/3 | `math_mode(relaxed)` default; f32; subgroup order — all anticipated by the lane design; S-E grammar (count→scan→emit, atomicMin on float bits, spin-free) confines Class 4 to value-invariant placement | R8; R6; harmonic S-E |

## 6. The geometry-parity test, concretely

Tier structure (cheap → expensive), per run:

- **G0 identity (exact, all lanes):** canonical grid hash — one O(active)
  pass over sorted (coord, value); volume hex; active-voxel count;
  triangle/vertex counts; order-invariant mesh multiset hash (commutative
  128-bit sum of per-record hashes; ~0.1–0.2 s over a 502 MB STL stream).
  Applied as: run-to-run triples (N≥3), single≡multi, cross-build A/B,
  cross-lane (fast vs L0) — **at ≤0.7 mm and pinned scales**.
- **G1 tolerance (Class-2 lanes only):** the SK-0.8 §4 shape verbatim —
  corrected volume ≤3%, corrected **area** ≤3%, bounds ≤1 voxel, band SDF
  max ≤1 / mean ≤0.25 voxel, `checkLevelSet` EMPTY (hard), `Mesh_bIsValid`,
  voxel-denominated distances, analytic cross-scoring where closed forms
  exist (the SECOND_BIAS lesson: "differs from L0" and "worse" are different
  claims).
- **G2 topology (with G1):** watertight + manifold (the lattice
  near-touching-strut fixture guards the multi-point-cell Manifold-DC
  property), Euler characteristic, connected components, void count via the
  in-house exact winding-number oracle, per-component volume matching (kills
  same-total-different-shape aliasing).
- **G3 structural review (design time):** commutative-combiner rule;
  permutation oracles (input-order shuffles → identical G0); no observable
  consumption order on shared mutable state.

Per-family gate assignment: **exact (G0)** for booleans, projectZSlice,
bIsEqual, slices, fields, volume/properties, and all same-algorithm
parallelism/allocator changes; **G0+G1+G2** for the PDE family (offsets,
redistancing), query-algorithm swaps, and every GPU lane; **byte** (L0 pins +
canonical export) unchanged where it lives today.

## 7. Export surfaces

STL/GLB writers are pure functions of the mesh arrays — byte stability
reduces entirely to array content and order. Over a non-deterministic compute
lane, a **canonical serialization pass** (parallel sort of 48 B triangle
records; vertex sort + index remap for GLB) restores machine- and
run-invariant bytes at ~30–100 ms @1.9 M tris / ~0.15–0.5 s @10 M tris —
**<1.5% of end-to-end wall** even at fine cells, paid only at export. `.vdb`
needs the UUID canonicalization regardless. Product posture: geometry-parity
compute lane; canonical bytes at the export boundary for consumers who want
them; L0 lane for anyone who wants the whole pipeline reproducible.

## 8. GPU lanes

No design change required. The harmonic architecture's lane split, the S-E
kernel grammar, and SK-0.8's L1 gate shape already implement this regime.
What survives of L0's bring-up value under geometry gating: bit-exact
*topology* parity (sign tables, counts, connectivity — diffable cell by
cell), the serial byte-exact reference for count→scan→emit ports, and
exact-identity race detection. What dies: bitwise STL diffs as a *position*
signal — replaced by a bounded per-site f32 delta model at the two named
arithmetic sites (crossing lerp, edge-group average). Favorable trade.

## 9. Dual-support cost, itemized

| Item | Delta under the three-tier regime |
| --- | --- |
| wasm artifacts | +2 (fast-serial, fast-multi) only when T1/T2/relaxed-SIMD land; mimalloc is link-time (no new artifact); GPU lanes add WGSL data, not wasm |
| dep prefixes | +2 only at the relaxed-SIMD flip (codegen must reach the archives) |
| byte pins | **zero change** — all attach to L0, which is untouched |
| new oracle tooling | canonical grid hash + mesh multiset hash + identity-triple harness: ~S effort; G1 harness already exists (SK-0.8) |
| CI wall | the real recurring cost: fast-lane suite ≈ doubles wasm-suite wall — bound by full-suite nightly + fixture-subset & identity gates per-commit |
| discipline | every "byte parity: PASS" reads as *pin-scale* parity (the P0 banner); G3 review rule on every new kernel |

If the dual-support cost were judged too high, the evidence favors keeping
the **geometry-parity fast lane** as the sole product lane (with canonical
export serialization) rather than the byte lane — the byte lane's unique
product value is nil (§4 interrogate/export), while its engineering value
(oracle) survives as CI-only infrastructure. But the measured cost is low:
most of the fast lane's levers are runtime opt-ins on the existing artifacts.

## 10. Corpus wall-time estimate

CPU flips only (mimalloc MT default + fastRenorm default + T1/T2 fast lane;
no GPU): HeatX-class end-to-end MT ≈ **1.25×** (construct 1.208× compounding
with 2–3.9× on extraction stages and 4.58× on the largest creation stage);
offset-dominated iterations **3.5–4×** (renorm is 94–97.5% of those walls);
trig-heavy implicit evaluation **1.5–3×** (T2, unmeasured, W1 bars);
query-heavy workflows 10×+ (algorithmic, gate-independent). Weighted over
the bench corpus (M-fixture phase shares, SK-0.1 baseline): **~25–40%
corpus wall reduction**, with the spread dominated by how much offset/mesh
work a workload carries. GPU lanes retain their chartered order-of-magnitude
bars (G1 ≥5×, G4 ≥10×, P5 5–20× per-sweep) — all Class 2, all enabled by
this regime.

## 11. Preconditions (must run before the flips)

1. **Diagnose the single-path allocator divergence** (mimalloc single ≠
   dlmalloc single, `0ccaa277` vs `38cad381`, geometry invariants equal).
   Code inspection found **no address-keyed mechanism** in the extraction
   path — a pure function of an identical grid cannot yield
   allocator-dependent bytes single-threaded, so the best-fit hypothesis is
   an **uninitialized-memory read** (candidates: `BulkResize`'s
   deliberately-uninitialized triangle array, flat-quad slack regions, or
   the pristine pool path — the divergence predates SK-0.6). The multiset
   mesh hash discriminates Class 1 vs Class X in one afternoon; a
   first-divergence byte diff then localizes it. **Until this runs, the
   residual is undiagnosed, not acceptable** — the one place a relaxed
   oracle could launder a real bug. If it is UB, it gets fixed under either
   gating philosophy.

   > **CLOSED 2026-07-27 (SK-0.9) — the divergence no longer exists.** dlmalloc
   > single and mimalloc single are **byte-identical** at 0.5 mm (the exact cell
   > that produced `0ccaa277` vs `38cad381`) and at 0.7 mm, on tree `3284423`.
   > No Class-1 residual, no UB on the single path, no sanitizer run needed.
   > Attribution: triangle counts moved by the SK-0.4 signature (10,048,032 →
   > 10,047,988 at 0.5 mm; 4,542,736 → 4,542,744 at 0.7 mm, volume hex
   > unchanged), so the divergence tracked the retired serial
   > `Voxels_RenderLattice` **construction** lane, not extraction — the
   > hypothesis above was looking at the right *class* of fault in the wrong
   > *place*. The confirming `PICOVOXEL_SERIAL_LATTICE=1` A/B is outstanding and
   > is a post-mortem on an escape hatch, not a blocker. Evidence:
   > `bench/results/webgpu-v2/SK-0.9.md` §3.
   >
   > **RE-OPENED AND PROPERLY CLOSED 2026-07-27 (SK-0.10).** The attribution
   > above is wrong. The confirming A/B was run: the retired serial lane at
   > 0.5 mm single, dlmalloc vs mimalloc, on the fixed tree, gives **one byte
   > stream** (`b9ebd7b20ed1…`, 10,048,032 triangles — SK-0.1's exact count).
   > The lane is not allocator-dependent. `0ccaa277` vs `38cad381` was the
   > SK-0.10 defect: a signed-shift heap-view read of a staging buffer that one
   > allocator placed above 2 GiB and the other below. SK-0.4's lane change did
   > not fix it — it changed the mesh size, which moved the pointer, which
   > stopped the bug firing. Coverage on the fixed tree: 32 runs across
   > {dlmalloc, mimalloc} x {single, multi} x {0.5, 0.6, 0.7 mm} plus the serial
   > lane, **four byte streams, exactly one per (cell, lane)**. Evidence:
   > `bench/results/webgpu-v2/SK-0.10.md` §6, §8A.

2. **Re-run the mimalloc oracle post-revert** (P0 doc step 5 unblocked but
   not yet executed) — the 1.208× must be re-derived on the correct tree
   before being spent.

   > **EXECUTED 2026-07-27 (SK-0.9) — mimalloc MT is a NO-GO on correctness.**
   > It is *not* "geometry-stable, byte-unstable". At 0.5 mm the mimalloc multi
   > build silently emits a **corrupt mesh**: four runs, four distinct multiset
   > hashes, and the sampled run carries 9,231,100 of 10,047,988 STL records
   > (91.9%) with NaN coordinates — 27,676,231 of 30,143,964 triangle indices
   > (91.8%) out of range, max index `0xFFFFFFFF` = OpenVDB `util::INVALID_IDX`,
   > vertex data intact. At 0.6 mm one of two runs **trapped** (`Illegal
   > instruction: 4`). **Volume hex, triangle count and STL byte count match the
   > reference bit-for-bit in every corrupt run** — Class X that a volume+count
   > gate passes. dlmalloc multi is clean and byte-stable (3/3 @0.5 mm, ≡ single,
   > plus 0.6/0.7 mm), so the default is unaffected and this is a latent, not a
   > live, production defect. Best-fit mechanism: quad-index slots read stale
   > rather than written — dlmalloc's zero-filled fresh pages mask it, mimalloc's
   > recycled segments expose it. Whether the slots are in
   > `patches/openvdb/0001-flat-quad-output.patch`, in `BulkResize` behind
   > `patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch`, or in
   > upstream `VolumeToMesh` is **not** established; a patch-toggle matrix of the
   > SK-0-P0 shape is the next spike. **The 1.208× must not be spent, and §5's
   > mimalloc row and §12.3 are blocked on a defect, not on ceremony.**
   > Evidence: `bench/results/webgpu-v2/SK-0.9.md` §4–§5; oracle
   > `bench/stl-identity.mjs`.
   >
   > **CLOSED 2026-07-27 (SK-0.10) — the defect was ours, in TypeScript.**
   > `src/mesh.ts` indexed the heap view with the **signed** shift
   > (`trianglePointer >> 2`). A wasm pointer at or past 2 GiB is `>= 2**31`, JS
   > `>>` coerces to int32 first, and `TypedArray.subarray` *clamps* a negative
   > start instead of throwing — so the readback returned a correctly-sized
   > window ~1.5 GiB away from the mesh. That is exactly why triangle count,
   > volume hex and STL byte count all matched: they never came through that
   > view. mimalloc's only role was placing the 120 MB triangle staging buffer
   > above 2 GiB where dlmalloc placed it below; **dlmalloc was never immune, it
   > was lucky about an address**, and a 400 MB ballast reproduces the identical
   > corruption on the dlmalloc build. A sentinel-filled probe (`0xAB` over
   > `mFlatQuads`, `0xCD` over the `BulkResize` triangle array, scanned over the
   > exact consumed ranges) found **zero** surviving sentinels, zero
   > `INVALID_IDX` and zero out-of-range indices inside wasm, which falsifies the
   > flat-quad patch, the parallel-flatten patch, upstream `VolumeToMesh` and the
   > oneTBB substrate simultaneously — so the chartered patch-toggle matrix was
   > not needed. SK-0.9's two inferences were wrong and its measurements were
   > right: `0xFFFFFFFF` was the *maximum* of a garbage distribution, not its
   > mode (0.4–2% of the out-of-range values; the rest are narrow-band SDF float
   > bit patterns). Fixed by `>>>` at 39 sites in `src/`; dlmalloc byte-identity
   > preserved at 0.5/0.6/0.7 mm; suite 466/466 at 100% coverage; a
   > source-invariant guard added in `test/surface-manifest.test.ts` because a
   > behavioural test would need a 2.8 GiB heap. **Re-verdict: mimalloc multi is
   > clean and byte-stable at 0.5/0.6/0.7 mm, 5 runs each, byte-identical to the
   > dlmalloc single-thread reference** — 32 runs, four byte streams, one per
   > (cell, lane). The 1.208× is spendable pending the
   > exit-baseline measurement; no default is flipped by that spike.
   > Evidence: `bench/results/webgpu-v2/SK-0.10.md`.
3. **Native stock-TBB U20 reproducer** (~a day) to settle
   upstream-vs-substrate before any merge re-attempt; the recommended
   re-attempt vehicle is `csgUnionCopy` either way.

## 12. Recommended adjustments to SK-0 and the charter

1. Land the G0 oracle tooling (canonical grid hash, multiset mesh hash,
   identity-triple harness) — prerequisite for everything; ~S effort.
   **LANDED 2026-07-27 (SKv2-0 V0.1)**: in-module hash `src/pico-hash.cpp` /
   `voxels.gridHash()`, harness `bench/g0-identity.mjs`, per-commit gate
   `test/g0-gate.test.ts` — evidence in
   `bench/results/webgpu-v2/SKv2-0-V0.1.md`.
2. Run the three §11 diagnostics.
3. ~~Flip `MALLOC=mimalloc` on the MT fast lane (L0 stays dlmalloc).~~
   ~~**WITHDRAWN 2026-07-27 (SK-0.9)** — mimalloc MT is corrupt at ≤0.6 mm (§11.2
   outcome line). Replaced by: fix the defect (patch-toggle matrix over the
   flat-quad and parallel-flatten patches), then re-run the oracle.~~
   **REINSTATED 2026-07-27 (SK-0.10)** — the corruption was a signed-shift heap
   view in `src/mesh.ts`, not the allocator (§11.2 outcome line). Fixed, and
   mimalloc MT is now byte-identical to the dlmalloc ST reference at
   0.5/0.6/0.7 mm ×5. The flip is unblocked and **gated only on the
   exit-baseline measurement**; SK-0.10 deliberately did not take it.

   > **OUTCOME 2026-07-27 (SK-0 EXIT) — measured, and the recommendation is
   > YES for the fast lane only.** The exit baseline was taken at `84e1515`
   > (ABAB, 20 samples/side, paired log-ratio bootstrap CI):
   > `bench/results/webgpu-v2/sk-0-exit-baseline-dlmalloc.json` is now the
   > forward denominator for SK-1…SK-3, replacing `sk-0.1-baseline-dlmalloc.json`.
   > **HeatX multi `construct` is 2.164× on mimalloc (CI 2.141–2.178)** — not the
   > 1.208× SK-0.1 recorded, because SK-0.4 converted the two largest serial
   > lattice stages into parallel ones, so they are now allocator-bound; multi
   > mesh extraction is 1.992×, and `io-threads.create` alone (4.729×) supplies
   > 57% of the win. **Byte identity holds everywhere**: 64 identity-object
   > comparisons across four blocks plus five (cell, build) cross-allocator pairs
   > at 1.0/0.5/0.4 mm, all identical, with single ≡ multi inside each arm. The
   > result is one-dimensional — **44 of 47 MT phases faster, 45 of 73 ST phases
   > slower (0.84–0.99×)** — which is why the recommendation is lane-scoped:
   > flip `'fast'` to mimalloc, leave L0/`'exact'` and the shipped single-thread
   > default on dlmalloc. Two costs are recorded rather than netted out:
   > `M10@multi/render` 0.723× (per-session thread-pool + first-touch segment
   > cost) and memory headroom — mimalloc leaves **0.24 GiB** to the 4 GiB wasm32
   > ceiling at 0.4 mm against dlmalloc's 0.66 GiB, so the fast lane reaches the
   > ceiling first. Side finding: **0.4 mm now passes on both allocators**
   > (SK-0.1: failed on both), so R12's boundary is finer than 0.4 mm and
   > unlocated. **No default was flipped by that spike**; the flip itself remains
   > an operator decision. Evidence: `bench/results/webgpu-v2/SK-0-EXIT.md`.

   **EXECUTED 2026-07-27 (SKv2-0 V0.3) — the flip landed.** The MT artifact
   (`pico-multi`) now links mimalloc by default in
   `scripts/build-pico-module.sh`; the serial artifact stays dlmalloc as the
   L0 oracle lane. Suite 474/474 on the flipped artifact with the dlmalloc-era
   G0 pins unchanged; release sweep 16/16 G0-identical, 4/4 cross-lane
   single≡multi (1.0/0.7/0.5 mm HeatX + 0.25 mm gyroid), every hash equal to
   the V0.1 dlmalloc-era sweep. Evidence:
   `bench/results/webgpu-v2/SKv2-0-V0.3.md`.
4. Flip `fastRenorm` (FIRST_BIAS×3) default-on in the fast lane; file the
   SECOND_BIAS accuracy finding upstream (U-row candidate).

   **EXECUTED 2026-07-27 (SKv2-0 V0.4) — mechanism landed; the flip binds in
   the V0.5 lane bundle.** Session-level `createPico({ fastRenorm })` with
   the §14.1 precedence rule (explicit per-op > session default > library
   default false) landed, gated by a G0-hash precedence matrix and fast-lane
   (MT/mimalloc) single≡multi identity + the hard `checkLevelSet` boolean;
   the library default stays byte-locked. Per §14's own landing order (lane
   surfacing **before** value-changing default flips), default-on is bound
   to the named `'fast'` bundle in V0.5 rather than flipped ambiently on the
   multi entry — pre-lane-API that would silently change every multi
   consumer's geometry with no lane/provenance surface, the exact ambient
   hazard §14.1 forbids. U22 filing text ready:
   `upstream/pr-offset-renorm-default.md`. Evidence:
   `bench/results/webgpu-v2/SKv2-0-V0.4.md`.
5. Execute the SK-0.4 pin regeneration as chartered (already operator-
   approved) — under this regime it is the *last* pin ceremony of its kind:
   future same-geometry lane changes gate on G0, not on pin bytes.
6. Reframe the charter's gate ladder language: G1–G5 bars unchanged, but
   their acceptance oracles are G0+G1+G2 (already de facto true for every
   GPU gate); L0 renamed from "the gate" to "the oracle lane".
7. Adopt the G3 structural-review rule for all future kernels; generalize
   the 0.7 mm identity gate into a scale-sweep identity harness.
8. Fix the `.vdb` UUID; add canonical export serialization as an opt-in
   export mode (default for content-addressed stores).
9. W1 T1/T2 proceed as chartered (they were always fast-lane work); T3
   (relaxed-SIMD) stays last behind its kill bar.
10. `csgUnionCopy` boolean successor spike, gated on §11.3.

## 13. What must never be relaxed

The exact-geometry identity oracles (any tolerance here is blindness to
races); `checkLevelSet` EMPTY and the interval-soundness riders (tolerance
there is Class X in disguise); `fCalculateVolume`/`properties()` bit-exact
hex as the cross-lane canary; the L0 lane's byte reproducibility (build-to-
build and engine-to-engine — it is the oracle everything else is measured
against); and fine-cell coverage in every gate, exact or toleranced. These
five are the things the evidence shows doing real safety work — everything
else byte parity was buying turned out to be either free by construction,
engineering ceremony, or a tax on measured wins.

## 14. Addendum: second-pass coverage (2026-07-27)

Six gaps identified in a post-delivery review; findings from a dedicated
evidence pass. Landing order (the gaps interlock): G0 tooling with §14.5's
constructions (already §12.1) → lane surfacing + cache-key amendment
(**before** the §12.3–4 default flips, which create the first two-lane
reality) → the §14.2 NaN policy as a G1/SK-2.2 entry criterion → the L2 pin
protocol at SK-3.7.

### 14.1 Lane surfacing and the cache-key contract

**API**: `createPico({ lane: 'exact' | 'fast' | 'auto' })` — a lane is a
named bundle (`'exact'` = L0: dlmalloc, byte-locked defaults, no GPU;
`'fast'` = F: mimalloc MT artifact, `fastRenorm` on, T1/T2 when landed;
`'auto'` = F + L1 when an adapter qualifies; a future `'large'` = wasm64
capacity artifact, demand-selected per `WASM-RUNTIME.md` §5.1,
Safari-excluded like relaxed-SIMD). Lane choice is structurally
session-scoped: lanes differ partly at *artifact* granularity (allocator is
link-time; relaxed-SIMD is a second artifact pair), and artifacts are chosen
at instantiation. Per-op options stay the fine-grained mechanism with the
`fastRenorm` precedence rule (explicit per-op > session default > library
default), with one enforced asymmetry: an op may *tighten* inside a fast
session; per-op *loosening* inside `'exact'` throws — one Class-2 op
destroys the session's structural exactness claim.

**Cross-lane feeds**: provenance tags (per-handle lane enum, least-upper-
bound over ancestry) + a refusing L0 export/pin boundary — non-L0 provenance
errors at export unless acknowledged (`acceptLane: 'fast'`), which routes
through §7 canonical serialization and records provenance in artifact
metadata. True re-canonicalization is **a replay, not a conversion** —
`plan.commit(roots, { lane: 'exact' })` re-executes the DAG; there is no map
from Class-2 values back to L0 values, and pretending otherwise would be
value-laundering.

**Cache keys — line-level findings against Tau**: input-addressing survives
byte instability but not *value* instability across lanes — two lanes under
one key means the first lane to run poisons the other's cache. The actual
key (`kernel-worker.ts:4589-4623, 5113-5118` → used verbatim by all three
caches at `geometry-cache.middleware.ts:319/379/433`) already captures wasm
artifact digests (so per-artifact lanes key correctly for free), model-source
per-op flags, and kernel init options. It does NOT capture: **ambient env
state** — `PICOVOXEL_SERIAL_LATTICE=1` changes geometry invisibly to any
such key — or **adapter identity** for future GPU lanes. Rule: *all
lane-relevant state must be lifted into artifact identity or kernel init
options; ambient state that changes geometry is a cache-key bug by
definition.*
**CORRECTED + RESCOPED 2026-07-27 (operator review)**: picovoxel is not a
Tau kernel today (zero references in the Tau runtime), so the env var is a
live ambient *input* in picovoxel, not a live Tau cache bug — "changes
geometry today, invisibly to the key" overstated. And the Tau side needs
**no amendment even at integration time**: `computeBaseDependencies`
(steps 5–6) already keys every kernel init option per key/value and every
implementation-asset sha256, and all three geometry caches consume
`dependencyHash` verbatim — lanes key correctly for free *provided they
are constructor-explicit*. What survives of this item (SKv2-0 V0.6,
rescoped): delete the env read (`src/context.ts:29`, module-load-time — two
sessions in one process cannot even differ) in favour of a keyed
`createPico` option on the V0.5 lane surface; V0.5 exposes the **resolved**
lane on the session for future keying; adapter identity stays an
SK-3.6/B8a entry criterion. The lanes-by-flag caveat is the enduring rule:
artifact digests distinguish artifact-level lanes automatically, but two
lanes sharing one artifact differing only in a runtime flag are
distinguished only if the flag is an init option. Key composition:
`H(inputs ∥ kernelId ∥ kernelVersion ∥ artifactSha256s ∥ laneId ∥
lane-relevant flags ∥ [L1/L2: adapter family + driver/Dawn bucket])`, with
`'auto'` resolved before hashing (an unresolved `'auto'` is exactly the
value that resolves differently run to run). Geometry-invariant machine
axes (thread count) stay out of the key deliberately. The S-C model/region
caches need the same amendment — a tape hash addresses the *program*, not
the *evaluator* — stated as an SK-3.6/B8a exit criterion since B8a ships
first.

### 14.2 WGSL NaN semantics for the tape port (G1 entry criterion)

The CPU tape pins: NaN samples are ACTIVE voxels; interval pruning carries
an explicit `bNaN` with per-op domain predicates; scalar min/max propagate
NaN asymmetrically per C++ `(b<a)?b:a`. WGSL licenses implementations to
assume NaN/Inf absent — expressions that would produce NaN may produce an
**indeterminate value**, and Dawn compiles MSL with `math_mode(relaxed)` by
default (per-module `strictMath` opt-in exists). A "let NaN flow" port is
unsound **by spec, not by QoI** — and silent NaN→non-NaN divergence is
Class X (mis-pruned blocks, flipped classifications), not Class 2.

**Design: poison-mask sentinel with guarded-finite arithmetic.** One `u32`
poison bitmask over the ≤32-slot register file. Guards keep every computed
value finite (`sqrt(max(a,0))`, displaced denominators, clamped exp);
poison predicates mirror `pico-tape.cpp`'s interval predicates op for op
(including the add/mul inf−inf/0·inf interior cases); min/max reproduce the
CPU asymmetry via three uniform branches on poison bits without ever
materializing NaN; a poisoned final register forces the ACTIVE
classification. Overflow poisons conservatively — the safe direction, same
as interval widening. Cost ~2–4 uniform ALU ops per interpreted
instruction; ~zero on specialized kernels (the tape compiler's interval
pass can prove domains safe per-region and elide guards). Residual
deviation, documented: CPU stores a NaN payload, GPU stores
guarded-finite + active flag → the canonical grid hash must canonicalize
NaN (§14.5). G1 must verify empirically per adapter (B9 rows): NaN
materialization + min/max-with-NaN probes under relaxed and `strictMath`;
zero-NaN/Inf output assertion over the corpus + a domain-torture tape;
poisoned-sample *set* equality CPU vs GPU.

### 14.3 Statistical power of identity runs

P(detect) = 1 − (1−p)^N for a race manifesting per run with probability p
(manifested runs are generically mutually distinct — both P0s' records
confirm). Table: p=0.75 → N=3 suffices (98%); p=1/6 → N=3 gives only 42%,
N=17 for 95%; p=0.01 → ~300 runs. Three structural conclusions: (i)
repetition is brutally expensive below p≈0.1, but **per-commit gates
compound** — a persistent 1-in-6 race is caught with 95% probability within
9 commits by a cheap N=2 gate; (ii) pairwise identity can never catch
deterministic wrongness (p=1, stable wrong value — the U2 class) at any N:
every identity gate must pair with a reference or differential
(single≡multi, cross-build, cross-lane); (iii) **diversity beats
repetition** — both P0s had p≈1 in the uncovered scale region and p≈0 in
the covered one; a condition sweep converts p from ~0 to ~1, which no
affordable N can do. Recommended: per-commit N=2 + reference at {1.0,
0.7} mm; spike acceptance N=3 for by-construction-deterministic kernels
(the G3 review class decides), N=5 + two extra scales otherwise;
release = full scale sweep {1.0, 0.7, 0.5} mm on HeatX + 0.25 mm on an
M10-class fixture, ×3, + single≡multi + cross-build + cross-lane. Host
load is free ambient variance: record it, don't control it, in identity
runs.

### 14.4 The L2 GPU-pinned lane, defined

L2 is the GPU analog of L0's *oracle* role — a reproducibility instrument,
not a truth anchor. A pin = per (adapter family × driver bucket × Dawn/Tint
version × kernel version), for a 5–10-fixture corpus: the G0 identity tuple
as produced by that configuration + the G1 metric *values* vs L0 + the
declared math mode. Gates: same-configuration run-to-run identity (the GPU
race canary — placement may vary, values may not); toolchain/driver rolls
(diff before accept, attribution review on change); kernel changes
(re-derive as part of landing). B9's adapter matrix is the pin keyspace
(tier-1 per-commit, tier-2 nightly). A pin moves only in a commit that
names the cause, shows G1 green vs L0, and attributes value changes to a
named arithmetic site. L0 remains the anchor: L2 pins are derived
instruments, regenerated from a G1-green state, never trusted over it.

### 14.5 Hash constructions, rigorously

**Mesh multiset hash**: per-record = strong 128-bit hash (xxh3-128/BLAKE3-
truncated) of the canonicalized 36-byte vertex payload (9 f32; the STL
normal is recomputed from vertices — hashing it adds a rounding-coupling
site for zero discriminating power); combiner = **256-bit modular sum** of
zero-extended per-record hashes, plus the record count. Commutative,
incremental, MT-friendly; handles duplicates by multiset semantics. XOR
rejected: even multiplicity cancels (two identical triangles hash to
nothing — a real degenerate case). Collision setting is *accidental*, and
additive combining of strong 128-bit hashes is negligible-collision at this
corpus scale; the known adversarial weakness of additive multiset hashes
(generalized-birthday) requires an adversarial record-chooser that does not
exist here — if the hash ever guards a trust boundary, the named upgrade is
a multiset-homomorphic construction (MSet-Mu-Hash/ECMH).
**Canonicalization before hashing (both hashes)**: −0.0 → +0.0 and
NaN → `0x7fc00000`; everything else raw f32 bits.
**RECONCILED 2026-07-27 (SK-0.10)**: `bench/stl-identity.mjs` implements the
36-byte vertex-only payload and both canonicalizations; SHA-256 (stronger,
stdlib) and a sibling record-count field are the two remaining deviations, and
canonicalization ships *with* `nonFiniteRecords`, never instead of it — a NaN
count must never be folded into the value it canonicalizes to. Every multiset
hash recorded before that date is in the old construction and is not comparable.
**Canonical grid hash**: OpenVDB depth-first traversal is already
coordinate-sorted — hash the (coord, canonical value bits) stream over
active voxels, O(active), no sort; **normalize representation first** (run
`pruneLevelSet`, then also hash the post-prune tile-space sign
classification) — the `bIsEqual` lesson made structural: tile-vs-dense-leaf
encodings of one field must hash equal, pinned by a tool self-test
(interval-pruned vs dense fill of the same implicit).

### 14.6 Simulation-derived fields and the agentic loop

Ingested solver fields have no L0 ground truth for their *values* — the
regime's oracles apply to the kernel's **processing** of the field, never
its fidelity to physics: content-hash at the ingest boundary (§14.5
constructions), then same-bytes-in → G0-identical processing out per lane;
structural health booleans replace analytic cross-scoring; Class-2 lanes
are trivially admissible by the input's own error budget (solver tolerance
dwarfs f32-ulp drift) — but Class X remains absolute: approximate values,
exact processing. NaN policy becomes a *product-surface* contract at ingest
(solver exports carry NaN/Inf routinely). The agentic loop needs exactly
one property: run-to-run geometry determinism — already mandatory,
never-toleranced, on every lane; it is what makes B8a's
hash-and-short-circuit sound and keeps agent search from chasing kernel
noise. Cross-machine/build reproducibility attach only at the export
boundary (§14.1's provenance gate; `plan.commit({lane:'exact'})` is the
loop's exit ramp). B8 numbers carry laneId + adapter. `pk.plan()` rules:
laneId is an *input* to the pass pipeline, never an output; value-changing
rewrites are reachable only when the lane admits them and are recorded in
plan provenance; and the optimizer itself is on the determinism hook —
same plan hash → same placements → same G0 tuple (an SK-3.1 exit
assertion), because a nondeterministic optimizer converts Class-0 kernels
into a Class-4 system. The committed plan's canonical hash + laneId +
pass-pipeline version is then the S-C model cache key, closing the loop
with §14.1.
