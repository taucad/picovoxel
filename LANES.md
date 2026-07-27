# LANES — the lane model reviewed from UX, DX, and program-wide angles

Operator-directed review, 2026-07-27, executed by four parallel maximalist
reviewers plus the V0.5 implementer, DX hat on and lazy-senior-dev skepticism
deliberately armed. **Findings only** — consequences are explicitly out of
scope here and get incorporated ahead of SKv2-0 Wave D+. Companion ledger to
`WORKLOAD-EXECUTORS.md`; the four full-depth subdocuments live in
`docs/research/` (tau-brain) and this file is their synthesis:

| Facet | Subdocument |
| --- | --- |
| Export boundary & asset neutrality | `docs/research/picovoxel-lanes-export-boundary.md` (7 findings, 8 open questions) |
| Provenance architecture & maintenance cost | `docs/research/picovoxel-lanes-architecture.md` (10 findings, 6-way alternatives matrix, 8 open questions) |
| UX & the product calculus of transparency | `docs/research/picovoxel-lanes-ux-product.md` (7 findings, decision menu D1–D8) |
| Program-wide completeness (GPU, plan(), Tau, capacity) | `docs/research/picovoxel-lanes-program-calculus.md` (20 findings, 24-entry gap register, 10 open questions) |

## The model as built (V0.4+V0.5, commits `109a698`/`8d01136`)

`createPico({ lane: 'exact' | 'fast' | 'auto' })` → resolved
`'exact' | 'fast' | 'open'` on `session.lane`; `'exact'` locks the byte-locked
numerics policy (loosening throws `PICO_LANE_LOOSENED` at construction and at
5 per-op sites); `'fast'` bundles `fastRenorm` on with tighten-only overrides;
omitted = `'open'` legacy. Per-handle `.lane` on Voxels/Mesh/ScalarField/
VectorField, LUB over ancestry, persisted as `PicoVoxel.Lane` grid metadata
(rides copies and `.vdb` bytes; name reserved at the public surface). The
refusing L0 export boundary: `toStl`/`toGlb`/`vdb.toBytes` throw
`PICO_LANE_EXPORT` on fast provenance unless `{ acceptLane: 'fast' }`;
acknowledged STL exports stamp `LANE=fast`; `meshFromStl` restores it.

## The operator's questions, answered from the evidence

**1. "Why throw at export if they opted in at `createPico`?"** The refusal
protects exactly one asset: the byte-pinned corpus and content-addressed
stores (fast bytes silently entering L0-comparable collections). But the
review found: (a) **no surveyed product does double consent** — OpenSCAD
(closest analog) silently re-computes for export rather than refusing; nTop
communicates ("results may differ, tolerance still met") rather than gating;
(b) the parties can differ — an `'open'` session with a per-op `fastRenorm`
buried in library code means the exporter never opted into anything, which is
the strongest pro-throw case; a session-level explicit `'fast'` is the
weakest; (c) the one structurally load-bearing beneficiary is picovoxel's own
pin/CI maintainer, and that guard could relocate into the pin-ingest harness
instead of taxing every user; (d) the friction is scheduled to GROW — once
T1/T2 and GPU lanes land, "fast" is all accelerated geometry, and per-export
acknowledgment degenerates into ceremony. A documented middle option: refuse
only in `'open'` sessions; export freely (with stamps) when the session
explicitly declared `'fast'`.

**2. "Why does the incompatibility exist at all — is lane passing an
architectural issue?"** It is **not performance plumbing and not stage
incompatibility**: no op branches on `.lane`; every grid feeds every op. The
lane system is comparability-class bookkeeping consumed at exactly three
export methods. The incompatibility is the program's deliberate contract
split (a byte-pinned oracle lane coexisting with value-changing
accelerations), not a design accident — and **normalization between stages is
provably a replay, not a conversion**: "exact" is path-defined; no function
of a fast value recovers the L0 value (partial renormalization restores
level-set *health* but yields a third Class-2 value). Class-1 *ordering* IS
canonicalizable, and that is already chartered separately (V0.18 canonical
export). On the maintenance critique: the honest census is ~200 effective
source LoC (+238 test), 5 `rejectLoosening` sites of which **shell's is
redundant** (its delegated ops already reject), 4 LUB computations, ~18
plain threading arguments with zero conditionals, zero added ABI calls per
op (~3 per wrap, microseconds). The conditional pathways live only in the
5-site policy half; centralizing them into one option-normalization point at
the facade edge is a viable refactor. Two structural facts constrain leaner
designs: meshes have **no native metadata slot** in the ABI (mesh provenance
can only live TS-side), and the eager LUB is what re-stamps tags onto fresh
grids from `csg*Copy` derives — grid-tag-only designs quietly lose `.vdb`
soundness.

**3. "User-facing cost of full transparency; is there a product decision?"**
Persona walk-throughs (casual dev / CAD exporter / Tau kernel / agentic loop
/ pin maintainer × four designs: refuse, transparent, warn, stamp-only) show
the casual and CAD personas pay all the friction and receive none of the
protection — **Class-2 drift has never harmed a consumer in the program's
recorded history**; both real catastrophes (U20 race, SK-0.10 signed shift)
were Class X, caught by geometry oracles, orthogonal to lanes. Certified
fastRenorm drift (≤2.14% volume, ≤0.36 mm) sits inside voxel quantization
and FDM process noise. Today's fast lane is deterministic on all four axes,
so the refusal guards *pin-comparability*, not *reproducibility*. And the
boundary is **advisory anyway**: `sliceVoxels→slicesToCli` (real
manufacturing bytes), the three.js bridge, and raw `vertices`/`triangles`
getters all bypass it. Transparency was in fact already chosen once —
`'auto'` silently resolves to `'fast'`. The product decisions are enumerated
as D1–D8 in the UX subdoc; the sharpest are D3 (does session-level `'fast'`
constitute the acknowledgment?), D4 (default lane per entry), and D7 (the
looming `lane` × `gpu:'auto'` API collision with locked program decision 7).

