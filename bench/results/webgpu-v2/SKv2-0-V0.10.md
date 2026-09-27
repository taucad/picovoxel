# SKv2-0 V0.10 — IntersectImplicit: F17 support-restricted eval + the U1 fix

**Verdict: LANDED.** `maskedByImplicit` (both branches) rides a new
U1-corrected, F17-restricted export pair: `Voxels_IntersectImplicitFast`
(JS-callback, `src/pico-zslice.cpp`) and `Voxels_IntersectImplicitTapeFast`
(`src/pico-tape.cpp`). The truncated-band originals stay raw-side as
oracles.

- **U1**: upstream's `Voxels oVox(oVoxelSize(), fBackgroundMM())` passes
  MILLIMETRES into the ctor's `int nNarrowBand` — band 3 at 1.0 mm by
  coincidence, band 1 at 0.4–0.7 mm, **band 0 below ~⅓ mm, where the
  original does not even run** (zero-background level set → wasm exception;
  asserted in the suite). Fixed: band = `background()/voxelSize` voxels.
- **F17**: `ParallelTapeFillGrid` gained an optional support-column set
  (nullptr = pre-V0.10 behavior byte-for-byte); the Fast exports mark the
  target's stored block columns (O(stored)) and skip everything else —
  where the target is background, `max(+bg, sdf)` is `+bg` and the
  intersection discards the column regardless.

## Findings of record

1. **The two Fast paths are G0-exact against each other** — callback ≡ tape
   grid hash on every fixture tried — which the OLD callback/tape pair never
   was: the vendored callback path prunes its fresh grid pre-intersection,
   flipping ~190 band-edge active states on the 1.0 mm plane-cut fixture.
   That structural delta is invisible to the R9 oracles (`equals`,
   mesh counts, STL, `properties`) and was shipped as such; the Fast pair
   adopts the tape-side semantics, making cross-path G0 identity a NEW
   property. Verified: Fast ≡ the shipped tape export exactly at 1.0 mm,
   and ≡ the vendored callback original under the R9 oracles.
2. **Column-skip is value-exact**: bisect at 1.0 mm — skip on/off produce
   identical grid hashes (3643/0/30 record).
3. **Fine-cell correctness restored**: at 0.25 mm the Fast pair matches a
   reference construction from never-truncated paths (`createVoxels
   implicit` ∩ sphere) under classification+mesh oracles, while the
   original **throws** (asserted).
4. **Stage speedup recorded**: thin-beam fixture @0.4 mm, tape path: 6.9 →
   5.3 ms (1.3×) **while doing 3× the band work** (band 3 vs the
   mis-banded 1); the old tape's TP6 interval culling already skips empty
   blocks, so F17's marginal win on tapes is modest — the callback path
   (no TP6) and the correctness restoration are the substance. At ≤⅓ mm
   the comparison is undefined: the old arm does not run.

Exit assertions: thin-part/bbox-ratio fixture exercised; <⅓ mm correctness
restored with the throw documented; G0 identity on unaffected fixtures
(1.0 mm exact vs the shipped tape path; the G0 per-commit pins held). Pin
moves isolated to three example fixtures using `maskedByImplicit` at fine
scales (`ex-implicit-gyroid-genus`, `ex-implicit-gyroid-sphere`,
`ex-implicit-random`): **triangle counts bit-unchanged in all three; only
the representation-sensitive raw `volumeHex` moved** (the corrected band's
narrow-band bookkeeping) — regenerated per the SK-0.4 protocol, cause: the
U1 band fix (this move).
Ground rule 8 discharged (+2 exports: BULK 19→21, bound 159→161, tier-2
C20 with a hand-packed raw tape leg, API surface).

## Ledger deltas (this commit)

MIGRATING U1 row → fixed here (both paths), throw-below-⅓mm documented,
upstream filing candidate (C# inherits unconditionally); WORKLOAD
IntersectImplicit row → graduated.
