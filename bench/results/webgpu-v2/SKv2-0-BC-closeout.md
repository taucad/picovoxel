# SKv2-0 Waves B+C — concluding report (operator-directed)

2026-07-27, sequential execution (operator mandate after prior cross-agent
contamination). All eight moves landed and committed on `webgpu`; every
suite/browser-gate/G0 assertion held at each step.

## Per-move outcomes

| Move | Commit | Verdict | Headline |
| --- | --- | --- | --- |
| V0.3 mimalloc MT default | `66f4e3e` | flipped | construct 1.989× [1.967–2.012] over a 0.88–0.97× drift control; dlmalloc-era G0 pins held |
| V0.4 fastRenorm session default | `109a698` | mechanism landed | **deviation, documented**: default-on bound into V0.5's named bundle per §14 landing order; U22 filing text ready |
| V0.5★+V0.6 lane API | `8d01136` | landed | 'exact'/'fast'/'auto'→resolved + 'open'; per-handle LUB provenance persisted as `PicoVoxel.Lane`; acceptLane boundary; env → keyed `serialLattice`; zero pin churn |
| V0.7★ csg*Copy + U20 repro | `0562f4f` | landed + **repro'd upstream** | 1 materialization/pair, value-identical; native stock-TBB repro settles §11.3 = UPSTREAM (novel report READY); M1 rider: mimalloc arena +187 MiB |
| V0.8 bIsEqual (T11) | `0a777ef` | graduated | O(stored) verdict-identical; 11.7×/16.9× (the ~100× was the model figure) |
| V0.9 ProjectZSlice + U2 | `1db7577` | graduated + **correctness fix** | seal = band voxels (open caps <0.167 mm fixed); heatx@1mm pin byte-UNCHANGED, 0.7 mm moved gridHash-only, per protocol |
| V0.10 IntersectImplicit + U1 | `fb87dbf` | graduated + **correctness fix** | original THROWS <⅓ mm; Fast pair cross-path G0-exact (new property; vendored callback pre-prune found R9-invisible); 3 pins moved volumeHex-only |
| V0.11 P8 queries | `71b2481` | graduated | raycast batch 7.3×/ray exact-per-ray; closest-point 241× with analytic gates |
| V0.12 U18 value storage | `f36be41` | applied, **attribution corrected** | Class 0, zero movement; <2 ns/beam recovered — 20.9 ns figure retired; ships for the contiguous GPU seam |

## Attribution-corrections register (bind on future estimates)

1. **SK-0.3's 20.9 ns/beam "C++-side allocation"** = ctor+bbox+alloc lumped;
   retired (V0.12).
2. **T11's "~100×"** was the O(bbox³)→O(stored) model; realized 11.7–16.9×,
   ratio grows with bbox³/stored (V0.8).
3. **F17 is modest on tape paths** (TP6 interval culling already skips empty
   blocks; 1.3× at 3× band work) — its value concentrates on un-culled
   paths + the U1 correctness restoration (V0.10).
4. **The R9 oracle set has a G0 blind spot**: the vendored callback's
   pre-intersection prune flips band-edge active states invisible to
   equals/mesh/volume/STL — found only by the canonical grid hash (V0.10).
   Corollary: "equals()-identical" claims elsewhere in the record are
   weaker than G0 claims.
5. **U20 is upstream** (native stock-TBB repro, `bench/u20-native-repro.cpp`)
   — the wasm substrate is exonerated across the whole defect class.

## Adjustments for Wave D+ and the wider program

- **The LANES gate is already chartered** (pre-Wave-D section): V0.13/V0.14
  land *inside* the `'fast'` bundle and MUST NOT start before the LANES
  findings (`repos/picovoxel/LANES.md` @ `6b31f63` + 4 subdocs) are
  incorporated — double-consent (UX D3), enum-vs-set provenance (needed
  before SK-2 GPU lanes), the 7-dimension lane-axis decomposition (forced
  by wasm64 `'large'`), and the passing-defect fixes (unknown-tag collapse,
  STL substring match, foreign-authorship vdb pass-through, ingest
  bypassing the 'exact' lock).
- **V0.15/M1 rider list grew**: mimalloc worker-arena high-water on
  copy-compose (+187 MiB one-shot @0.08 mm), `gridHash()`'s transient 2×
  deep copy, and the standing 0.24 GiB fast-lane ceiling headroom @0.4 mm.
- **V0.16 (wasm64)**: the LANES finding that `'large'` breaks the lane
  enum's semantics (value-identical yet cache-distinct) becomes an entry
  criterion for its API shape.
- **V0.18 riders confirmed**: canonical-serialization routing for
  acknowledged exports + a GLB provenance slot.
- **Upstream filing queue for the operator** (all dry-run/replay-verified):
  U20 novel race report (harness in-repo), U1 + U2 correctness fixes (C#
  inherits both; U1 throws, U2 opens caps), U22 default change
  (`upstream/pr-offset-renorm-default.md` ready), plus the standing
  U16/U24 emscripten patches. `patches/` inventory now carries 0003.
- **Corpus scorecard** (the realized fraction of §10's 25–40% estimate)
  remains V0.21's job — the denominators are in place
  (`skv2-0-v0.3-baseline-mimalloc-default.json` vs the SK-0 exit file).
- **Production charter note**: two user-visible correctness fixes shipped
  (sealed caps, fine-cell masking) and one API surface (lanes) whose
  product semantics are now an explicit operator decision menu (LANES
  UX D1–D8) — the fast-lane default question should be settled before any
  public API freeze.

Wave D+ resumes after the LANES incorporation review; E (V0.15/M1 first)
and F are unblocked now.