**4. "What are we missing program-wide?"** The single `lane` axis conflates
**seven dimensions** (artifact, threading, allocator, numerics policy,
algorithm arm, capacity, device/adapter) and only names one; the wasm64
`'large'` lane breaks the enum's own semantics (value-identical by V0.16's
kill bar — must never taint provenance, must reach cache keys: a lattice,
not a chain). Construction-time `'auto'` resolution cannot absorb
adapter-qualification/device-loss timing when GPU lanes land; the two-value
provenance records the coarsest class, not the computing executor, so per-op
GPU fallback and §14.4's adapter-family-keyed L2 pins are unrepresentable in
persisted artifacts; `math_mode(relaxed)` Class-3 machine-scoped values
would export as portable artifacts with no marker — *sharpened* by V0.18
canonicalization. `plan.commit({lane:'exact'})` has two readings (weak:
policy replay on this artifact; strong: L0-oracle reproduction) and the docs
use the strong one while the API can only deliver the weak one — eager
per-handle LUB does not survive a fusing/reordering executor. Version
identity is absent from persisted provenance (both lanes are moving targets:
T1/T2 moves `'fast'`, V0.9/V0.10 correctness fixes move `'exact'`). The Tau
V0.6 rescope *holds* (asset digests + keyed init options cover the
fast-tainted-vdb case), with one residual: an unresolved `'auto'` as a
literal init-option value would key wrongly on a shared cache. And the V0.7
+187 MiB arena finding generalizes: **lanes have memory-envelope semantics**
(0.24 vs 0.66 GiB ceiling headroom) that the contract nowhere states, and
OOM is a typed observable outcome — lane choice changes success/failure.

## Concrete defects found in passing (valid regardless of design outcome)

- `readLaneTag` reads tag **presence+type, never the value**: unknown string
  values (`'gpu'`, garbage) silently collapse to `'fast'` and are then
  destructively rewritten to `'fast'` on wrap; float-typed tags collapse to
  `'exact'` (`metadata.ts` / `voxels.ts`).
- STL lane detection is a case-insensitive unanchored `includes('LANE=FAST')`
  over the header — text like `PLANE=FASTENED` false-positives (`stl.ts`).
- A high-byte character (e.g. `ß`, 0xDF) before `UNITS=` misaligns the unit
  parse via the `toUpperCase` length change (`stl.ts:137-139`) — pre-existing,
  found by this review.
- `openVdb(foreignFastBytes).toBytes()` skips the refusal entirely (the gate
  arms only on locally-`add()`-ed fields) — the boundary asserts authorship,
  not content.
- Third-party tools rewrite STL headers, so one round-trip through
  Blender/MeshLab/a slicer launders `'fast'` back to `'exact'`; absence of
  any tag grants every foreign asset oracle-grade `'exact'` standing it
  never earned.
- Ingest paths (`meshFromStl`, `voxelsFromVdb`, `createMesh`) bypass the
  `'exact'` lane lock — a locked session can import fast-provenance content.
- Minor: a wasted tag read at fresh-creation sites; a redundant
  write-after-read on tagged loads; GLB has no provenance slot until V0.18
  (the acknowledged-GLB throw buys consent with zero record).

## Consolidated open-question register (the sharpest; full lists in subdocs)

1. What claim does `'exact'` formally make — "no Class-2 op touched this" or
   "L0-replayable"? They diverge exactly at `plan.commit` (export-boundary
   Q + calculus F5).
2. Is boundary consent per-artifact, per-session, or per-program — and does
   an explicit session `'fast'` already constitute it? (UX D3.)
3. Enum vs set: must GPU-L1 provenance be distinguishable from CPU-`'fast'`?
   Decide before SK-2 (architecture Q1, calculus F2) — the one place the
   current design grows super-linearly if answered "yes" late.
4. The dimensional decomposition: which axes belong in `session.lane`, which
   in provenance, which only in cache keys? (`'large'` forces this.)
5. Foreign/unknown provenance: does a third value (`'foreign'`/`'unknown'`)
   exist, and what do booleans over it produce? (Export-boundary F6.)
6. Version/build identity in persisted provenance — required for
   content-addressed stores, absent today.
7. Should lane contracts state memory envelopes (the +187 MiB arena rider,
   headroom asymmetry) alongside value semantics?
8. Where does the pin-poisoning guard live — the user-facing export boundary
   or picovoxel's own pin-ingest harness?
9. `lane` × `gpu:'auto'` (locked decision 7): one knob or two at the API
   surface when SK-2 lands? (UX D7.)
10. Who owns exact-replay machinery (cross-artifact re-execution) if
    `plan.commit({lane:'exact'})` is to mean what the docs say? (Calculus
    F5/F6; currently unowned by any charter move.)

## Status

Recorded 2026-07-27, mid-Wave-C (V0.3–V0.7 landed; V0.8 in flight). Nothing
here changes code yet by operator direction; incorporation is scheduled
ahead of Wave D+. The full gap register (G1–G24), alternatives matrix,
persona walk-throughs, precedent catalogs, and per-facet open questions live
in the four subdocuments.
