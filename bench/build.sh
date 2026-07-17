#!/usr/bin/env bash
# R6 (2026-07-17): builds OpenVDB for wasm + native and runs the parity oracle.
# Reproduces: identical raw hashes both targets; wasm 2.1-3.1x native serial (shrinks
# as the workload grows). -O3 BOTH sides; arm64 native has NEON baseline-on, so a
# scalar wasm build makes the tax look ~26% worse AND fakes a flat curve.
#
# Prereqs: emsdk, a native oneTBB (brew install tbb), and a clone of PicoGKRuntime
# (which vendors openvdb as a submodule). Override paths via env.
set -euo pipefail

# The only flag with measured value (1.26x). NOT a default, and it must reach the
# dependency builds — at link time alone it does nothing, since all compute is in
# libopenvdb.a. Rejected after measurement: -flto (net negative), -ffast-math (+1.6%,
# FP risk), -mrelaxed-simd (+2.4%, engine-defined => voids the parity oracle).
WASM_FLAGS="${WASM_FLAGS:--O3 -msimd128}"

EMSDK="${EMSDK:-$HOME/git/tau/repos/opencascade.js/deps/emsdk}"
PICOGK_RUNTIME="${PICOGK_RUNTIME:-$HOME/git/tau/repos/PicoGKRuntime}"
ONETBB_SRC="${ONETBB_SRC:?set ONETBB_SRC to a oneTBB checkout}"
OUT="${OUT:-$PWD/build}"
PREFIX="$OUT/wasm-prefix"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1   # emsdk vendors python 3.13 + node 22; system python 3.9 breaks emcc
NODE="$EMSDK/node/22.16.0_64bit/bin/node"

# emcc's acorn-optimizer runs the unsignPointers pass at EVERY -O level, so a
# missing acorn fails the link after the wasm is already emitted. Not dodgeable via -O0.
[ -d "$EMSDK/upstream/emscripten/node_modules/acorn" ] || \
  (cd "$EMSDK/upstream/emscripten" && npm install acorn --no-save --no-audit --no-fund)

echo "=== oneTBB -> wasm (serial; EMSCRIPTEN_WITHOUT_PTHREAD is the whole threading ladder) ==="
emcmake cmake -B "$OUT/tbb-wasm" -S "$ONETBB_SRC" -DCMAKE_BUILD_TYPE=Release \
  -DTBB_STRICT=OFF \
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON -DBUILD_SHARED_LIBS=OFF \
  -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DEMSCRIPTEN_WITHOUT_PTHREAD=true \
  -DCMAKE_CXX_FLAGS="-Wno-unused-command-line-argument $WASM_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/tbb-wasm" -j"$(sysctl -n hw.ncpu)" --target install

echo "=== OpenVDB -> wasm (deps collapsed to TBB alone) ==="
# TBB_ROOT: OpenVDB uses its own module-mode FindTBB.cmake and ignores TBBConfig.cmake.
# FIND_ROOT_PATH_MODE=BOTH: emcmake sets these to ONLY, so find_* refuses to leave the sysroot.
emcmake cmake -B "$OUT/ovdb-wasm" -S "$PICOGK_RUNTIME/openvdb" -DCMAKE_BUILD_TYPE=Release \
  -DOPENVDB_USE_DELAYED_LOADING=OFF -DUSE_BLOSC=OFF -DUSE_ZLIB=OFF -DUSE_EXR=OFF \
  -DOPENVDB_BUILD_BINARIES=OFF -DOPENVDB_BUILD_UNITTESTS=OFF \
  -DOPENVDB_BUILD_PYTHON_MODULE=OFF -DOPENVDB_BUILD_NANOVDB=OFF \
  -DOPENVDB_CORE_SHARED=OFF -DOPENVDB_CORE_STATIC=ON -DUSE_EXPLICIT_INSTANTIATION=OFF \
  -DTBB_ROOT="$PREFIX" \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_CXX_FLAGS="$WASM_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/ovdb-wasm" -j"$(sysctl -n hw.ncpu)"
cmake --install "$OUT/ovdb-wasm" --prefix "$PREFIX"   # version.h is generated; the source tree alone won't compile

echo "=== bench: wasm + native ==="
em++ -std=c++17 $WASM_FLAGS -fexceptions "$(dirname "$0")/openvdb-parity.cpp" -o "$OUT/bench.js" \
  -I"$PREFIX/include" "$PREFIX/lib/libopenvdb.a" "$PREFIX/lib/libtbb.a" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1

# Native comparison needs a native OpenVDB; reuses PicoGKRuntime's own build tree (R2 flags).
NB="$PICOGK_RUNTIME/build-r2"
clang++ -std=c++17 -O3 "$(dirname "$0")/openvdb-parity.cpp" -o "$OUT/bench_native" \
  -I"$NB/openvdb/openvdb/openvdb/openvdb" -I"$NB/openvdb/openvdb/openvdb" \
  -I"$PICOGK_RUNTIME/openvdb/openvdb" -I/opt/homebrew/include \
  "$NB/lib/libopenvdb.a" -L/opt/homebrew/lib -ltbb

for V in 0.5 0.25 0.125; do
  echo "--- voxel ${V}mm ---"
  printf 'native  1T : '; "$OUT/bench_native" "$V" 1
  printf 'native 12T : '; "$OUT/bench_native" "$V" 12
  printf 'wasm       : '; "$NODE" "$OUT/bench.js" "$V" 0
done
echo
echo "PASS iff all three hashes match per row."
N=$("${EMSDK}/upstream/bin/wasm-dis" "$OUT/bench.wasm" | grep -cE '\b(f32x4|i32x4|v128)\.' || true)
echo "SIMD instructions in bench.wasm: $N  (0 => -msimd128 silently did not apply)"
[ "$N" -gt 0 ] || { echo "FAIL: scalar build - correct but ~26% slow, and no functional test catches this"; exit 1; }
