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
held hostage by triangle emission order (Class 1). (b) The `fastRenorm`
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
| mimalloc (link-time) | 1 (MT emission order; single-path residual §11) | **flip on fast lane** after §11 diagnostics; L0 stays dlmalloc → zero pin churn | SK-0.1: 1.208× construct, 2× mesh; SK-0.6: 3.9× mesh scaling, byte-identical on M10; A8: 113× microbench |
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
2. **Re-run the mimalloc oracle post-revert** (P0 doc step 5 unblocked but
   not yet executed) — the 1.208× must be re-derived on the correct tree
   before being spent.
3. **Native stock-TBB U20 reproducer** (~a day) to settle
   upstream-vs-substrate before any merge re-attempt; the recommended
   re-attempt vehicle is `csgUnionCopy` either way.

## 12. Recommended adjustments to SK-0 and the charter

1. Land the G0 oracle tooling (canonical grid hash, multiset mesh hash,
   identity-triple harness) — prerequisite for everything; ~S effort.
2. Run the three §11 diagnostics.
3. Flip `MALLOC=mimalloc` on the MT fast lane (L0 stays dlmalloc).
4. Flip `fastRenorm` (FIRST_BIAS×3) default-on in the fast lane; file the
   SECOND_BIAS accuracy finding upstream (U-row candidate).
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
