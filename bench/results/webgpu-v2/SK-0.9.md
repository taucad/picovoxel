# SK-0.9 — allocator-divergence diagnosis and the mimalloc MT re-verdict

**Date**: 2026-07-27 · **Branch**: `webgpu` · **Tree under test**: `3284423`
(working tree clean apart from the three never-staged operator files and a
concurrently-authored `NON-DETERMINISM.md` §14 addendum)
**Closes**: `NON-DETERMINISM.md` §11 items 1 and 2.

## Verdict

Both preconditions are answered, and the second one **fails hard**.

1. **§11.1 — the single-path allocator divergence no longer exists.** dlmalloc
   single and mimalloc single are **byte-identical** at 0.5 mm and 0.7 mm on the
   current tree. There is no Class-1 residual and no UB to hunt on that path; the
   `0ccaa277` vs `38cad381` divergence was a property of an earlier lattice lane
   and died with it. No sanitizer run was needed (see §6 for what would have been
   done and what the toolchain would have allowed).
2. **§11.2 — mimalloc multi is a NO-GO, and not for the reason anyone expected.**
   It is not "geometry-stable, byte-unstable". At 0.5 mm it silently emits a
   **corrupt mesh**: 9,231,100 of 10,047,988 STL records (91.9%) carry NaN
   coordinates, because 27,676,231 of 30,143,964 triangle indices (91.8%) are
   out of range and the maximum index is `0xFFFFFFFF` — OpenVDB's
   `util::INVALID_IDX`. At 0.6 mm one of two runs **trapped** (`Illegal
   instruction: 4`). Volume hex, triangle count and STL byte count match the
   reference *exactly* through all of it. This is Class X wearing Class 1's
   clothes, and volume+count gates pass it.

dlmalloc multi is clean and byte-stable: 3/3 at 0.5 mm, 1/1 at 0.6 and 0.7 mm,
all byte-identical to the single-thread reference.

**Consequence for the program**: `NON-DETERMINISM.md` §5's "flip mimalloc on the
fast lane" and §12.3 are **blocked on a defect, not on ceremony**. The 1.208×
must not be spent.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 (macOS 26.5.2) / v26.5.0 |
| Power | **battery, discharging 58% → 20%**, `lowpowermode 0` |
| 1-min load at run starts | **4.4 – 21.5** (heavy, uncontrolled) |
| emcc | 5.0.1 (vendored emsdk) |

This is a determinism run: no wall-clock claim is made anywhere in this document
and load was deliberately not gated. Load is not a confound for the verdict —
the clean configurations returned bit-exact matches at loads of 13–21 while the
dirty ones diverged at loads of 12–21. The `taskMs` column in the raw records is
recorded for completeness and must not be quoted as a benchmark.

The battery constraint truncated two planned-but-non-decisive run sets; they are
listed in §7 as open items, and neither can change the verdict above.

## 1. The oracle: `bench/stl-identity.mjs`

The G0 order-invariant mesh multiset hash `NON-DETERMINISM.md` §6 and §12.1 call
for, plus the scalar identities, over binary STL bytes. Also `diff` (first
divergence + displacement search), `run` (HeatX + identity record), and
`selftest`.

**Construction.** A binary STL record is 50 bytes: 12 little-endian f32 (facet
normal, then three vertices), then a 2-byte attribute word this writer always
zeroes (`src/stl.ts`). The **geometric payload is the first 48 bytes** and is
hashed **verbatim as bytes** — not via decoded JS numbers, so `-0.0`/NaN payload
bits cannot be laundered by the conversion.

- per-record `d_i = SHA-256(payload_i)`, read as a 256-bit big-endian integer;
- combined `H = (Σ d_i) mod 2^256`, accumulated in 8 `uint32` limbs with carry.

**The normal is included, deliberately.** It is a pure function of the three
vertices (`normalize(cross(v2−v1, v3−v1))`, computed in f64 then rounded to f32
by the same writer for every build), so it adds no independent degree of
freedom. It does make a record sensitive to *vertex rotation within a facet* —
a real difference we want to see rather than fold away.

**Why the combiner is safe.**

- *Not XOR*: XOR is multiplicity-blind — any record occurring an even number of
  times cancels, so "one facet duplicated, another dropped" can vanish. Modular
  addition preserves multiplicity, which is what makes this a genuine *multiset*
  hash.
