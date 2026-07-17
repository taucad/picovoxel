#!/usr/bin/env bash
# R4 + R7 — headless PicoGK core -> picogk.wasm, and the bit-exact parity check.
#
# Upstream stays PRISTINE. No patch queue:
#   * core TU is generated (make-core-tu.sh), cutting at the first Viewer_* export
#   * PicoGK core's whole ImGui dependency is a 4-float struct -> shim/imgui.h
#   * we own our target, so "de-globbing" is just listing one source
#
# Parity note (R7): wasm has NO FMA instruction; arm64 clang fuses a*b+c into FMADD
# by default. That single-vs-double rounding is the ONLY wasm/native divergence
# (<=1.9nm). The native PARITY reference must therefore build -ffp-contract=off.
# Benchmark against the DEFAULT native build instead — that's what native users get.
set -euo pipefail

EMSDK="${EMSDK:-$HOME/git/tau/repos/opencascade.js/deps/emsdk}"
PICOGK_RUNTIME="${PICOGK_RUNTIME:-$HOME/git/tau/repos/PicoGKRuntime}"
PREFIX="${PREFIX:?set PREFIX to the wasm OpenVDB+TBB install prefix (see scripts/build-deps-wasm.sh)}"
OUT="${OUT:-$PWD/build}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM_FLAGS="${WASM_FLAGS:--O3 -msimd128}"
# Must match the prefix's EH model (see build-deps-wasm.sh). Legacy format pinned:
# Safari 15.2+ vs exnref's 18.4+ — the 16.4 SIMD floor sits between them.
EH_FLAGS="${EH_FLAGS:--fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1}"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
NODE="$EMSDK/node/22.16.0_64bit/bin/node"
mkdir -p "$OUT"

echo "=== R4: generate headless core TU (expect 140 core / 33 viewer) ==="
bash "$HERE/scripts/make-core-tu.sh" \
  "$PICOGK_RUNTIME/Source/PicoGKLibrary.cpp" "$OUT/PicoGKLibraryCore.cpp"

echo "=== R7: compile PicoGK core -> wasm ==="
# Exception support is MANDATORY: HandleManager::roGet throws through extern "C" and
# PicoGKLibrary.cpp has zero try/catch — without it one bad handle kills the module.
# -fwasm-exceptions (2026-07-18): native wasm EH, replacing JS-EH -fexceptions —
# −8.1% wasm size and 1.1–4.5× on EH-sensitive paths, differential byte-identical.
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$OUT/PicoGKLibraryCore.cpp" -o "$OUT/picogk_core.o" \
  -I"$HERE/shim" -I"$PICOGK_RUNTIME/API" -I"$PICOGK_RUNTIME/Source" -I"$PREFIX/include" \
  -DPICOGK_BUILD_LIBRARY

echo "=== R7: link -> picogk.wasm ==="
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS "$HERE/bench/picogk-parity.cpp" "$OUT/picogk_core.o" \
  -o "$OUT/picogk.cjs" -I"$HERE/shim" -I"$PICOGK_RUNTIME/API" \
  "$PREFIX/lib/libopenvdb.a" "$PREFIX/lib/libtbb.a" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1
echo "picogk.wasm: $(du -h "$OUT/picogk.wasm" | cut -f1)"

N=$("$EMSDK/upstream/bin/wasm-dis" "$OUT/picogk.wasm" | grep -cE '\b(f32x4|i32x4|v128)\.' || true)
echo "SIMD instructions: $N"
[ "$N" -gt 0 ] || { echo "FAIL: scalar build (correct but ~26% slow, invisible to functional tests)"; exit 1; }

echo "=== S4 gate: sphere -> Mesh_hCreateFromVoxels -> triangles > 0 ==="
"$NODE" "$OUT/picogk.cjs" 0.5 | tee "$OUT/s4.txt"
grep -q "RESULT=OK" "$OUT/s4.txt" || { echo "FAIL: S4"; exit 1; }
grep -q "leaked: voxels=0 meshes=0" "$OUT/s4.txt" || { echo "FAIL: leaked handles"; exit 1; }

echo "=== D5 gate: bit-exact parity vs an -ffp-contract=off native reference ==="
NB="${NATIVE_PARITY_BUILD:-}"
if [ -z "$NB" ]; then
  echo "SKIP: set NATIVE_PARITY_BUILD to a PicoGKRuntime build configured with"
  echo "      -DCMAKE_CXX_FLAGS=-ffp-contract=off  (a DEFAULT native build will NOT match)"
  exit 0
fi
cp "$NB/lib/"*.dylib "$OUT/" 2>/dev/null || true
clang++ -std=c++20 -O3 "$HERE/bench/picogk-parity.cpp" -o "$OUT/picogk_native" \
  -I"$PICOGK_RUNTIME/API" "$OUT/picogk.26.2.0.dylib" -Wl,-rpath,@loader_path

fail=0
for V in 1.0 0.5 0.25; do
  hw=$("$NODE" "$OUT/picogk.cjs" "$V" | sed -n 's/.*rawHash=\([0-9]*\).*/\1/p')
  hn=$(cd "$OUT" && ./picogk_native "$V" | sed -n 's/.*rawHash=\([0-9]*\).*/\1/p')
  if [ "$hw" = "$hn" ]; then echo "  ${V}mm  MATCH  $hw"
  else echo "  ${V}mm  DIFFER wasm=$hw native=$hn"; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "D5 PASS — bit-exact" || { echo "D5 FAIL"; exit 1; }
