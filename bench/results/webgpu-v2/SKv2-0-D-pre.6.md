# SKv2-0 D-pre.6 — fast-lane G1 sweep legs

2026-07-31 · charter: `docs/research/picogk-webgpu-skv2-0-charter.md` §"Wave D
pre-req tasks" · runbook Iteration A2 · records:
`skv2-0-dpre6-fast-lane-sweep.jsonl` (52 records, one full sweep)

## What landed

`bench/g0-identity.mjs` grew the fast-lane legs (V0.5 §14.1):

- `g0Record`/`runTriple` thread `lane`/`fastRenorm` to `createPico`, and an
  opt-in `g1: true` captures the G1 inputs (SG1 `properties()` +
  `Voxels_bDiagnose`) — opt-in so the per-commit g0 gate stays lean.
- `compareG1` — the SK-0.8 tolerance shape between a fast record and its
  exact reference: live-grid volume (`volumeHex`) ≤3% (binds always), SG1
  mesh-round-trip volume/area ≤3% (health-guarded, below), bounds <1
  voxel/axis, checkLevelSet no dirtier than the exact leg (inherited dirt
  warns, a fast-only regression fails).
- `measureHealthy` — rebuilt/live volume ratio inside (1/1.5, 1.5); an
  unhealthy *reference* skips the mesh-measure gates loudly, an unhealthy
  *fast* leg still fails loudly.
- `sweep` runs, per cell: exact triples (unchanged, the L0 reference), fast
  triples per build (run-to-run identity + G1 verdict), and one
  `{ lane: 'fast', fastRenorm: false }` record that must be G0-identical to
  L0 — the tighten-inside-fast comparability pattern.
- `gate --jsonl F` replays every D-pre.6 verdict from a recorded sweep (the
  gates are pure functions of the records; no geometry reruns).

## Run (once, for the record)

All 20 legs green: every triple G0-identical ×3 with oracles agreeing,
single ≡ multi at every cell, G1 clean at every cell, tighten-inside-fast
≡ L0 at every cell. Fast/single vs exact/single per cell:

| cell | liveVol Δ | propVol Δ | propArea Δ | rebuilt/live exact | fast | wall exact→fast (single) | (multi) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heatx@1.0 | 0.267% | 0.611% | 0.786% | 1.206 | 1.202 | 53.9→33.8 s | 13.9→8.5 s |
| heatx@0.7 | 0.395% | (unhealthy ref) | (unhealthy ref) | **1.931** | 1.200 | 128.0→65.2 s | 22.2→15.2 s |
| heatx@0.5 | 0.458% | 0.412% | 0.477% | 1.233 | 1.234 | 309.2→137.3 s | 48.7→36.8 s |
| gyroid@0.25 | 0 (G0-coincident) | 0 | 0 | 1.017 | 1.017 | ≈ | ≈ |

- The gyroid tape runs no Class-2 op, so `lane: 'fast'` is G0-coincident
  with L0 there and the handle provenance correctly stays `'exact'` (its
  STL needed no `acceptLane`).
- Wall clocks are ambient-load identity runs, not timing claims; the
  fast-lane speedup they show (1.6–2.3× single) is the V0.4 fastRenorm
  family diluted by pipeline share, consistent with SK-0.8.

## Findings

1. **`properties()` is measure-unhealthy on exact HeatX @ 0.7 mm** — the
   real find of the sweep. The pinned 0.7 exact grid is geometrically right
   (live `levelSetVolume` 589,810 mm³, monotone between 1.0 mm's 590,923
   and 0.5 mm's 584,931), but the SG1 rebuild (`pico-props.cpp`: mesh →
   `meshToLevelSet` → `LevelSetMeasure`) reports volume 1,138,975 (1.93×
   live; healthy cells 1.02–1.23×) and area 108,818 (3.5× collapsed). The
   *fast* grid at the same cell rebuilds healthily (ratio 1.200) — the
   renormalized field meshes without whatever configuration breaks interior
   classification in `meshToLevelSet`. Pre-existing, deterministic
   (single ≡ multi ≡ tight all reproduce it bit-for-bit), and
   upstream-parity by construction (the sequence is C#
   `CalculateProperties`; a native repro is required before filing —
   MIGRATING ledger row U25, charter watch item). The harness now
   health-guards it; the G1 volume verdict rides the live-grid volume,
   which binds at every cell.
2. **checkLevelSet is dirty on the full pipeline in BOTH lanes** — HeatX
   reports ~571k (1.0 mm) / ~1.77M (0.5 mm) voxels outside NormGrad
   [0.5, 1.5], and the gyroid tape 14k, in exact and fast alike. The
   SK-0.8 "clean field" gate is an offset-family property, not a pipeline
   property (CSG seams and seals legitimately kink |∇φ|). Hence the gate
   shape: fail only fast-*only* dirt; inherited dirt warns. At 0.7 mm the
   message is instead the width check "background (2.1) is less than 3
   voxel units" — f32 `2.1/0.7 = 2.9999998…`, a float artifact hitting
   both lanes identically.
3. **The V0.5 export boundary fired on the harness itself** — fast-provenance
   meshes refuse `toStl()` without acknowledgment; the harness acknowledges
   with `acceptLane: 'fast'` (it is an oracle consumer; identity math is
   lane-blind). Working as designed.
4. **Hardening note**: the sweep's exit code was initially masked by a
   `node … | tail` pipeline (the pipeline exits with `tail`'s status). The
   `gate` replay command re-derives every verdict from the JSONL, which is
   how this run's verdicts were confirmed; future sweeps run un-piped.

## Verdicts carried forward

- The F lane is G1-clean against L0 across the sweep corpus, with
  run-to-run identity and the tighten-inside-fast pattern intact — the
  V0.5/V0.4 lane surface holds under the D-pre.6 legs.
- Watch item: `properties()` mesh-measure pathology (finding 1) — candidate
  Wave-E-adjacent investigation; the V0.18 canonical-export work touches
  the same mesh path.