- *Not a sum of weak hashes*: a commutative combination of 32/64-bit hashes
  (FNV, CRC) collides by birthday at ~2^16 / ~2^32 records; a 10 M-triangle mesh
  is already past that for 32-bit.
- *With SHA-256 digests* the summands are computationally indistinguishable from
  uniform 256-bit values, so two distinct multisets landing on the same sum is a
  ~2^-256 event. Every input here (allocator order, thread schedule,
  uninitialised reads) is **non-adversarial**; the bar is "cannot happen by
  accident", and 2^-256 clears it by ~70 orders of magnitude over the 10^7
  records in play. Deliberately constructing a collision is a 256-bit
  generalized-birthday/subset-sum problem, and nothing here is a trust boundary.

**Hard health boolean, added mid-spike and load-bearing.** `nonFiniteRecords`
counts records with any non-finite f32. `src/stl.ts` writes NaN when a triangle
index points past the vertex array (JS `undefined` through `Math.fround`), so
this counter is the cheapest possible detector of out-of-range indices in an
extracted mesh. **It is what turned "the multiset moved" into a diagnosis in one
pass.**

**Self-check**: `node bench/stl-identity.mjs selftest` — permutation invariance,
content sensitivity, the XOR trap (`{1,1,2}` vs `{2,2,2}` XOR alike and must not
sum alike), 256-bit width, and full-width carry wraparound. Assert-based, no
framework.

### Reconciliation with `NON-DETERMINISM.md` §14.5

§14.5 (authored concurrently with this spike, in the same working tree)
specifies a slightly different construction. Deviations here, all deliberate:

| §14.5 | this tool | why |
| --- | --- | --- |
| 128-bit xxh3/BLAKE3 per record | SHA-256 per record | node stdlib, no dependency; ~20 s over a 502 MB stream, which is not the bottleneck. Strictly stronger. |
| 36-byte vertex-only payload | 48-byte payload incl. normal | task-directed; the normal is derived, so this costs nothing and buys facet-rotation sensitivity. |
| record count folded into the hash | count carried as a sibling field (`triangles`) and compared alongside | equivalent discriminating power for comparison; folding it in would have invalidated every hash in this document for no gain. |
| canonicalize `−0.0 → +0.0`, `NaN → 0x7fc00000` before hashing | raw f32 bits | **the canonicalization is right for a cross-lane hash and would not have masked this defect** (all NaNs collapsing to one value still differs from the correct finite value) — but it is exactly why `nonFiniteRecords` must ship *with* any NaN-canonicalizing hash rather than instead of it. Recorded as a rider on §14.5. |

Whoever lands the §12.1 G0 tooling should treat this file as the starting point
and either adopt the §14.5 payload/canonicalization or amend §14.5; the two
should not both stand.

> **RECONCILED 2026-07-27 (SK-0.10).** `bench/stl-identity.mjs` now uses the
> §14.5 construction: 36-byte vertex-only payload (normal dropped) and
> `−0.0 → +0.0` / `NaN → 0x7fc00000` canonicalization before hashing, with
> `nonFiniteRecords` kept as the separate hard health boolean. SHA-256 and the
> sibling record count stay as deviations, argued in `SK-0.10.md` §7.
> **Consequence for this document: every `multiset` value below — §4's two
> tables and all 17 records in `sk-0.9-oracle.jsonl` — is in the old 48-byte
> uncanonicalized construction and is NOT comparable to any value in
> `SK-0.10.md`.** Neither is rewritten (they are evidence of runs that happened,
> and the jsonl is sha256-pinned). `stlFnv`, `sha256` and `volumeHex` are
> unaffected and remain directly comparable across both documents.

## 2. Builds

Four artifacts, one toolchain state, allocator as the only delta. `scripts/
fetch-deps.sh` re-verified as a **no-op** (stamps match `patches/*` hashes), and
the dep prefixes postdate the last dep-patch change, so H1/H1b did not apply —
no `fetch-deps`/patch change was made in this spike.

| artifact | dlmalloc | mimalloc | Δ | sha256 (wasm) |
| --- | ---: | ---: | ---: | --- |
| `pico.wasm` | 5,875,598 | 5,940,852 | +65,254 | `acb27739…` / `34ce6402…` |
| `pico-multi.wasm` | 5,873,395 | 5,939,181 | +65,786 | `17ff421b…` / `320f5622…` |

