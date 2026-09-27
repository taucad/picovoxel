# SKv2-0 D-pre.4 — leaf-block-parallel ProjectZSliceFast

2026-07-31 · charter: `docs/research/picogk-webgpu-skv2-0-charter.md` §"Wave D
pre-req tasks" · runbook Iteration A3 · origin: V0.9 headroom + the
operator's maximalist mandate ("all algorithmic improvements, including this
leaf-block parallelism").

## What landed

`src/pico-zslice.cpp` — `Voxels_ProjectZSliceFast`'s column loop now runs
parallel (same export symbol, new internals; ground rule 8 does not trip):

1. `MarkColumns` unchanged (F15 culling).
2. The write set per column is the contiguous range `[iWLo, iWHi]` — exactly
   the coords the sweep + seal loops write (component-exact, empty sweep and
   zero-seal cases handled).
3. Serial `touchLeaf` pre-pass creates every leaf the writes will touch —
   the same leaf set the serial accessor would have created (voxelizing the
   same tiles), so the parallel phase never mutates tree topology.
4. `tbb::parallel_for` over 8×8 leaf-footprint blocks. A leaf's (x,y)
   footprint IS its block's footprint, so tasks share no leaf; reads are
   same-column only (reads outside the write range hit leaves/tiles no task
   writes); per-task accessors; `SweepColumn` value logic verbatim
   (min-propagation, average seal, `SetSd` clamp/off).
5. Terminal `pruneLevelSet` unchanged — restores tile topology, which is
   what makes the touched-leaf superset invisible post-prune.

Writes per voxel happen exactly once per phase, column-sequential ⇒ the
result is independent of scheduling and thread count: **Class 0 vs serial
by construction**, and measured.

## Gates

- **Suite** (504/504 @100% coverage, browser gate all engines): the V0.9
  fixture set — per-scale seal counts {1.5, 1.0, 0.5, 0.167} mm, 1.0 mm
  byte-coincidence vs the upstream raw export, single≡multi at 0.5 mm —
  plus the **new direct per-column min oracle** (`test/zslice.test.ts`):
  projected column values equal the running min of the column toward
  startZ, value-by-value on an analytic sphere, BOTH directions,
  float-exact. The oracle was validated against the serial build first
  (pre-rebuild) — it pins semantics, not implementation.
- **G0 pins**: `test/fixtures/g0-reference.json` unchanged (heatx@{1.0,
  0.7} multi) — no pin movement, as a Class-0 change demands.
- **Before/after differential** (old serial artifact vs new parallel
  artifact, same driver): hash-identical on every fixture × build —
  wide slab 100×100×4 mm @0.25 mm (~163k marked columns), sphere∪beam
  @0.25 mm, HeatX final @1.0 mm (`d62d8a54…`, the L0 reference hash).

## Stage timing (informational; min of 5 in-process repeats)

| fixture | single before→after | multi before→after |
| --- | --- | --- |
| slab@0.25 (163k columns) | 79→80 ms (1.0×) | 79→48 ms (**1.65×**) |
| sphere-union@0.25 | 6→7 ms | 7→5 ms (1.40×) |
| heatx@1.0 `outer-volume.project-z-slice` stage | 8→9 ms | 9→7 ms |

Single-build parity is expected — oneTBB inlines `parallel_for` serially
without pthreads, and the pre-pass/grouping overhead is noise-level. The
multi win is bounded by memory-bound per-column accessor traffic and the
serial mark + touch phases; the V0.9 culling already removed the O(bbox)
term that dominated upstream, so this rung buys the residual column work.
HeatX's stage was already ~8 ms at 1.0 mm post-V0.9 — the parallel rung
matters for wide-slab-shaped parts, not the corpus center.

## Notes

- H1 not triggered (no `patches/`/fetch-deps change); H2 done (both
  artifacts rebuilt and exercised by suite + browser gate + differential).
- G3 structural review is the design argument in the TU comment (block
  ownership of leaf stacks, no shared mutable state, order-free column
  set); the permutation oracle is subsumed by Class-0 identity vs serial.
