# SKv2-0 V0.8 — `bIsEqual` repair (T11)

**Verdict: LANDED.** `equals()` now rides `Voxels_bIsEqualFast`
(`src/pico-boolean.cpp`): the inside-set of each grid built in O(stored
nodes) — leaf-buffer scans with one `touchLeaf` per leaf, depth-capped tile
iterators (active AND inactive, the G0 OFF-stream lesson), **never
densifying** — compared tile-aware by dual `topologyDifference`. Upstream's
dense O(union-bbox³) serial accessor scan stays on the raw subpath as the
verdict oracle.

**Semantics preserved exactly**: transform inequality → false; classification
is `value ≤ 0` over stored values (NaN never inside, matching upstream's
`<=`); the degenerate non-positive-background case falls back to the
upstream scan. One documented divergence class: a negative inactive tile
lying wholly outside both grids' active bboxes would be seen by the mask and
missed by upstream's bbox-clipped scan — unreachable through the public
surface for well-formed pruned level sets (interiors are enclosed by their
narrow band).

## Exit assertions

1. **Representation-insensitivity differential green**: tile vs dense-leaf
   encodings of one field (`densifyInterior` arm) compare equal, and the
   verdict matches upstream's scan (`test/bisequal.test.ts`).
2. **Fixture classes, upstream-verdict-identical in both operand orders**:
   equal (clone), coincident-surface (interior crumb — whatever upstream
   says, fast says), sign-differ (one-voxel shift → false), disjoint
   satellite → false, `a−a` vs fresh empty, and the exact-zero boundary
   (implicit plane landing 0.0 on voxel centres: ≤0 classifies inside; a
   half-voxel nudge flips the verdict — the class a `<0` mask would break).
   Tier-2 C18 extends the ABI-level differential; R14 covers the export.
3. **Admissible under any gate**: the fast path returns upstream's verdict
   on every fixture — it changes no observable value anywhere (Class 0 on
   the comparison result itself).

## Measured stage speedup (this machine, single lane @0.1 mm)

| fixture | upstream scan | fast | ratio |
| --- | ---: | ---: | ---: |
| identical clones, interior-heavy sphere r=20 (worst case: full build + full compare, no early out) | 473.8 ms | 40.4 ms | **11.7×** |
| sparse: two r=8 spheres 100 mm apart, identical clones | 269.7 ms | 16.0 ms | **16.9×** |

The T11 census's "~100× stage" was an O(bbox³)→O(stored) *model* estimate;
the realized ratio is bbox³/stored-dependent and grows with sparsity. Two
implementation lessons recorded on the way (both measured): per-voxel
tree-level `setValueOn` costs a root-to-leaf descent per voxel and capped
the repair at ~2×; `voxelizeActiveTiles` on the mask is O(interior volume)
and did the same — the leaf-buffer + depth-capped-iterator + dual
`topologyDifference` shape is what delivers O(stored).

Suite: 492/492, coverage 100%; browser gate 3×17/17 (see commit). Ground
rule 8 discharged for the +1 export (BULK 17→18, counts 157→158, C18
extension, API-surface row).
