| metric | phase | old (ms) | new (ms) | Δ% | speedup | 95% CI (conservative) | verdict |
| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |
| M12@multi | kernel:io-supports.create | 175.651 | 9.412 | -94.6% | 18.662× | 17.305–19.827 | faster |
| M12@multi | kernel:helical-void.cool | 5179.769 | 300.995 | -94.2% | 17.209× | 16.959–17.351 | faster |
| M12@multi | kernel:helical-void.hot | 5190.923 | 301.713 | -94.2% | 17.205× | 16.890–17.440 | faster |
| M12@single | kernel:io-supports.create | 172.538 | 28.064 | -83.7% | 6.148× | 6.124–6.249 | faster |
| M12@single | kernel:helical-void.cool | 5136.355 | 1224.787 | -76.2% | 4.194× | 4.171–4.231 | faster |
| M12@single | kernel:helical-void.hot | 5121.189 | 1223.344 | -76.1% | 4.186× | 4.174–4.235 | faster |
| M12@multi | kernel:straight-fins.cool | 1241.981 | 350.090 | -71.8% | 3.548× | 3.433–3.593 | faster |
| M12@multi | kernel:straight-fins.hot | 1238.182 | 352.568 | -71.5% | 3.512× | 3.461–3.579 | faster |
| M12@multi | kernel:turning-fins.hot | 3803.266 | 1143.526 | -69.9% | 3.326× | 3.271–3.405 | faster |
| M12@multi | kernel:turning-fins.cool | 3800.351 | 1168.312 | -69.3% | 3.253× | 3.216–3.356 | faster |
| M12@multi | author | 458.735 | 161.090 | -64.9% | 2.848× | 2.762–2.902 | faster |
| M12@single | kernel:straight-fins.hot | 1225.420 | 435.881 | -64.4% | 2.811× | 2.787–2.839 | faster |
| M12@single | kernel:straight-fins.cool | 1226.222 | 436.337 | -64.4% | 2.810× | 2.788–2.834 | faster |
| M12@single | kernel:turning-fins.cool | 3767.883 | 1426.558 | -62.1% | 2.641× | 2.620–2.668 | faster |
| M12@single | kernel:turning-fins.hot | 3761.689 | 1428.450 | -62.0% | 2.633× | 2.619–2.672 | faster |
| M12@single | author | 406.692 | 159.043 | -60.9% | 2.557× | 2.506–2.626 | faster |
| M12@multi | construct | 34664.796 | 16685.450 | -51.9% | 2.078× | 2.038–2.097 | faster |
| M12@multi | kernel:outer-volume.subtract-print-web | 11.224 | 5.925 | -47.2% | 1.894× | 1.741–2.081 | faster |
| M14 | gen2 | 5774.498 | 3179.493 | -44.9% | 1.816× | 1.803–1.838 | faster |
| M14 | gen1 | 133.064 | 76.710 | -42.4% | 1.735× | 1.719–1.758 | faster |
| M12@multi | mesh | 56.446 | 33.034 | -41.5% | 1.709× | 1.621–1.775 | faster |
| M12@multi | kernel:outer-volume.union-supports | 14.266 | 8.413 | -41.0% | 1.696× | 1.493–1.883 | faster |
| M12@single | kernel:outer-volume.subtract-print-web | 3.511 | 2.117 | -39.7% | 1.658× | 1.604–1.787 | faster |
| M12@multi | kernel:straight-fins.union | 9.070 | 5.522 | -39.1% | 1.643× | 1.242–1.796 | faster |
| M12@multi | kernel:corner-fins.union | 10.986 | 6.967 | -36.6% | 1.577× | 1.261–1.832 | faster |
| M12@single | construct | 55259.545 | 39371.709 | -28.8% | 1.404× | 1.397–1.415 | faster |
| M10@multi | mesh | 44.080 | 32.675 | -25.9% | 1.349× | 1.221–1.466 | faster |
| M12@multi | kernel:splitters.union | 1.929 | 1.448 | -24.9% | 1.332× | 0.968–1.899 | no effect |
| M12@multi | kernel:io-cuts.create | 36.454 | 27.463 | -24.7% | 1.327× | 1.102–1.417 | faster |
| M12@single | kernel:outer-volume.union-supports | 5.071 | 3.890 | -23.3% | 1.304× | 1.202–1.384 | faster |
| M12@multi | kernel:result.union-threads | 7.655 | 6.104 | -20.3% | 1.254× | 1.051–1.439 | faster |
| M12@multi | kernel:hot-fluid-void.subtract | 12.988 | 10.407 | -19.9% | 1.248× | 1.083–1.403 | faster |
| M12@single | kernel:corner-fins.union | 4.251 | 3.410 | -19.8% | 1.247× | 1.180–1.312 | faster |
| M12@single | kernel:io-cuts.create | 24.018 | 19.313 | -19.6% | 1.244× | 1.229–1.260 | faster |
| M3@0.25 | mesh | 46.807 | 37.798 | -19.2% | 1.238× | 1.177–1.258 | faster |
| M12@single | mesh | 127.976 | 103.451 | -19.2% | 1.237× | 1.225–1.254 | faster |
| M12@multi | kernel:fins.union | 7.691 | 6.232 | -19.0% | 1.234× | 1.070–1.395 | faster |
| M10@single | mesh | 48.331 | 39.403 | -18.5% | 1.227× | 1.150–1.307 | faster |
| M11 | mesh | 250.866 | 204.525 | -18.5% | 1.227× | 1.163–1.288 | faster |
| M12@multi | kernel:cool-fluid-void.subtract | 12.265 | 10.012 | -18.4% | 1.225× | 1.005–1.391 | faster |
| M12@single | kernel:straight-fins.union | 3.577 | 2.921 | -18.3% | 1.225× | 1.166–1.283 | faster |
| M12@multi | kernel:outer-structure.create | 2236.334 | 1840.418 | -17.7% | 1.215× | 1.182–1.231 | faster |
| M12@multi | kernel:finished-flange.fillet | 236.272 | 195.403 | -17.3% | 1.209× | 1.155–1.253 | faster |
| M12@multi | kernel:inner-volume.union | 12.524 | 10.358 | -17.3% | 1.209× | 0.978–1.363 | no effect |
| M12@multi | kernel:finished-flange.smoothen | 37.284 | 30.986 | -16.9% | 1.203× | 1.053–1.346 | faster |
| M3@0.5 | mesh | 12.531 | 10.462 | -16.5% | 1.198× | 1.135–1.264 | faster |
| M12@multi | kernel:centre-piece.add | 35.267 | 29.753 | -15.6% | 1.185× | 0.947–1.468 | no effect |
| M12@multi | kernel:result.union-splitters | 9.099 | 7.715 | -15.2% | 1.179× | 1.023–1.309 | faster |
| M12@multi | kernel:outer-volume.union-flange | 7.254 | 6.256 | -13.8% | 1.160× | 0.949–1.448 | no effect |
| M6 | perElement | 15.373 | 13.285 | -13.6% | 1.157× | 1.138–1.254 | faster |
| M12@multi | kernel:outer-volume.union-structure | 9.944 | 8.751 | -12.0% | 1.136× | 0.959–1.270 | no effect |
| M12@single | kernel:result.union-fins | 6.261 | 5.556 | -11.3% | 1.127× | 1.062–1.153 | faster |
| M12@single | kernel:result.union-splitters | 3.631 | 3.245 | -10.6% | 1.119× | 1.039–1.154 | faster |
| M8 | sweep | 3.976 | 3.583 | -9.9% | 1.110× | 0.990–1.187 | no effect |
| M12@single | kernel:result.intersect-bounding | 4.470 | 4.058 | -9.2% | 1.102× | 1.068–1.154 | faster |
| M12@multi | kernel:outer-volume.fillet | 1069.682 | 976.677 | -8.7% | 1.095× | 1.050–1.120 | faster |
| M9 | facade10k | 15.673 | 14.355 | -8.4% | 1.092× | 1.052–1.136 | faster |
| M12@multi | kernel:result.subtract-io-cuts | 6.419 | 5.891 | -8.2% | 1.090× | 0.810–1.531 | no effect |
| M12@single | kernel:splitters.union | 2.124 | 1.957 | -7.9% | 1.085× | 1.058–1.111 | faster |
| M12@single | kernel:outer-volume.subtract-screw-holes | 2.598 | 2.407 | -7.4% | 1.079× | 1.039–1.141 | faster |
| M12@multi | kernel:bounding.create | 98.070 | 91.202 | -7.0% | 1.075× | 1.037–1.133 | faster |
| M12@multi | kernel:outer-volume.smoothen | 181.545 | 168.986 | -6.9% | 1.074× | 1.014–1.134 | faster |
| M12@multi | kernel:result.subtract-inner-volume | 13.329 | 12.460 | -6.5% | 1.070× | 0.915–1.217 | no effect |
| M12@single | kernel:result.subtract-io-cuts | 1.790 | 1.674 | -6.5% | 1.069× | 1.042–1.110 | faster |
| M12@single | kernel:centre-piece.add | 19.991 | 18.756 | -6.2% | 1.066× | 1.031–1.078 | faster |
| M4 | chain | 6.537 | 6.143 | -6.0% | 1.064× | 1.016–1.117 | faster |
| M12@multi | unattributed | 0.457 | 0.430 | -5.9% | 1.063× | 0.769–1.141 | no effect |
| M7 | import | 1.603 | 1.509 | -5.9% | 1.062× | 1.023–1.083 | faster |
| M12@single | kernel:outer-volume.union-structure | 5.208 | 4.906 | -5.8% | 1.062× | 1.007–1.115 | faster |
| M2@0.25 | build | 3.011 | 2.840 | -5.7% | 1.060× | 1.013–1.078 | faster |
| M12@single | kernel:inner-volume.union | 5.822 | 5.492 | -5.7% | 1.060× | 1.037–1.092 | faster |
| M3@0.25 | render | 107.614 | 101.773 | -5.4% | 1.057× | 1.032–1.064 | faster |
| M12@multi | kernel:outer-volume.offset | 159.606 | 151.190 | -5.3% | 1.056× | 1.034–1.083 | faster |
| M12@multi | kernel:hot-inner.offset | 141.027 | 133.754 | -5.2% | 1.054× | 1.023–1.083 | faster |
| M12@multi | kernel:cool-inner.offset | 145.311 | 137.838 | -5.1% | 1.054× | 1.010–1.082 | faster |
| M12@single | kernel:outer-structure.create | 13708.265 | 13010.340 | -5.1% | 1.054× | 1.048–1.060 | faster |
| M12@single | kernel:bounding.create | 222.685 | 211.720 | -4.9% | 1.052× | 1.040–1.064 | faster |
| M9 | raw10k | 15.652 | 14.916 | -4.7% | 1.049× | 0.998–1.066 | no effect |
| M12@multi | kernel:result.intersect-bounding | 14.758 | 14.093 | -4.5% | 1.047× | 0.918–1.225 | no effect |
| M3@0.5 | render | 16.259 | 15.537 | -4.4% | 1.046× | 1.021–1.071 | faster |
| M2@0.5 | build | 0.934 | 0.893 | -4.4% | 1.046× | 0.992–1.098 | no effect |
| M12@multi | kernel:result.union-fins | 13.315 | 12.737 | -4.3% | 1.045× | 0.991–1.152 | no effect |
| M12@single | kernel:outer-volume.project-z-slice | 4.605 | 4.406 | -4.3% | 1.045× | 1.006–1.091 | faster |
| M11 | construct | 26195.151 | 25098.778 | -4.2% | 1.044× | 1.002–1.079 | faster |
| M12@single | kernel:flange.create | 2620.898 | 2513.455 | -4.1% | 1.043× | 1.034–1.049 | faster |
| M12@multi | kernel:outer-volume.subtract-screw-holes | 5.630 | 5.409 | -3.9% | 1.041× | 0.886–1.185 | no effect |
| M12@single | kernel:outer-volume.fillet | 6901.593 | 6630.845 | -3.9% | 1.041× | 1.033–1.050 | faster |
| M12@single | stl | 110.496 | 106.188 | -3.9% | 1.041× | 1.023–1.050 | faster |
| M12@single | kernel:finished-flange.fillet | 1000.636 | 962.861 | -3.8% | 1.039× | 1.034–1.053 | faster |
| M5 | smoothen | 391.302 | 376.600 | -3.8% | 1.039× | 0.999–1.083 | no effect |
| M10@single | render | 50.959 | 49.074 | -3.7% | 1.038× | 1.004–1.094 | faster |
| M12@single | kernel:finished-flange.smoothen | 131.232 | 126.385 | -3.7% | 1.038× | 1.027–1.051 | faster |
| M12@single | kernel:outer-volume.smoothen | 1136.588 | 1095.964 | -3.6% | 1.037× | 1.031–1.053 | faster |
| M12@single | kernel:result.union-threads | 2.780 | 2.684 | -3.5% | 1.036× | 1.003–1.078 | faster |
| M2@0.25 | volume | 2.961 | 2.859 | -3.4% | 1.036× | 1.001–1.059 | faster |
| M12@single | kernel:hot-inner.offset | 995.456 | 963.971 | -3.2% | 1.033× | 1.028–1.044 | faster |
| M12@single | kernel:cool-inner.offset | 997.522 | 967.092 | -3.1% | 1.031× | 1.026–1.043 | faster |
| M12@single | kernel:hot-fluid-void.subtract | 4.236 | 4.109 | -3.0% | 1.031× | 0.921–1.104 | no effect |
| M12@single | kernel:io-threads.create | 5500.297 | 5336.793 | -3.0% | 1.031× | 1.025–1.049 | faster |
| M12@single | kernel:result.subtract-inner-volume | 5.159 | 5.016 | -2.8% | 1.029× | 1.006–1.093 | faster |
| M12@single | kernel:outer-volume.offset | 1087.184 | 1057.476 | -2.7% | 1.028× | 1.023–1.042 | faster |
| M5 | offset | 228.454 | 222.299 | -2.7% | 1.028× | 0.992–1.078 | no effect |
| M1 | instantiate | 8.253 | 8.044 | -2.5% | 1.026× | 0.914–1.124 | no effect |
| M12@multi | stl | 112.831 | 110.082 | -2.4% | 1.025× | 1.012–1.042 | faster |
| M12@multi | kernel:flange.create | 2549.374 | 2489.224 | -2.4% | 1.024× | 1.005–1.035 | faster |
| M2@0.5 | volume | 0.798 | 0.785 | -1.6% | 1.017× | 0.995–1.090 | no effect |
| M12@single | kernel:outer-volume.union-flange | 3.676 | 3.619 | -1.6% | 1.016× | 0.904–1.063 | no effect |
| M12@multi | kernel:outer-volume.project-z-slice | 7.983 | 7.885 | -1.2% | 1.012× | 0.885–1.128 | no effect |
| M13 | tape | 13.070 | 12.921 | -1.1% | 1.012× | 1.008–1.018 | faster |
| M12@single | kernel:fins.union | 3.034 | 3.000 | -1.1% | 1.011× | 0.977–1.060 | no effect |
| M13 | callback | 35.091 | 34.842 | -0.7% | 1.007× | 0.990–1.026 | no effect |
| M11 | stl | 188.326 | 187.092 | -0.7% | 1.007× | 0.984–1.081 | no effect |
| M10@multi | render | 12.813 | 12.889 | +0.6% | 0.994× | 0.910–1.045 | no effect |
| M12@multi | kernel:io-threads.create | 6333.669 | 6441.633 | +1.7% | 0.983× | 0.976–0.991 | **REGRESSION** |
| M12@single | kernel:cool-fluid-void.subtract | 4.178 | 4.282 | +2.5% | 0.976× | 0.860–1.097 | no effect |
| M12@single | unattributed | 0.278 | 0.324 | +16.5% | 0.858× | 0.679–1.076 | no effect |
| M6 | bulk | 0.319 | 0.403 | +26.3% | 0.792× | 0.594–1.434 | no effect |
| M12@multi | kernel:print-web.create | 3.032 | 4.277 | +41.1% | 0.709× | 0.657–0.754 | **REGRESSION** |
| M12@single | kernel:print-web.create | 2.854 | 7.347 | +157.4% | 0.388× | 0.383–0.396 | **REGRESSION** |
| M14 | gen0 | 4.598 | 19.724 | +329.0% | 0.233× | 0.231–0.234 | **REGRESSION** |

120 phases compared: 88 faster, 4 regressions, 28 no measurable effect.
REGRESSION M12@multi/kernel:io-threads.create: 0.983× (CI 0.976–0.991)
REGRESSION M12@multi/kernel:print-web.create: 0.709× (CI 0.657–0.754)
REGRESSION M12@single/kernel:print-web.create: 0.388× (CI 0.383–0.396)
REGRESSION M14/gen0: 0.233× (CI 0.231–0.234)