The +65 KB confirms `-sMALLOC=mimalloc` took effect. The freshly built dlmalloc
`pico-multi.wasm` came out **byte-identical to the committed artifact**
(`git status` clean) — an unplanned build-reproducibility confirmation.
`src/pico.wasm` was left as the dlmalloc single build per H2.

## 3. §11.1 — the single-path divergence: GONE

| build | cell | triangles | volume hex | sha256 (STL) | verdict |
| --- | ---: | ---: | --- | --- | --- |
| dlmalloc single | 0.7 | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | — |
| mimalloc single | 0.7 | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | **Class 0** |
| dlmalloc single | 0.5 | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | — |
| mimalloc single | 0.5 | 10,047,988 | `4121d9c600000000` | `5d9fa0ee582a…` | **Class 0** |

Multiset hashes agree trivially (the streams are byte-identical). 0.5 mm is the
exact cell where SK-0.1 recorded `0ccaa277` (mimalloc single) ≠ `38cad381`
(dlmalloc single). **It does not reproduce.**

### What closed it

The triangle counts moved: 10,048,032 → **10,047,988** at 0.5 mm and
4,542,736 → **4,542,744** at 0.7 mm, with volume hex unchanged. That is the
SK-0.4 signature exactly (`test/examples-helixheatx.test.ts` documents the +8 at
0.7 mm as the tube-complex pin move), so the geometry under test is the new
`Voxels_RenderLatticeTubes` lane, not the serial `Voxels_RenderLattice` lane
that carried the divergence.

So the §11.1 hypothesis — an uninitialised read somewhere in *extraction* — was
looking in the wrong place. Extraction is shared by both lanes and both
allocators, and it is byte-clean here. The divergence tracked the **lattice
construction** lane, which SK-0.4 replaced wholesale with
`createLevelSetTubeComplex` under `parallel_deterministic_reduce`.

This is a *localization by displacement*, not a root cause: the old lane is
still reachable behind `PICOVOXEL_SERIAL_LATTICE=1`, and the confirming A/B
(dlmalloc single vs mimalloc single at 0.5 mm **under that flag**) is the one
run set the battery budget did not permit. It is recorded as an open item (§7),
but it is a post-mortem on dead code: the flag is an escape hatch, not a lane
anyone ships. **The §11.1 blocker itself is cleared either way** — the shipping
default has no residual.

## 4. §11.2 — the mimalloc MT re-verdict

All runs on the current tree, one run per process. `nonFinite` is blank where
the run predates the counter landing mid-spike.

### 0.7 mm — clean

| run | build | triangles | volume hex | sha256 | multiset (16) | verdict |
| --- | --- | ---: | --- | --- | --- | --- |
| 1 | mimalloc multi | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `b1a6c4fc16709000` | ≡ ref |
| 2 | mimalloc multi | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `b1a6c4fc16709000` | ≡ ref |
| 3 | mimalloc multi | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `b1a6c4fc16709000` | ≡ ref |
| 1 | dlmalloc multi | 4,542,744 | `4121ffe5a0000000` | `8f2eb25972e1…` | `b1a6c4fc16709000` | ≡ ref |

All four builds (both allocators × single/multi) are byte-identical at 0.7 mm.

### 0.6 mm — one trap in two runs

| run | build | result |
| --- | --- | --- |
| 1 | mimalloc multi | **`Illegal instruction: 4`** — process aborted, no output |
| 2 | mimalloc multi | clean: 6,560,024 tris, `4121db1ee0000000`, sha `1a9864eae4c5…`, nonFinite 0 |
| 1 | dlmalloc multi | clean: identical to run 2 above |

The trap is the same defect surfacing as a hard failure instead of a silent one.
It is *not* the R12 OOM signature (`RangeError: offset is out of bounds`) — that
one is a JS-side exception; this is a wasm-side abort.

### 0.5 mm — silently corrupt, every run

