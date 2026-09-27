# SKv2-0 V0.3 — mimalloc = fast-lane MT default

**Verdict: FLIPPED.** `scripts/build-pico-module.sh` now defaults the MT
artifact (`pico-multi`) to `-sMALLOC=mimalloc`; the serial artifact — the L0
oracle lane and the shipped single-thread default — stays dlmalloc. `MALLOC=…`
still overrides either default for A/B runs. Executes the SK-0-EXIT decision
table's recommendation (2.164× [2.141–2.178] multi construct, byte-identical
across all 64 exit-baseline comparisons); NON-DETERMINISM §12.3 closed.

**Tree under test**: `4e59091` + this move's working changes (build-script
default, `src/multi.ts` doc note, rebuilt `pico-multi.{mjs,wasm}`). Machine:
Apple M2 Pro 12-core / 32 GiB, AC power, `lowpowermode 0` (verified).

## Builds

`-sMALLOC` is link-time only; neither `patches/` nor `scripts/fetch-deps.sh`
changed, so H1/H1b did not apply. H2 satisfied: the tracked
`src/pico-multi.{mjs,wasm}` pair is the rebuilt mimalloc artifact.

| artifact | dlmalloc (old, tracked) | mimalloc (new default) | Δ |
| --- | ---: | ---: | ---: |
| `pico-multi.wasm` | 5,898,977 | 5,964,762 | +65,785 |
| `pico-multi.mjs` | 97,364 | 99,292 | +1,928 |

The +65.8 KB matches the known mimalloc link delta (SK-0.1 +65,634,
SK-0-EXIT +65,786). `src/pico.wasm` (single, gitignored) untouched — its
build inputs did not change.

## Exit assertions

**1. Fast-lane suite green.** `npm test` on the flipped artifact: 51 files,
**474/474**, coverage enforced at 100% (488.7 s wall). This includes the G0
per-commit gate: the reference pins in `test/fixtures/g0-reference.json` were
generated on the dlmalloc multi artifact and **held unchanged** — the
byte-identity finding, re-confirmed at the grid-hash level on every push from
now on.

**2. G0 identity vs L0 at 3 scales.** Release sweep
(`node bench/g0-identity.mjs sweep --runs 2`, JSONL:
`skv2-0-v0.3-sweep.jsonl`): **16/16 runs G0-identical, 4/4 cross-lane
single≡multi** at 1.0/0.7/0.5 mm HeatX + 0.25 mm gyroid, dual oracles agree
on every record. Every grid/multiset hash equals the V0.1 dlmalloc-era sweep
values (`d62d8a54…`, `056d67cb…`, `32756af9…`, `bea5ee5c…`) — the flip moved
no geometry byte anywhere the oracle can see.

**3. Measured speedup vs the exit baseline (ground rule 6 re-baseline).**
One quiet block (BENCH_REPEATS=10, load guard armed, start load 4.15 < 6.0)
on the new dual-lane default state, recorded as
`skv2-0-v0.3-baseline-mimalloc-default.json` (copy of
`bench/results/2026-07-27-4e59091.json`), compared with
`bench/compare-baselines.mjs` (conservative unpaired CI) against
`sk-0-exit-baseline-dlmalloc.json`:

| phase | exit baseline (dlmalloc) | this block (mimalloc multi) | speedup | 95% CI |
| --- | ---: | ---: | ---: | :---: |
| M12@multi `construct` | 16,685 ms | 8,389 ms | **1.989×** | 1.967–2.012 |
| M12@multi `kernel:io-threads.create` | 6,442 ms | 1,461 ms | 4.409× | 4.336–4.478 |
| M12@multi fin kernels (4×) | — | — | 4.6–4.8× | — |
| M10@multi `mesh` | 32.7 ms | 12.9 ms | 2.541× | 2.269–2.744 |

**The untouched lane is the drift control**: every single-thread phase runs
on the byte-identical dlmalloc artifact yet reads a uniform 0.88–0.97×
(e.g. M12@single construct 0.945× [0.941–0.948]) — cross-day machine drift,
all one direction, tightly clustered. Against that ~5% headwind the multi
construct still shows 1.989×; drift-adjusted (1.989 ÷ 0.945 ≈ 2.10×) it sits
inside the ABAB table's 2.141–2.178 neighborhood. The ABAB table remains the
precision measurement; this block is the rule-6 record of the flipped
default, not a re-litigation of the decision.

**4. L0 pins byte-identical.** The single/dlmalloc artifact was not rebuilt
(inputs unchanged); every byte-locked snapshot fixture passed in the suite;
the G0 pins (assertion 1) held.

**5. Browser gate.** 3 engines × 17/17 on the flipped multi artifact
(chromium/firefox/webkit — see commit).

## Notes

- The known recorded costs stand unchanged from SK-0-EXIT and are not
  re-measured here: `M10@multi/render` 0.723× (thread-pool + first-touch
  segment cost per session) and the 0.4 mm memory headroom (mimalloc
  0.24 GiB vs dlmalloc 0.66 GiB to the wasm32 ceiling) — the latter feeds
  V0.15/M1.
- `M11` (gear @ 0.15 mm, single-lane) and all other single-lane metrics are
  dlmalloc and were expected flat; they read as the drift control above.
- Ledgers updated in the same change: `NON-DETERMINISM.md` §12.3 outcome
  line, `WORKLOAD-EXECUTORS.md` banner. No upstream patch was touched — the
  allocator is our link-time build config — so `MIGRATING-FROM-CSHARP.md`
  is not part of this diff (rule 5 not triggered).
