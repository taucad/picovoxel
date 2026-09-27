| metric | phase | dlmalloc median (ms) | mimalloc median (ms) | Δ% | speedup (A/B) | 95% CI | verdict |
| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |
| M1 | instantiate | 8.044 | 7.880 | -2.0% | 0.991× | 0.980–1.003 | no effect |
| M2@0.5 | build | 0.893 | 0.918 | +2.7% | 0.984× | 0.966–0.993 | **REGRESSION** |
| M2@0.5 | volume | 0.785 | 0.791 | +0.8% | 0.994× | 0.976–1.003 | no effect |
| M2@0.25 | build | 2.840 | 2.941 | +3.6% | 0.969× | 0.958–0.983 | **REGRESSION** |
| M2@0.25 | volume | 2.859 | 2.923 | +2.3% | 0.982× | 0.971–0.992 | **REGRESSION** |
| M3@0.5 | render | 15.537 | 15.991 | +2.9% | 0.971× | 0.969–0.974 | **REGRESSION** |
| M3@0.5 | mesh | 10.462 | 10.778 | +3.0% | 0.974× | 0.968–0.980 | **REGRESSION** |
| M3@0.25 | render | 101.773 | 104.930 | +3.1% | 0.977× | 0.946–0.992 | **REGRESSION** |
| M3@0.25 | mesh | 37.798 | 39.493 | +4.5% | 0.977× | 0.940–0.989 | **REGRESSION** |
| M4 | chain | 6.143 | 6.339 | +3.2% | 0.974× | 0.967–0.986 | **REGRESSION** |
| M5 | offset | 222.299 | 227.935 | +2.5% | 0.982× | 0.960–0.992 | **REGRESSION** |
| M5 | smoothen | 376.600 | 382.057 | +1.4% | 0.987× | 0.970–0.994 | **REGRESSION** |
| M6 | bulk | 0.403 | 0.298 | -26.1% | 1.052× | 1.001–1.158 | faster |
| M6 | perElement | 13.285 | 13.373 | +0.7% | 1.005× | 0.994–1.019 | no effect |
| M7 | import | 1.509 | 1.525 | +1.1% | 0.993× | 0.976–1.000 | **REGRESSION** |
| M8 | sweep | 3.583 | 3.612 | +0.8% | 0.995× | 0.986–1.001 | no effect |
| M9 | raw10k | 14.916 | 15.270 | +2.4% | 0.998× | 0.952–1.008 | no effect |
| M9 | facade10k | 14.355 | 14.651 | +2.1% | 0.990× | 0.967–1.002 | no effect |
| M10@single | render | 49.074 | 49.450 | +0.8% | 0.999× | 0.982–1.002 | no effect |
| M10@single | mesh | 39.403 | 39.975 | +1.5% | 0.997× | 0.977–1.005 | no effect |
| M10@multi | render | 12.889 | 17.913 | +39.0% | 0.723× | 0.707–0.931 | **REGRESSION** |
| M10@multi | mesh | 32.675 | 14.204 | -56.5% | 2.270× | 2.194–2.407 | faster |
| M11 | construct | 25098.778 | 25234.331 | +0.5% | 0.996× | 0.995–0.997 | **REGRESSION** |
| M11 | mesh | 204.525 | 203.603 | -0.5% | 1.003× | 0.998–1.010 | no effect |
| M11 | stl | 187.092 | 191.227 | +2.2% | 0.996× | 0.978–1.035 | no effect |
| M12@single | construct | 39371.709 | 39665.925 | +0.7% | 0.993× | 0.991–0.993 | **REGRESSION** |
| M12@single | author | 159.043 | 154.429 | -2.9% | 1.016× | 0.996–1.048 | no effect |
| M12@single | kernel:bounding.create | 211.720 | 212.318 | +0.3% | 0.996× | 0.995–1.001 | no effect |
| M12@single | kernel:turning-fins.hot | 1428.450 | 1444.207 | +1.1% | 0.990× | 0.987–0.992 | **REGRESSION** |
| M12@single | kernel:turning-fins.cool | 1426.558 | 1440.860 | +1.0% | 0.990× | 0.989–0.991 | **REGRESSION** |
| M12@single | kernel:corner-fins.union | 3.410 | 3.842 | +12.7% | 0.894× | 0.856–0.912 | **REGRESSION** |
| M12@single | kernel:straight-fins.hot | 435.881 | 437.726 | +0.4% | 0.996× | 0.995–0.997 | **REGRESSION** |
| M12@single | kernel:straight-fins.cool | 436.337 | 438.091 | +0.4% | 0.995× | 0.994–0.997 | **REGRESSION** |
| M12@single | kernel:straight-fins.union | 2.921 | 3.105 | +6.3% | 0.940× | 0.919–0.955 | **REGRESSION** |
| M12@single | kernel:fins.union | 3.000 | 3.041 | +1.3% | 0.988× | 0.975–1.011 | no effect |
| M12@single | kernel:outer-structure.create | 13010.340 | 13133.211 | +0.9% | 0.990× | 0.988–0.992 | **REGRESSION** |
| M12@single | kernel:helical-void.hot | 1223.344 | 1220.937 | -0.2% | 1.001× | 1.000–1.003 | no effect |
| M12@single | kernel:helical-void.cool | 1224.787 | 1224.592 | -0.0% | 1.000× | 0.998–1.002 | no effect |
| M12@single | kernel:cool-inner.offset | 967.092 | 977.859 | +1.1% | 0.987× | 0.983–0.991 | **REGRESSION** |
| M12@single | kernel:hot-fluid-void.subtract | 4.109 | 4.266 | +3.8% | 0.934× | 0.909–1.035 | no effect |
| M12@single | kernel:hot-inner.offset | 963.971 | 975.550 | +1.2% | 0.986× | 0.983–0.989 | **REGRESSION** |
| M12@single | kernel:cool-fluid-void.subtract | 4.282 | 4.143 | -3.2% | 1.018× | 0.947–1.111 | no effect |
| M12@single | kernel:inner-volume.union | 5.492 | 5.666 | +3.2% | 0.964× | 0.957–0.977 | **REGRESSION** |
| M12@single | kernel:splitters.union | 1.957 | 2.029 | +3.7% | 0.968× | 0.955–0.975 | **REGRESSION** |
| M12@single | kernel:outer-volume.offset | 1057.476 | 1068.417 | +1.0% | 0.987× | 0.982–0.992 | **REGRESSION** |
| M12@single | kernel:flange.create | 2513.455 | 2518.565 | +0.2% | 0.998× | 0.997–1.000 | **REGRESSION** |
| M12@single | kernel:finished-flange.fillet | 962.861 | 968.431 | +0.6% | 0.995× | 0.994–0.996 | **REGRESSION** |
| M12@single | kernel:finished-flange.smoothen | 126.385 | 127.043 | +0.5% | 0.994× | 0.991–0.998 | **REGRESSION** |
| M12@single | kernel:outer-volume.union-flange | 3.619 | 3.389 | -6.4% | 1.070× | 1.027–1.118 | faster |
| M12@single | kernel:io-supports.create | 28.064 | 28.105 | +0.1% | 0.998× | 0.995–1.001 | no effect |
| M12@single | kernel:outer-volume.union-supports | 3.890 | 3.898 | +0.2% | 0.988× | 0.982–1.013 | no effect |
| M12@single | kernel:outer-volume.fillet | 6630.845 | 6654.598 | +0.4% | 0.997× | 0.995–0.997 | **REGRESSION** |
| M12@single | kernel:outer-volume.smoothen | 1095.964 | 1102.930 | +0.6% | 0.994× | 0.992–0.996 | **REGRESSION** |
| M12@single | kernel:centre-piece.add | 18.756 | 18.599 | -0.8% | 1.010× | 1.004–1.016 | faster |
| M12@single | kernel:outer-volume.union-structure | 4.906 | 4.831 | -1.5% | 1.012× | 1.001–1.025 | faster |
| M12@single | kernel:outer-volume.subtract-screw-holes | 2.407 | 2.490 | +3.5% | 0.972× | 0.961–0.980 | **REGRESSION** |
| M12@single | kernel:outer-volume.project-z-slice | 4.406 | 4.460 | +1.2% | 0.984× | 0.978–0.996 | **REGRESSION** |
| M12@single | kernel:print-web.create | 7.347 | 7.393 | +0.6% | 0.995× | 0.992–0.998 | **REGRESSION** |
| M12@single | kernel:outer-volume.subtract-print-web | 2.117 | 2.140 | +1.1% | 0.971× | 0.963–0.992 | **REGRESSION** |
| M12@single | kernel:result.subtract-inner-volume | 5.016 | 5.093 | +1.5% | 0.982× | 0.975–0.990 | **REGRESSION** |
| M12@single | kernel:result.union-fins | 5.556 | 5.807 | +4.5% | 0.961× | 0.958–0.969 | **REGRESSION** |
| M12@single | kernel:result.union-splitters | 3.245 | 3.357 | +3.5% | 0.963× | 0.955–0.976 | **REGRESSION** |
| M12@single | kernel:result.intersect-bounding | 4.058 | 4.076 | +0.5% | 0.994× | 0.978–1.001 | no effect |
| M12@single | kernel:io-threads.create | 5336.793 | 5397.484 | +1.1% | 0.989× | 0.985–0.991 | **REGRESSION** |
| M12@single | kernel:result.union-threads | 2.684 | 3.182 | +18.6% | 0.840× | 0.825–0.860 | **REGRESSION** |
| M12@single | kernel:io-cuts.create | 19.313 | 19.144 | -0.9% | 1.010× | 1.007–1.011 | faster |
| M12@single | kernel:result.subtract-io-cuts | 1.674 | 1.946 | +16.2% | 0.864× | 0.842–0.879 | **REGRESSION** |
| M12@single | unattributed | 0.324 | 0.319 | -1.7% | 1.026× | 0.999–1.071 | no effect |
| M12@single | mesh | 103.451 | 105.036 | +1.5% | 0.983× | 0.982–0.988 | **REGRESSION** |
| M12@single | stl | 106.188 | 107.546 | +1.3% | 0.986× | 0.983–0.989 | **REGRESSION** |
| M12@multi | construct | 16685.450 | 7754.408 | -53.5% | 2.164× | 2.141–2.178 | faster |
| M12@multi | author | 161.090 | 156.725 | -2.7% | 1.024× | 1.016–1.062 | faster |
| M12@multi | kernel:bounding.create | 91.202 | 43.537 | -52.3% | 2.024× | 1.878–2.148 | faster |
| M12@multi | kernel:turning-fins.hot | 1143.526 | 241.290 | -78.9% | 4.720× | 4.672–4.769 | faster |
| M12@multi | kernel:turning-fins.cool | 1168.312 | 230.371 | -80.3% | 5.078× | 4.933–5.149 | faster |
| M12@multi | kernel:corner-fins.union | 6.967 | 1.446 | -79.3% | 4.989× | 4.480–5.677 | faster |
| M12@multi | kernel:straight-fins.hot | 352.568 | 68.499 | -80.6% | 5.073× | 4.955–5.241 | faster |
| M12@multi | kernel:straight-fins.cool | 350.090 | 70.905 | -79.7% | 4.967× | 4.863–5.056 | faster |
| M12@multi | kernel:straight-fins.union | 5.522 | 1.304 | -76.4% | 4.195× | 4.071–5.348 | faster |
| M12@multi | kernel:fins.union | 6.232 | 1.268 | -79.7% | 4.876× | 4.397–5.151 | faster |
| M12@multi | kernel:outer-structure.create | 1840.418 | 1574.423 | -14.5% | 1.173× | 1.168–1.180 | faster |
| M12@multi | kernel:helical-void.hot | 301.713 | 205.895 | -31.8% | 1.472× | 1.454–1.524 | faster |
| M12@multi | kernel:helical-void.cool | 300.995 | 199.495 | -33.7% | 1.512× | 1.493–1.526 | faster |
| M12@multi | kernel:cool-inner.offset | 137.838 | 116.815 | -15.3% | 1.179× | 1.164–1.195 | faster |
| M12@multi | kernel:hot-fluid-void.subtract | 10.407 | 1.926 | -81.5% | 5.177× | 4.772–5.673 | faster |
| M12@multi | kernel:hot-inner.offset | 133.754 | 115.870 | -13.4% | 1.147× | 1.140–1.153 | faster |
| M12@multi | kernel:cool-fluid-void.subtract | 10.012 | 1.911 | -80.9% | 5.917× | 5.125–5.990 | faster |
| M12@multi | kernel:inner-volume.union | 10.358 | 1.889 | -81.8% | 5.547× | 5.367–6.095 | faster |
| M12@multi | kernel:splitters.union | 1.448 | 1.131 | -21.9% | 1.269× | 1.215–1.517 | faster |
| M12@multi | kernel:outer-volume.offset | 151.190 | 127.477 | -15.7% | 1.181× | 1.169–1.196 | faster |
| M12@multi | kernel:flange.create | 2489.224 | 2042.261 | -18.0% | 1.226× | 1.210–1.245 | faster |
| M12@multi | kernel:finished-flange.fillet | 195.403 | 149.171 | -23.7% | 1.331× | 1.292–1.338 | faster |
| M12@multi | kernel:finished-flange.smoothen | 30.986 | 22.287 | -28.1% | 1.376× | 1.321–1.454 | faster |
| M12@multi | kernel:outer-volume.union-flange | 6.256 | 1.546 | -75.3% | 3.827× | 3.513–4.210 | faster |
| M12@multi | kernel:io-supports.create | 9.412 | 6.550 | -30.4% | 1.455× | 1.348–1.527 | faster |
| M12@multi | kernel:outer-volume.union-supports | 8.413 | 1.679 | -80.0% | 5.070× | 4.751–5.655 | faster |
| M12@multi | kernel:outer-volume.fillet | 976.677 | 819.581 | -16.1% | 1.191× | 1.188–1.231 | faster |
| M12@multi | kernel:outer-volume.smoothen | 168.986 | 137.601 | -18.6% | 1.239× | 1.206–1.262 | faster |
| M12@multi | kernel:centre-piece.add | 29.753 | 10.529 | -64.6% | 3.176× | 2.786–3.447 | faster |
| M12@multi | kernel:outer-volume.union-structure | 8.751 | 1.894 | -78.4% | 4.481× | 3.896–4.780 | faster |
| M12@multi | kernel:outer-volume.subtract-screw-holes | 5.409 | 1.431 | -73.5% | 3.854× | 3.430–4.094 | faster |
| M12@multi | kernel:outer-volume.project-z-slice | 7.885 | 4.933 | -37.4% | 1.594× | 1.545–1.683 | faster |
| M12@multi | kernel:print-web.create | 4.277 | 2.582 | -39.6% | 1.620× | 1.529–1.737 | faster |
| M12@multi | kernel:outer-volume.subtract-print-web | 5.925 | 1.427 | -75.9% | 4.116× | 3.911–4.380 | faster |
| M12@multi | kernel:result.subtract-inner-volume | 12.460 | 2.192 | -82.4% | 5.438× | 4.794–6.065 | faster |
| M12@multi | kernel:result.union-fins | 12.737 | 2.223 | -82.5% | 5.602× | 4.025–6.561 | faster |
| M12@multi | kernel:result.union-splitters | 7.715 | 1.824 | -76.4% | 4.179× | 3.797–4.924 | faster |
| M12@multi | kernel:result.intersect-bounding | 14.093 | 2.855 | -79.7% | 5.502× | 4.021–6.521 | faster |
| M12@multi | kernel:io-threads.create | 6441.633 | 1369.095 | -78.7% | 4.729× | 4.696–4.982 | faster |
| M12@multi | kernel:result.union-threads | 6.104 | 1.606 | -73.7% | 3.813× | 3.472–4.471 | faster |
| M12@multi | kernel:io-cuts.create | 27.463 | 18.180 | -33.8% | 1.513× | 1.459–1.681 | faster |
| M12@multi | kernel:result.subtract-io-cuts | 5.891 | 1.235 | -79.0% | 4.497× | 4.168–5.763 | faster |
| M12@multi | unattributed | 0.430 | 0.406 | -5.5% | 1.068× | 0.974–1.316 | no effect |
| M12@multi | mesh | 33.034 | 16.604 | -49.7% | 1.992× | 1.927–2.041 | faster |
| M12@multi | stl | 110.082 | 111.951 | +1.7% | 0.981× | 0.975–0.987 | **REGRESSION** |
| M13 | callback | 34.842 | 34.990 | +0.4% | 0.994× | 0.988–0.998 | **REGRESSION** |
| M13 | tape | 12.921 | 12.993 | +0.6% | 0.997× | 0.994–1.000 | **REGRESSION** |
| M14 | gen0 | 19.724 | 19.777 | +0.3% | 1.001× | 0.996–1.006 | no effect |
| M14 | gen1 | 76.710 | 77.669 | +1.2% | 0.986× | 0.978–0.993 | **REGRESSION** |
| M14 | gen2 | 3179.493 | 3179.424 | -0.0% | 0.993× | 0.989–1.002 | no effect |

