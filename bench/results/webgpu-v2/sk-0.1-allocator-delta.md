| metric | phase | dlmalloc median (ms) | mimalloc median (ms) | Δ% | speedup (A/B) | 95% CI | verdict |
| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |
| M1 | instantiate | 8.253 | 8.099 | -1.9% | 1.000× | 0.972–1.096 | no effect |
| M2@0.5 | build | 0.934 | 0.937 | +0.2% | 1.008× | 0.977–1.025 | no effect |
| M2@0.5 | volume | 0.798 | 0.802 | +0.6% | 1.006× | 0.992–1.025 | no effect |
| M2@0.25 | build | 3.011 | 2.946 | -2.2% | 1.009× | 0.972–1.037 | no effect |
| M2@0.25 | volume | 2.961 | 2.931 | -1.0% | 1.013× | 0.975–1.030 | no effect |
| M3@0.5 | render | 16.259 | 15.906 | -2.2% | 1.027× | 1.001–1.044 | faster |
| M3@0.5 | mesh | 12.531 | 12.124 | -3.2% | 1.027× | 0.990–1.075 | no effect |
| M3@0.25 | render | 107.614 | 104.239 | -3.1% | 1.034× | 1.006–1.037 | faster |
| M3@0.25 | mesh | 46.807 | 44.252 | -5.5% | 1.054× | 1.002–1.073 | faster |
| M4 | chain | 6.537 | 6.357 | -2.8% | 1.021× | 0.981–1.073 | no effect |
| M5 | offset | 228.454 | 226.311 | -0.9% | 1.013× | 0.978–1.054 | no effect |
| M5 | smoothen | 391.302 | 384.971 | -1.6% | 1.015× | 0.982–1.056 | no effect |
| M6 | bulk | 0.319 | 0.366 | +14.7% | 0.963× | 0.896–1.099 | no effect |
| M6 | perElement | 15.373 | 14.448 | -6.0% | 1.090× | 1.081–1.097 | faster |
| M7 | import | 1.603 | 1.551 | -3.2% | 1.039× | 0.985–1.066 | no effect |
| M8 | sweep | 3.976 | 3.689 | -7.2% | 1.056× | 1.001–1.085 | faster |
| M9 | raw10k | 15.652 | 15.309 | -2.2% | 1.016× | 0.986–1.037 | no effect |
| M9 | facade10k | 15.673 | 15.442 | -1.5% | 1.026× | 1.007–1.047 | faster |
| M10@single | render | 50.959 | 50.314 | -1.3% | 1.014× | 0.986–1.056 | no effect |
| M10@single | mesh | 48.331 | 47.057 | -2.6% | 1.029× | 0.975–1.089 | no effect |
| M10@multi | render | 12.813 | 10.800 | -15.7% | 1.129× | 1.094–1.246 | faster |
| M10@multi | mesh | 44.080 | 21.142 | -52.0% | 1.998× | 1.939–2.117 | faster |
| M11 | construct | 26195.151 | 25500.430 | -2.7% | 1.028× | 0.993–1.063 | no effect |
| M11 | mesh | 250.866 | 239.625 | -4.5% | 1.042× | 0.995–1.087 | no effect |
| M11 | stl | 188.326 | 188.939 | +0.3% | 1.027× | 0.993–1.037 | no effect |
| M12@single | construct | 55259.545 | 55742.461 | +0.9% | 0.991× | 0.974–1.024 | no effect |
| M12@single | author | 406.692 | 408.106 | +0.3% | 0.991× | 0.984–1.038 | no effect |
| M12@single | kernel:bounding.create | 222.685 | 225.081 | +1.1% | 0.989× | 0.968–1.036 | no effect |
| M12@single | kernel:turning-fins.hot | 3761.689 | 3806.131 | +1.2% | 0.987× | 0.964–1.042 | no effect |
| M12@single | kernel:turning-fins.cool | 3767.883 | 3802.802 | +0.9% | 0.990× | 0.973–1.041 | no effect |
| M12@single | kernel:corner-fins.union | 4.251 | 4.696 | +10.5% | 0.926× | 0.872–0.952 | **REGRESSION** |
| M12@single | kernel:straight-fins.hot | 1225.420 | 1232.520 | +0.6% | 0.995× | 0.983–1.043 | no effect |
| M12@single | kernel:straight-fins.cool | 1226.222 | 1232.597 | +0.5% | 0.999× | 0.978–1.041 | no effect |
| M12@single | kernel:straight-fins.union | 3.577 | 3.640 | +1.8% | 0.983× | 0.941–1.025 | no effect |
| M12@single | kernel:fins.union | 3.034 | 3.156 | +4.0% | 0.974× | 0.909–1.029 | no effect |
| M12@single | kernel:outer-structure.create | 13708.265 | 13743.617 | +0.3% | 0.997× | 0.973–1.024 | no effect |
| M12@single | kernel:helical-void.hot | 5121.189 | 5164.014 | +0.8% | 0.991× | 0.973–1.020 | no effect |
| M12@single | kernel:helical-void.cool | 5136.355 | 5165.896 | +0.6% | 0.990× | 0.980–1.026 | no effect |
| M12@single | kernel:cool-inner.offset | 997.522 | 1010.078 | +1.3% | 0.985× | 0.972–1.012 | no effect |
| M12@single | kernel:hot-fluid-void.subtract | 4.236 | 4.623 | +9.1% | 0.943× | 0.876–0.991 | **REGRESSION** |
| M12@single | kernel:hot-inner.offset | 995.456 | 1005.038 | +1.0% | 0.987× | 0.977–1.013 | no effect |
| M12@single | kernel:cool-fluid-void.subtract | 4.178 | 4.454 | +6.6% | 0.933× | 0.909–0.985 | **REGRESSION** |
| M12@single | kernel:inner-volume.union | 5.822 | 6.011 | +3.3% | 0.974× | 0.944–1.012 | no effect |
| M12@single | kernel:splitters.union | 2.124 | 2.155 | +1.5% | 0.976× | 0.934–1.006 | no effect |
| M12@single | kernel:outer-volume.offset | 1087.184 | 1102.901 | +1.4% | 0.983× | 0.971–1.010 | no effect |
| M12@single | kernel:flange.create | 2620.898 | 2625.899 | +0.2% | 0.991× | 0.985–1.028 | no effect |
| M12@single | kernel:finished-flange.fillet | 1000.636 | 1004.033 | +0.3% | 0.993× | 0.980–1.044 | no effect |
| M12@single | kernel:finished-flange.smoothen | 131.232 | 131.853 | +0.5% | 0.991× | 0.977–1.037 | no effect |
| M12@single | kernel:outer-volume.union-flange | 3.676 | 3.480 | -5.3% | 1.042× | 1.000–1.119 | no effect |
| M12@single | kernel:io-supports.create | 172.538 | 173.005 | +0.3% | 0.997× | 0.978–1.036 | no effect |
| M12@single | kernel:outer-volume.union-supports | 5.071 | 5.092 | +0.4% | 0.985× | 0.917–1.073 | no effect |
| M12@single | kernel:outer-volume.fillet | 6901.593 | 6918.950 | +0.3% | 0.996× | 0.981–1.024 | no effect |
| M12@single | kernel:outer-volume.smoothen | 1136.588 | 1147.620 | +1.0% | 0.989× | 0.962–1.023 | no effect |
| M12@single | kernel:centre-piece.add | 19.991 | 19.397 | -3.0% | 1.028× | 0.982–1.048 | no effect |
| M12@single | kernel:outer-volume.union-structure | 5.208 | 5.115 | -1.8% | 1.008× | 0.954–1.079 | no effect |
| M12@single | kernel:outer-volume.subtract-screw-holes | 2.598 | 2.694 | +3.7% | 0.941× | 0.920–1.044 | no effect |
| M12@single | kernel:outer-volume.project-z-slice | 4.605 | 4.742 | +3.0% | 0.978× | 0.921–1.051 | no effect |
| M12@single | kernel:print-web.create | 2.854 | 2.832 | -0.8% | 1.005× | 0.988–1.023 | no effect |
| M12@single | kernel:outer-volume.subtract-print-web | 3.511 | 3.475 | -1.0% | 1.015× | 0.983–1.070 | no effect |
| M12@single | kernel:result.subtract-inner-volume | 5.159 | 5.265 | +2.1% | 0.941× | 0.922–1.030 | no effect |
| M12@single | kernel:result.union-fins | 6.261 | 6.329 | +1.1% | 0.964× | 0.930–1.051 | no effect |
| M12@single | kernel:result.union-splitters | 3.631 | 3.562 | -1.9% | 0.965× | 0.939–1.057 | no effect |
| M12@single | kernel:result.intersect-bounding | 4.470 | 4.300 | -3.8% | 1.027× | 0.965–1.082 | no effect |
| M12@single | kernel:io-threads.create | 5500.297 | 5633.186 | +2.4% | 0.976× | 0.949–1.013 | no effect |
| M12@single | kernel:result.union-threads | 2.780 | 3.075 | +10.6% | 0.920× | 0.859–0.967 | **REGRESSION** |
| M12@single | kernel:io-cuts.create | 24.018 | 23.754 | -1.1% | 1.015× | 0.991–1.050 | no effect |
| M12@single | kernel:result.subtract-io-cuts | 1.790 | 2.180 | +21.8% | 0.827× | 0.787–0.848 | **REGRESSION** |
| M12@single | unattributed | 0.278 | 0.273 | -1.6% | 0.913× | 0.788–1.191 | no effect |
| M12@single | mesh | 127.976 | 129.427 | +1.1% | 0.987× | 0.967–1.030 | no effect |
| M12@single | stl | 110.496 | 112.542 | +1.9% | 0.987× | 0.957–1.017 | no effect |
| M12@multi | construct | 34664.796 | 28367.272 | -18.2% | 1.208× | 1.171–1.262 | faster |
| M12@multi | author | 458.735 | 440.819 | -3.9% | 1.050× | 1.004–1.070 | faster |
| M12@multi | kernel:bounding.create | 98.070 | 45.837 | -53.3% | 2.193× | 2.017–2.317 | faster |
| M12@multi | kernel:turning-fins.hot | 3803.266 | 3815.970 | +0.3% | 1.004× | 0.970–1.024 | no effect |
| M12@multi | kernel:turning-fins.cool | 3800.351 | 3815.717 | +0.4% | 0.989× | 0.967–1.023 | no effect |
| M12@multi | kernel:corner-fins.union | 10.986 | 3.075 | -72.0% | 3.929× | 3.047–4.752 | faster |
| M12@multi | kernel:straight-fins.hot | 1238.182 | 1238.363 | +0.0% | 0.998× | 0.970–1.029 | no effect |
| M12@multi | kernel:straight-fins.cool | 1241.981 | 1237.154 | -0.4% | 1.007× | 0.964–1.031 | no effect |
| M12@multi | kernel:straight-fins.union | 9.070 | 2.345 | -74.1% | 3.489× | 3.189–4.636 | faster |
| M12@multi | kernel:fins.union | 7.691 | 1.615 | -79.0% | 4.935× | 3.656–5.677 | faster |
| M12@multi | kernel:outer-structure.create | 2236.334 | 1979.177 | -11.5% | 1.128× | 1.051–1.196 | faster |
| M12@multi | kernel:helical-void.hot | 5190.923 | 5179.336 | -0.2% | 0.994× | 0.966–1.025 | no effect |
| M12@multi | kernel:helical-void.cool | 5179.769 | 5174.979 | -0.1% | 0.996× | 0.971–1.023 | no effect |
| M12@multi | kernel:cool-inner.offset | 145.311 | 126.090 | -13.2% | 1.139× | 1.039–1.215 | faster |
| M12@multi | kernel:hot-fluid-void.subtract | 12.988 | 2.383 | -81.7% | 5.402× | 4.562–6.565 | faster |
| M12@multi | kernel:hot-inner.offset | 141.027 | 126.383 | -10.4% | 1.135× | 1.059–1.193 | faster |
| M12@multi | kernel:cool-fluid-void.subtract | 12.265 | 2.484 | -79.7% | 5.755× | 4.396–6.302 | faster |
| M12@multi | kernel:inner-volume.union | 12.524 | 2.528 | -79.8% | 5.038× | 4.173–5.286 | faster |
| M12@multi | kernel:splitters.union | 1.929 | 1.309 | -32.1% | 1.335× | 0.907–2.162 | no effect |
| M12@multi | kernel:outer-volume.offset | 159.606 | 141.371 | -11.4% | 1.148× | 1.075–1.246 | faster |
| M12@multi | kernel:flange.create | 2549.374 | 2110.084 | -17.2% | 1.208× | 1.172–1.246 | faster |
| M12@multi | kernel:finished-flange.fillet | 236.272 | 172.787 | -26.9% | 1.418× | 1.219–1.588 | faster |
| M12@multi | kernel:finished-flange.smoothen | 37.284 | 25.998 | -30.3% | 1.460× | 1.294–1.571 | faster |
| M12@multi | kernel:outer-volume.union-flange | 7.254 | 1.860 | -74.4% | 3.494× | 2.810–4.297 | faster |
| M12@multi | kernel:io-supports.create | 175.651 | 173.694 | -1.1% | 0.989× | 0.969–1.039 | no effect |
| M12@multi | kernel:outer-volume.union-supports | 14.266 | 2.306 | -83.8% | 6.594× | 5.704–7.412 | faster |
| M12@multi | kernel:outer-volume.fillet | 1069.682 | 899.103 | -15.9% | 1.201× | 1.091–1.287 | faster |
| M12@multi | kernel:outer-volume.smoothen | 181.545 | 151.495 | -16.6% | 1.204× | 1.093–1.282 | faster |
| M12@multi | kernel:centre-piece.add | 35.267 | 11.162 | -68.3% | 3.281× | 2.984–3.518 | faster |
| M12@multi | kernel:outer-volume.union-structure | 9.944 | 2.089 | -79.0% | 4.794× | 3.745–5.475 | faster |
| M12@multi | kernel:outer-volume.subtract-screw-holes | 5.630 | 1.504 | -73.3% | 3.348× | 2.990–4.179 | faster |
| M12@multi | kernel:outer-volume.project-z-slice | 7.983 | 4.957 | -37.9% | 1.560× | 1.507–1.681 | faster |
| M12@multi | kernel:print-web.create | 3.032 | 2.977 | -1.8% | 1.014× | 1.001–1.036 | faster |
| M12@multi | kernel:outer-volume.subtract-print-web | 11.224 | 1.916 | -82.9% | 5.877× | 4.418–6.563 | faster |
| M12@multi | kernel:result.subtract-inner-volume | 13.329 | 2.598 | -80.5% | 5.032× | 4.166–6.612 | faster |
| M12@multi | kernel:result.union-fins | 13.315 | 2.911 | -78.1% | 4.767× | 3.615–6.277 | faster |
| M12@multi | kernel:result.union-splitters | 9.099 | 2.123 | -76.7% | 4.380× | 3.780–4.803 | faster |
| M12@multi | kernel:result.intersect-bounding | 14.758 | 2.961 | -79.9% | 5.282× | 3.937–6.617 | faster |
| M12@multi | kernel:io-threads.create | 6333.669 | 1388.246 | -78.1% | 4.581× | 4.277–4.900 | faster |
| M12@multi | kernel:result.union-threads | 7.655 | 1.781 | -76.7% | 3.998× | 3.255–5.197 | faster |
| M12@multi | kernel:io-cuts.create | 36.454 | 22.317 | -38.8% | 1.621× | 1.552–1.724 | faster |
| M12@multi | kernel:result.subtract-io-cuts | 6.419 | 1.450 | -77.4% | 3.788× | 3.671–5.471 | faster |
| M12@multi | unattributed | 0.457 | 0.412 | -9.7% | 1.133× | 0.913–1.220 | no effect |
| M12@multi | mesh | 56.446 | 37.817 | -33.0% | 1.475× | 1.395–1.574 | faster |
| M12@multi | stl | 112.831 | 113.588 | +0.7% | 0.989× | 0.954–1.021 | no effect |
| M13 | callback | 35.091 | 35.626 | +1.5% | 0.983× | 0.969–1.009 | no effect |
| M13 | tape | 13.070 | 13.300 | +1.8% | 0.982× | 0.969–1.002 | no effect |
| M14 | gen0 | 4.598 | 4.663 | +1.4% | 0.988× | 0.959–1.002 | no effect |
| M14 | gen1 | 133.064 | 134.286 | +0.9% | 0.994× | 0.958–1.016 | no effect |
| M14 | gen2 | 5774.498 | 5894.861 | +2.1% | 0.981× | 0.938–1.015 | no effect |

120 phases compared: 43 faster, 5 regressions, 72 no measurable effect.
REGRESSION M12@single/kernel:corner-fins.union: 0.926× (10.5%)
REGRESSION M12@single/kernel:hot-fluid-void.subtract: 0.943× (9.1%)
REGRESSION M12@single/kernel:cool-fluid-void.subtract: 0.933× (6.6%)
REGRESSION M12@single/kernel:result.union-threads: 0.920× (10.6%)
REGRESSION M12@single/kernel:result.subtract-io-cuts: 0.827× (21.8%)
