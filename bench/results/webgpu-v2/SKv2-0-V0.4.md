# SKv2-0 V0.4 — `fastRenorm` default-on for the fast lane

**Verdict: MECHANISM LANDED; the default-on binding deliberately rides V0.5's
`'fast'` bundle.** The session-level default, its §14.1 precedence rule, the
fast-lane gates, and the U22 filing text all land here. The one thing this
move does NOT do is flip the multi entry's ambient default — a deliberate,
documented deviation from the charter row's literal reading, on the charter's
own doctrine:

## Why the flip itself waits for V0.5 (one move, not a scope cut)

NON-DETERMINISM §14's landing order is explicit: lane surfacing comes
**before** the §12.3–4 default flips, "which create the first two-lane
reality". V0.3 was safe to land first — mimalloc is byte-identical, no value
divergence. `fastRenorm` is Class 2: flipping it on the multi *entry* today
would silently change every existing multi consumer's geometry with no
`session.lane` to read, no provenance tags, no export refusal — exactly the
ambient hazard §14.1 exists to forbid (and the same shape as the tube-lane
rule: value-affecting selection must be lane-explicit, never silent).
V0.5 lands next in sequence and binds `fastRenorm: true` into the named
`'fast'` bundle, where the choice is visible, keyed, and refusable. Nothing
is deferred beyond that adjacent move.

## What landed

- **`createPico({ fastRenorm })`** — session-wide default for the offset
  family (`offset`/`doubleOffset`/`smoothen`/`fillet`/`shell`), library
  default `false` = the byte-locked upstream path. Resolution at each op:
  `options.fastRenorm ?? ctx.fastRenorm` — the §14.1 precedence rule
  (explicit per-op > session default > library default).
- **U22 filing text**: `upstream/pr-offset-renorm-default.md` — the
  ready-to-post PR body for `picogkruntime-offset-renorm-scheme.patch`
  (SECOND_BIAS default change, ask 2), with ask 1 offered as a follow-up.
  Posting remains operator-gated. `upstream/README.md` + the MIGRATING U22
  row updated in the same change (rule 5).

## Exit assertions

**1. Fast-lane offsets pass all SK-0.8 gates incl. the hard health
boolean.** `test/multi.test.ts`: a `fastRenorm: true` session on the MT
artifact — which is the mimalloc artifact since V0.3 — is **G0-identical to
the serial/dlmalloc artifact per op** (full `gridHash()` record equality:
digest + active/inside counts) across all five family members, and
`Voxels_bDiagnose` (openvdb `checkLevelSet`) returns clean on every
fast-lane output. The SK-0.8 tolerance gates (volume/area <3%, bounds <1
voxel) remain pinned per-op by the existing engagement test. Pre-commit
probe: 2 independent runs × 5 ops, single≡multi MATCH on every grid hash —
thread-count AND allocator independent.

**2. Default-lane bytes unchanged.** The library default is `false`; every
byte-locked fixture and the untuned-export bit-exact differentials passed
unchanged (suite green below). The precedence matrix additionally pins that
an explicit `fastRenorm: false` inside a default-on session restores the L0
path **exactly** (G0 hash equality with the default session's output), and
that the session default reproduces the per-op opt-in exactly.

**3. U22 filing text ready for the operator.**
`upstream/pr-offset-renorm-default.md`, cross-linked from the inventory and
the U22 ledger row.

**4. Suite**: 51 files, 476/476, coverage 100% enforced (both new `??`
branch sides exercised by the precedence matrix).

## Notes

- Cross-session comparisons in the new tests ride `voxels.gridHash()` — the
  V0.1 oracle doing exactly what it was built for (handle equality cannot
  cross sessions; canonical content identity can).
- The single-thread fastRenorm gates and the MT fastRenorm identity being
  clean means V0.5's `'fast'` bundle flips a **pre-certified** default: the
  bundle work is naming and keying, not new numerics.
