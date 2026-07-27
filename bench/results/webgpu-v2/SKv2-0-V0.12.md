# SKv2-0 V0.12 — U18 ingest half: LatticeBeam by value

**Verdict: LANDED, with an attribution correction.**
`patches/PicoGKRuntime/0003-lattice-beam-value-storage.patch` stores beams
as `std::vector<LatticeBeam>` (emplace_back; accessor + render loop deref
updated; our `src/pico-lattice.cpp` consumer updated in the same change).
Class 0 by construction — identical values, identical iteration order.

## Measured (paired, 400k-beam bulk ingest, ns/beam)

| lane | before | after | ratio |
| --- | ---: | ---: | ---: |
| single / dlmalloc | ~16.1 | ~15.3 | 1.05× |
| multi / mimalloc | ~19.9 | ~18.1 | 1.09× |

**The SK-0.3 attribution ("20.9 of 39.2 ns/beam is C++-side allocation") was
wrong as a make_shared claim**: removing the per-beam `make_shared` recovers
under 2 ns/beam on either allocator — the 20.9 ns lump was ctor math + bbox
include + allocation together, and a warm free list allocates small objects
in single-digit nanoseconds. Recorded as a negative-result correction per
program discipline; the WORKLOAD row's "kills the 20.9 ns residual" framing
is retired.

**What stands, and why the patch ships anyway**: (a) the beam array is now
CONTIGUOUS — the GPU-upload seam the harmonic S-A substrate requires
(32 B/beam as a vec4 pair, uploadable without a staging copy); (b) simpler
upstream code (no shared ownership existed anywhere); (c) one fewer pointer
chase on the retired serial lane and in C#.

## Gates

- Patch verified by **replaying the real pipeline**: `fetch-deps` re-extract
  + apply reproduces the hand-verified tree byte-for-byte (stronger than a
  dry-run). Dep prefixes untouched (no dep-archive patch changed — H1 scope
  note: the wipe applies to tbb/openvdb patch changes; PicoGKRuntime sources
  recompile in every artifact build).
- G0: full suite incl. the per-commit pins and every lattice-heavy
  byte-locked fixture (see commit) — Class 0 means zero movement anywhere.
- MIGRATING U18 row updated same-commit (rule 5) + `upstream/README.md`
  applied-patches inventory.