| run | build | triangles | volume hex | STL bytes | sha256 | multiset (16) | nonFinite |
| --- | --- | ---: | --- | ---: | --- | --- | ---: |
| 1 | mimalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `f883d7e11092…` | `2c84efb61209a29e` | — |
| 2 | mimalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `074bf0f1803a…` | `ab9022b5cd6e8cbe` | — |
| 3 | mimalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `452bcb9bc144…` | `286f79c6ce7ddfe8` | — |
| 4 | mimalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `a4697387cc5b…` | `2951e8cf66bf76bd` | **9,231,100** |
| 1 | dlmalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `5d9fa0ee582a…` | `f5b926dc3a2fff69` | — |
| 2 | dlmalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `5d9fa0ee582a…` | `f5b926dc3a2fff69` | **0** |
| 3 | dlmalloc multi | 10,047,988 | `4121d9c600000000` | 502,399,484 | `5d9fa0ee582a…` | `f5b926dc3a2fff69` | **0** |

**Four mimalloc-multi runs, four distinct multiset hashes.** Not a permutation —
the record *content* differs run to run. dlmalloc multi is 3/3 identical to the
single-thread reference.

### Verdict table

| question | answer |
| --- | --- |
| mimalloc multi byte-stable? | **no** — 4 runs, 4 byte streams at 0.5 mm |
| mimalloc multi geometry-stable (multiset invariant)? | **no** — 4 runs, 4 multisets |
| mimalloc multi *correct*? | **no** — 91.9% NaN records at 0.5 mm; a hard trap at 0.6 mm |
| would volume + triangle count have caught it? | **no** — both match the reference bit-for-bit in every corrupt run |
| dlmalloc multi byte-stable? | **yes** — 3/3 at 0.5 mm, ≡ single, ≡ the 1.0/0.7 mm references |
| is the 1.208× spendable? | **no** |

## 5. Mechanism

`bench/stl-identity.mjs diff` put the first divergence at **record 0** — the very
first triangle — with all twelve floats NaN on the mimalloc-multi side and the
record absent anywhere in the corrupt stream. A direct probe of the mesh arrays
(`mesh.vertexCount`, `mesh.vertices`, `mesh.triangles`) on a mimalloc-multi
0.5 mm run:

```
vertexCount        4,928,264      (vertex array length 14,784,792 = 3 × count ✓)
triangleCount     10,047,988      (index array length 30,143,964 = 3 × count ✓)
nanVertices                0      ← the vertex data is intact
maxTriangleIndex  4,294,967,295   ← 0xFFFFFFFF = openvdb util::INVALID_IDX
oobIndices        27,676,231      ← 91.8% of indices point past the vertex array
peak heap              2.68 GiB
```

Readings:

- **The corruption is in the index array only.** Vertices are finite and
  correctly counted; the NaNs in the STL are manufactured downstream by
  `src/stl.ts` reading `vertices[oob]` → `undefined` → `Math.fround(NaN)`.
- **The garbage value is `INVALID_IDX`, not random.** `constructPolygons`
  initialises `Vec4 quad(0,0,0,0)` and fills corners via
  `idxAcc.probeValue(coord, quad[k])`, which writes the point-index tree's
  *background* — `util::INVALID_IDX` — when the probe misses, and then gates
  emission on `if (activeValues)`. `INVALID_IDX` reaching output means either
  the guard was bypassed, or the consumer read quad slots the emitter never
  wrote. A recycled-allocation footprint fits: ~8% of the indices are plausible
  values interleaved with the sentinel, which is what stale heap from a previous,
  differently-sized index buffer looks like — not what a fresh `mmap` page (all
  zeros, which is what dlmalloc hands out here) looks like. **That is why
  dlmalloc masks it and mimalloc exposes it.**
- **This is the `NON-DETERMINISM.md` §11.1 uninitialised-read hypothesis,
  vindicated on the wrong path.** The hypothesis named
  `openvdb`'s deliberately-uninitialised arrays and "flat-quad upper-bound slack"
  as candidates. It was wrong about *where* (multi, not single) and wrong about
  *when* (now, not historically), but right about *what*.
- **Peak heap is the covariate that tracks the onset**: mimalloc multi runs at
  1.44× dlmalloc's peak at 0.6 mm (2.23 vs 1.55 GiB) and 1.26× at 0.5 mm (2.74
  vs 2.18 GiB), against the 4 GB wasm32 ceiling. Onset is at ≤0.6 mm
  (intermittent) and 0.5 mm (every run). Whether the trigger is allocation
  *pattern* or allocation *pressure* is not established.
