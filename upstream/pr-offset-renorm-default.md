# PR text — offset renormalization default: HJWENO5_BIAS → SECOND_BIAS (U22 ask 2)

**Target**: leap71/PicoGKRuntime (`Source/PicoGKVdbVoxels.h`, three insertion
sites). **Patch**: `picogkruntime-offset-renorm-scheme.patch` (this directory;
`patch -p1`, 0 fuzz against pristine `0f26321c`). **Status**: DRAFT, NOT
POSTED — outward actions need maintainer sign-off per the charter.

---

## Title

Offset family: set the level-set renormalization scheme to SECOND_BIAS
(faster AND more accurate than the inherited HJWENO5 default)

## Body

`Voxels::Offset`, `DoubleOffset` and `TripleOffset` construct their
`LevelSetFilter` locally and never touch the tracker's settings, so every
offset pays the interface-TRACKING defaults: 3 sweeps of `HJWENO5_BIAS` per
half-voxel CFL step. An offset moves the surface along its own normal by a
constant and keeps the distance property by construction — OpenVDB's own
header notes one low-order sweep is often enough for the analogous band
dilation (`LevelSetTracker.h:115-123`).

We measured the alternatives while porting PicoGK to WebAssembly
([picovoxel]; 12 paired repeats per setting, bootstrap CI widths ≤ 0.02×,
four fixtures — sphere, sphere∪beam, a lattice body, and a real heat-exchanger
model):

- **Renormalization is 93.9–97.5% of the offset wall** — the scheme choice
  *is* the offset's performance.
- One `HJWENO5` sweep costs 4.2× a first-order sweep.
- **`SECOND_BIAS` at the default 3 sweeps is 2.1–2.3× faster AND more
  accurate against the closed form** — 0.050% vs 0.094% volume error on an
  analytic sphere offset. There is no axis on which the shipped setting wins.
- The two knobs are **not interchangeable**: dropping the scheme order keeps
  |∇φ| ∈ [0.5, 1.5] (`tools::checkLevelSet` clean); dropping `normCount`
  broke that range on every fixture tried. `HJWENO5` at 1 sweep is strictly
  dominated by a lower-order scheme at 3 (slower AND broken AND less
  accurate) — so this PR moves only the scheme and leaves the count alone.
- Plain `WENO5_BIAS` is 5–8% *slower* than `HJWENO5` and breaks the level
  set — a dead end, not a middle setting.

This is a defect report against the default, not a fast-mode request: on the
two axes a default is chosen on — speed and accuracy — `SECOND_BIAS`×3 wins
both. The C# binding inherits the same deficiency (`Voxels.cs`'s offsets are
P/Invokes straight to these exports with no override path).

`setSpatialScheme` is public `LevelSetTracker` API inherited by
`LevelSetFilter`, and `openvdb::math::SECOND_BIAS` arrives with the header
already included — three inserted lines, no new dependency.

### What changes for downstreams

Bit-for-bit output changes, so any byte-pinned corpus regenerates. The
evidence worth re-deriving is geometry-shaped, not byte-shaped: corrected
volume AND area relative deltas (area is load-bearing — a volume-only gate
passed 9% area drift in our sweep), bounds within 1 voxel, narrow-band SDF
max ≤ 1 / mean ≤ 0.25 voxel, `tools::checkLevelSet` EMPTY as a hard boolean,
and analytic cross-scoring where a closed form exists. That gate shape
rejected 6 of 8 renorm settings that volume tolerances passed.

On request we can supply the full sweep table and the G0 identity tuples
(canonical grid hash, hex-float volumes, count fields, order-invariant mesh
multiset hash) for the before/after corpus. Classification per our
non-determinism taxonomy: Class 2 — bounded numeric drift, geometry
equivalent under the gates above.

### Related, deliberately not included

An optional settings parameter on the three exports (U22 ask 1) would let
bindings choose per call — but it changes the C ABI signatures and needs
coordinating with leap71/PicoGK, so the API shape is your call; happy to
draft it if wanted.

[picovoxel]: the PicoGK wasm port; measurement detail in its
`bench/results/webgpu-v2/SK-0.8.md`.
