# SKv2-0 V0.1 — G0 oracle productionized

**Verdict: LANDED.** The canonical grid hash is in-module, the identity
harness and per-commit gate are wired into the suite, and every exit
assertion holds. Machine: Apple M2 Pro (12 cores, 32 GiB), AC power,
`pmset` low-power OFF. (Identity work is load-insensitive — §14.3 — so load
is recorded per record, never controlled.)

## What landed

| Piece | Where |
| --- | --- |
| Canonical grid hash, in-module | `src/pico-hash.cpp` — `Voxels_GetGridHash`: deep-copy → `voxelizeActiveTiles` → serial `pruneLevelSet` normalization, then XXH3-128 over the tagged depth-first streams: active (coord, canonical bits) + negative inactive tiles/leaf-voxels (dim, coord, canonical bits). −0.0→+0.0, NaN→`0x7fc00000` (§14.5). Positive/absent inactive regions are one class by design. |
| Self-test densifier | `Voxels_DensifyInterior` (same TU) — same field, dense-leaf representation, for the tile-vs-dense pair. |
| Facade | `voxels.gridHash()` / `voxels.densifyInterior()` (`src/voxels.ts`; unsigned-shift discipline; surface manifest + API surface spec updated). |
| Hash dependency | xxHash v0.8.3 single header, pinned + sha256-verified in `scripts/fetch-deps.sh`, BSD-2 attribution in `NOTICE`. |
| Harness | `bench/g0-identity.mjs` — `record` / `triple` (N-run identity) / `sweep` (release shape) / `selftest`; reuses the §14.5-reconciled multiset oracle from `bench/stl-identity.mjs` (which gained an import guard). |
| Per-commit gate | `test/g0-gate.test.ts` — HeatX multi @ {1.0, 0.7} mm, N=2 identity + pinned reference (`test/fixtures/g0-reference.json`, UPDATE_PINS=1 protocol). Runs inside `npm test`. |
| Self-tests | `test/grid-hash.test.ts` (5 tests) + `g0-identity selftest` (comparator mutation coverage, field by field). |

## Exit assertions

**1. Grid-hash self-test green.** `test/grid-hash.test.ts`, 5/5:

- *Tile vs dense-leaf encodings of one field hash equal*, proven twice:
  - `densifyInterior` on the r=8 sphere (8 interior tiles): memUsage moves
    (1,592,720 → 1,609,872 B; r=12: 1.99 → 2.17 MB, 84 tiles; r=16: 2.64 →
    3.22 MB, 274 tiles), the **full tuple does not** — hash, activeVoxels,
    insideTiles, insideOffVoxels all invariant.
  - §14.5's named pair: the interval-pruned **tape** render vs the dense
    serial **callback** render of the same implicit produce one tuple.
- Determinism + purity: repeated hashing bit-stable; hashing never mutates
  the grid (memUsage, volume pinned across calls).
- Discrimination: surface change, disjoint crumb (a sub-3%-volume addition
  tolerance gates would pass), and interior-only hollowing all move the hash.
- Fixture honesty: the tile-pair test asserts `insideTiles > 0` — the r=5
  sphere has **zero** interior tiles at 0.4 mm and would vacuously pass.

**2. Harness catches a seeded fault (mutation test).**

- Comparator level: `g0-identity selftest` mutates every G0 field
  individually and asserts each is flagged, plus the four
  oracle-agreement quadrants.
- System level: an SK-0.10-class readback truncation seeded into
  `src/mesh.ts` (drop the last triangle at the subarray boundary — the
  clamp signature: field intact, extraction short) is caught as a
  **field/mesh oracle DISAGREE**:

  ```
  seeded: (trianglePointer >>> 2) + triangleCount * 3  →  … * 3 - 3
  baseline gyroid@0.25/single: grid bea5ee5c95511b15…  multiset 0f0f14eb4e35d9bc…
  mutated  gyroid@0.25/single: grid bea5ee5c95511b15…  multiset 5a7e32e142bcb9a2…
  differing fields: [ 'multiset' ]   oracles agree: false
  PASS: seeded readback fault caught as an oracle disagreement
  ```

  Instructive detail: the wrapper's `triangles`/`vertices` **count fields
  stayed right** (they come from the ABI count calls, not the array) — the
  SK-0.10 lesson verbatim, "geometry that still has the right triangle
  count". Only the multiset saw it. Count checks alone are not an oracle.

