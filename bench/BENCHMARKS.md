# picogk-js benchmarks

> Measured on Apple M2 Pro (12 cores, 32 GiB), darwin 25.0.0, node v24.6.0, wasm 31f1f1de991c (5,763,731 B), commit 7212f2a, 2026-07-17.
> **Absolute numbers are device-specific; treat ratios and phase splits as the portable signal.**
> Reproduce with `npm run bench` (the harness refuses loaded machines). Source: `bench/results/2026-07-17-7212f2a.json`.
>
> Native-comparison figures (the ~1.95× PicoGK wasm tax, R20's 3–9% SDF callback overhead, R11's ~150×
> bulk-readback win) are imported by reference from the measured records in the research docs
> (picogk-wasm-kernel-blueprint) — native builds live outside this repo's toolchain.

| Metric | Description | Phase | Median | Min | Max |
| --- | --- | --- | ---: | ---: | ---: |
| M1 | createPicoGK() cold instantiate (5.8 MB module) | instantiate | 9.812 ms | 9.559 | 13.843 |
| M2@0.5 | sphere r=10 @ 0.5mm | build | 1.117 ms | 1.007 | 1.441 |
|  |  | volume | 0.919 ms | 0.887 | 0.945 |
| M2@0.25 | sphere r=10 @ 0.25mm | build | 3.398 ms | 3.19 | 3.493 |
|  |  | volume | 3.332 ms | 3.283 | 3.521 |
| M3@0.5 | gyroid implicit @ 0.5mm (JS SDF) | render | 19.553 ms | 19.065 | 24.235 |
|  |  | mesh | 14.053 ms | 13.862 | 14.835 |
| M3@0.25 | gyroid implicit @ 0.25mm (JS SDF) | render | 138.433 ms | 129.693 | 140.081 |
|  |  | mesh | 59.193 ms | 53.59 | 59.741 |
| M4 | union + subtract + intersect chain (differential shapes) | chain | 7.096 ms | 7.042 | 7.23 |
| M5 | offset +2 and smoothen(1) on a CSG body | offset | 291.829 ms | 287.308 | 305.538 |
|  |  | smoothen | 506.893 ms | 502.069 | 517.483 |
| M6 | mesh readback bulk vs per-element (0.25mm gyroid) | bulk | 0.674 ms | 0.346 | 0.806 |
|  |  | perElement | 24.697 ms | 21.475 | 25.327 |
| M7 | 100k-triangle synthetic bulk import | import | 1.766 ms | 1.652 | 2.107 |
| M8 | full interpolated slice sweep + vectorize (sphere r=8) | sweep | 4.541 ms | 4.112 | 5.446 |
| M9 | facade vs raw: 10k isEmpty calls | raw10k | 17.326 ms | 16.952 | 25.513 |
|  |  | facade10k | 17.016 ms | 16.446 | 19.288 |

Identity oracles (hex-float volumes, FNV-1a mesh hashes) are bit-stable across the 5 repeats of every metric — enforced by the harness, not reviewed by eye.

**Repeatability**: consecutive quiet-machine runs agree within ±10% on every phase ≥ 1 ms;
sub-millisecond phases (e.g. M6 bulk readback) are timer-noise-dominated and may vary up to ±20% — their RATIO to the paired phase is the signal.

**Sanity anchors** (vs the research-doc records): M6's bulk-vs-per-element ratio grows with mesh size —
~50× here on a ~40k-vertex gyroid, consistent with R11's ~150× record at 174k vertices; M3's render phase
(~130 ns/sample at 0.25 mm including voxel work) is consistent with R20's 3–9% JS-SDF callback overhead;
M9 shows the facade adds no measurable cost over raw cwraps at 10k calls (within run-to-run noise).
