# SKv2-0 V0.2 — identity-harness CI wiring

**Verdict: LANDED.** The three §14.3 shapes are wired and documented, and a
re-introduced SK-0.10-class fault is caught by the per-commit shape.

## The three shapes

| Shape | Where | Form |
| --- | --- | --- |
| Per-commit | `test/g0-gate.test.ts`, inside `npm test` (local and `.github/workflows/test.yml`, whose job budget went 60→90 min for CI-class hardware) | HeatX multi @ {1.0, 0.7} mm, N=2 identity + pinned reference (`test/fixtures/g0-reference.json`). 105 s on the reference machine. |
| Nightly | `.github/workflows/g0-nightly.yml` | 11-run identity spike, multi lane, fixture rotating by day-of-year: heatx@0.7 / gyroid@0.25 / heatx@0.5 (the deep-heap leg — the SK-0.9/0.10 defect class only manifests past 2 GiB). Failure opens an issue; records uploaded as artifacts. No wasm build — runs against the tracked multi artifact, exactly what the suite tests. |
| Release | `node bench/g0-identity.mjs sweep --runs N` | {1.0, 0.7, 0.5} mm HeatX + 0.25 mm gyroid, single+multi, run-to-run + cross-lane + oracle agreement. First execution recorded in `SKv2-0-V0.1.md`. |

Load is recorded in every record (`loadBefore`/`loadAfter`), never
controlled — which is what lets identity run on CI while timing benchmarks
cannot (`bench.yml` stays a drift canary).

## Exit assertions

**1. Gates run green on HEAD.** `npm test`: 51 files, 474/474, coverage
thresholds enforced at 100%, per-commit gate included (474.2 s suite wall).
Release sweep: 16/16 runs identical, 4/4 cross-lane, oracles agree.

**2. A re-introduced SK-0.10-class fault is caught by the per-commit
shape.** The mesh-readback truncation (`triangleCount * 3` → `* 3 - 3` at
the subarray boundary in `src/mesh.ts` — the clamp signature) seeded into
the working tree, then the gate run as-is:

```
× G0 per-commit gate — HeatX @ 1 mm multi: N=2 identity + reference    38.5 s
× G0 per-commit gate — HeatX @ 0.7 mm multi: N=2 identity + reference  66.2 s
AssertionError: heatx@1mm drifted from its G0 reference — a geometry change; …
AssertionError: heatx@0.7mm drifted from its G0 reference — a geometry change; …
```

Both scales fail on the reference multiset while the identity half stays
green (the fault is deterministic — exactly the class §14.3 says identity
can never see and the reference exists for). Tree restored; `git diff`
clean.

## Notes

- The per-commit gate rides `npm test`, so every push and PR runs it via
  the existing test workflow — no new per-commit CI surface.
- Statistical footing (§14.3): N=2 per commit compounds — a persistent
  1-in-6 race reaches 95% detection within 9 commits; the nightly 11-run
  spike catches a 1-in-4 race at ~96% in one night; rotation buys the
  condition diversity that repetition cannot.