**3. Per-commit gate ≤ 5 min.** Both scales, N=2 each + reference:
**105.2 s** wall on the reference machine (~698% CPU). Reference pins:

| | grid hash | active | inside off-vox | triangles | multiset (prefix) |
| --- | --- | ---: | ---: | ---: | --- |
| heatx@1.0 mm | `d62d8a54aa9cf7f4a44b6d80d1c71ab5` | 1,447,517 | 9,451 | 1,873,340 | `2d4f19b600d4afa1…` |
| heatx@0.7 mm | `056d67cb4a627bbbb650959a09c8fe14` | 3,935,498 | 106,223 | 4,542,744 | `4f2a102033402c30…` |

(HeatX has `insideTiles = 0` at these scales — thin-walled throughout; the
negative leaf off-voxel stream carries its interior classification.)

**4. Multiset tool + grid hash agree on the corpus.** Every identity pair
run to date agrees (the harness enforces agreement as a hard failure —
`oraclesAgree`): gyroid@0.25 multi ×3 ≡ single ×2 cross-lane
(grid `bea5ee5c95511b15…`, multiset `0f0f14eb4e35d9bc…`, 538,668 tris);
HeatX per-commit N=2 at both scales; release sweep below.

## Release sweep (the §14.3 release shape)

`node bench/g0-identity.mjs sweep --runs 2` — HeatX {1.0, 0.7, 0.5} mm +
gyroid 0.25 mm, single and multi, run-to-run + cross-lane:

**All 16 runs G0-identical within their cells; all 4 cross-lane pairs
identical; oracles agree on every pair; zero non-finite records.** Records:
`skv2-0-v0.1-sweep.jsonl` (this directory).

| Fixture | grid hash (prefix) | multiset (prefix) | tris | single wall ×2 | multi wall ×2 |
| --- | --- | --- | ---: | --- | --- |
| heatx@1.0 | `d62d8a54aa9cf7f4` | `2d4f19b600d4afa1` | 1,873,340 | 41.9 / 41.6 s | 18.4 / 20.5 s |
| heatx@0.7 | `056d67cb4a627bbb` | `4f2a102033402c30` | 4,542,744 | 105.1 / 104.9 s | 29.4 / 33.6 s |
| heatx@0.5 | `32756af98f7618f3` | `5004008b41709536` | 10,047,988 | 258.6 / 257.2 s | 54.5 / 62.8 s |
| gyroid@0.25 | `bea5ee5c95511b15` | `0f0f14eb4e35d9bc` | 538,668 | 0.64 / 0.60 s | 0.72 / 1.14 s |

(Wall times are end-to-end record production under recorded ambient load
2.3–8.2 — identity evidence, not timing claims. The 0.5 mm legs crossed the
1 GiB native-memory warning as expected; the SK-0.9/0.10 defect region —
>2 GiB heap on the multi lane — is exercised and clean.)

## Notes for later moves

- The grid hash is index-space only (transform outside the hash); the tuple
  pins world scale through volume/counts. Two grids at different voxel
  sizes with identical index content would need the tuple, not the hash
  alone.
- `Voxels_GetGridHash` costs a transient deep copy (2× grid memory) —
  fine for gates; V0.15/M1 should note it if hashing at 0.35 mm peaks.
- Serial normalization + hash: O(active + leaves·512 + tiles). HeatX@0.7
  hashes in single-digit seconds inside the gate budget; nobody needs a
  parallel oracle yet (and a boring serial one is the point).
- `stl-identity.mjs` CLI is now import-guarded (`isMain`) — it was running
  its CLI dispatch on import.