120 phases compared: 49 faster, 47 regressions, 24 no measurable effect.
REGRESSION M2@0.5/build: 0.984× (2.7%)
REGRESSION M2@0.25/build: 0.969× (3.6%)
REGRESSION M2@0.25/volume: 0.982× (2.3%)
REGRESSION M3@0.5/render: 0.971× (2.9%)
REGRESSION M3@0.5/mesh: 0.974× (3.0%)
REGRESSION M3@0.25/render: 0.977× (3.1%)
REGRESSION M3@0.25/mesh: 0.977× (4.5%)
REGRESSION M4/chain: 0.974× (3.2%)
REGRESSION M5/offset: 0.982× (2.5%)
REGRESSION M5/smoothen: 0.987× (1.4%)
REGRESSION M7/import: 0.993× (1.1%)
REGRESSION M10@multi/render: 0.723× (39.0%)
REGRESSION M11/construct: 0.996× (0.5%)
REGRESSION M12@single/construct: 0.993× (0.7%)
REGRESSION M12@single/kernel:turning-fins.hot: 0.990× (1.1%)
REGRESSION M12@single/kernel:turning-fins.cool: 0.990× (1.0%)
REGRESSION M12@single/kernel:corner-fins.union: 0.894× (12.7%)
REGRESSION M12@single/kernel:straight-fins.hot: 0.996× (0.4%)
REGRESSION M12@single/kernel:straight-fins.cool: 0.995× (0.4%)
REGRESSION M12@single/kernel:straight-fins.union: 0.940× (6.3%)
REGRESSION M12@single/kernel:outer-structure.create: 0.990× (0.9%)
REGRESSION M12@single/kernel:cool-inner.offset: 0.987× (1.1%)
REGRESSION M12@single/kernel:hot-inner.offset: 0.986× (1.2%)
REGRESSION M12@single/kernel:inner-volume.union: 0.964× (3.2%)
REGRESSION M12@single/kernel:splitters.union: 0.968× (3.7%)
REGRESSION M12@single/kernel:outer-volume.offset: 0.987× (1.0%)
REGRESSION M12@single/kernel:flange.create: 0.998× (0.2%)
REGRESSION M12@single/kernel:finished-flange.fillet: 0.995× (0.6%)
REGRESSION M12@single/kernel:finished-flange.smoothen: 0.994× (0.5%)
REGRESSION M12@single/kernel:outer-volume.fillet: 0.997× (0.4%)
REGRESSION M12@single/kernel:outer-volume.smoothen: 0.994× (0.6%)
REGRESSION M12@single/kernel:outer-volume.subtract-screw-holes: 0.972× (3.5%)
REGRESSION M12@single/kernel:outer-volume.project-z-slice: 0.984× (1.2%)
REGRESSION M12@single/kernel:print-web.create: 0.995× (0.6%)
REGRESSION M12@single/kernel:outer-volume.subtract-print-web: 0.971× (1.1%)
REGRESSION M12@single/kernel:result.subtract-inner-volume: 0.982× (1.5%)
REGRESSION M12@single/kernel:result.union-fins: 0.961× (4.5%)
REGRESSION M12@single/kernel:result.union-splitters: 0.963× (3.5%)
REGRESSION M12@single/kernel:io-threads.create: 0.989× (1.1%)
REGRESSION M12@single/kernel:result.union-threads: 0.840× (18.6%)
REGRESSION M12@single/kernel:result.subtract-io-cuts: 0.864× (16.2%)
REGRESSION M12@single/mesh: 0.983× (1.5%)
REGRESSION M12@single/stl: 0.986× (1.3%)
REGRESSION M12@multi/stl: 0.981× (1.7%)
REGRESSION M13/callback: 0.994× (0.4%)
REGRESSION M13/tape: 0.997× (0.6%)
REGRESSION M14/gen1: 0.986× (1.2%)