- **Not established here**: whether the unwritten/overread slots are in
  `mFlatQuads` (`patches/openvdb/0001-flat-quad-output.patch`), in the
  `PicoGK::Mesh` triangle array behind `BulkResize`
  (`patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch`), or in
  upstream `VolumeToMesh`'s point-index tree. Both patches are ours and both are
  in the suspect set; a patch-toggle matrix of the SK-0-P0 shape (flat-quad on/off
  × parallel-flatten on/off, mimalloc multi @0.5 mm, N≥3) decides it in one pass
  and is the recommended next step. **No fix is attempted here — the diagnosis
  does not yet name a line, so the fix is not small-and-obvious.**

**Scope note, important**: every corrupt run is on the **mimalloc** artifact,
which is not a default anywhere and is not shipped. The dlmalloc multi default is
clean in 5/5 runs across three cells. This is a blocker on the mimalloc flip, not
a live production defect — but it is a live *latent* defect, since the same code
is one link-time flag away from executing.

## 6. Sanitizers — not run, and why

> **Rider (2026-07-27, WASM-RUNTIME.md):** route (2) — "a wasm64 build to fit
> the ASan shadow" — is permanently closed: emscripten hard-errors on
> MEMORY64+ASAN (`vendor/emsdk/upstream/emscripten/tools/link.py:764`;
> upstream #21029). The sentinel debug-fill probe is the standing instrument
> for big-heap diagnostics, alongside the native lane.


The §11.1 escalation path ("rebuild the serial variant with emscripten
sanitizers") was not exercised, for a reason that superseded it rather than a
toolchain obstacle: **the serial variant has no divergence left to sanitize**
(§3). Pointing ASan at a byte-clean configuration measures nothing.

The configuration that *does* misbehave is the mimalloc **multi** build, and
there the route is genuinely obstructed, on three independent counts, none of
which was worked around because the patch-toggle matrix (§5) is strictly cheaper:

1. `-fsanitize=address` under emscripten replaces the allocator with ASan's own.
   That **removes the independent variable** — an mimalloc-vs-dlmalloc defect
   cannot be observed on a build where neither allocator runs.
2. ASan's shadow memory costs roughly 1/8 of the address space on top of a run
   already peaking at 2.7–2.9 GiB against the 4 GB wasm32 ceiling; the 0.5 mm
   fixture is the only cell that reproduces, and it is the cell least likely to
   fit.
3. `-sSAFE_HEAP=1`, the cheap first pass, detects out-of-bounds and misaligned
   linear-memory access. The reads here are **in-bounds** — the quad slots are
   inside a legally allocated array, they simply hold stale contents — so
   SAFE_HEAP is structurally blind to this defect.

The honest statement: the ASan route is **impractical for this specific defect**,
not for this toolchain in general. If the toggle matrix fails to localize, the
next instrument is a debug-fill probe (memset the flat-quad array and the
`BulkResize` triangle array to a recognizable sentinel before emission and assert
no sentinel survives into the mesh) — which costs one rebuild, keeps both
allocators intact, and answers "unwritten or overread" directly. That is a
cheaper and better-aimed instrument than ASan here.

## 7. Open items (battery-truncated, none verdict-changing)

1. `PICOVOXEL_SERIAL_LATTICE=1` A/B at 0.5 mm, dlmalloc single vs mimalloc
   single — confirms §3's attribution of the historic divergence to the retired
   serial lattice lane. ~10 min of compute. Post-mortem on an escape hatch.
2. mimalloc **single** at 0.5 mm ×3 for repeat stability (1/1 measured, and it is
   byte-equal to dlmalloc, so instability would have to be a coincidence of
   equalities).
3. The §5 patch-toggle matrix. **This is the real next spike.**
4. `nonFiniteRecords` was added mid-spike, so the eight earliest records lack it.
   The two dlmalloc-multi runs that carry it read 0.

## Files

- `bench/stl-identity.mjs` — the oracle (`hash` / `diff` / `run` / `selftest`).
- `bench/results/webgpu-v2/sk-0.9-oracle.jsonl` — 17 run records (the 0.6 mm
  mimalloc trap produced no record; it is documented in §4 only).

```
dea85002bb8daf75f1e8cbc3b65952c7e7276f742871991e36f6ed968708f0c4  sk-0.9-oracle.jsonl
```

```
node bench/stl-identity.mjs selftest
node bench/stl-identity.mjs run --build multi --size 0.5 --label x --jsonl out.jsonl --dump x.stl
node bench/stl-identity.mjs hash a.stl b.stl
node bench/stl-identity.mjs diff a.stl b.stl
```
