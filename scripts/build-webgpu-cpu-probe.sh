#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK="${EMSDK:-$ROOT/vendor/emsdk}"
ONETBB_SRC="${ONETBB_SRC:-$ROOT/vendor/oneTBB}"
BUILD_DIR="$ROOT/build/webgpu-cpu-probe"
PREFIX="$BUILD_DIR/prefix"
OUTPUT_DIR="$ROOT/spikes/webgpu/dist"
EH_FLAGS=(-fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1)

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

if [ ! -f "$PREFIX/lib/libtbb.a" ]; then
  emcmake cmake -B "$BUILD_DIR/oneTBB" -S "$ONETBB_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DTBB_STRICT=OFF \
    -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DTBB_TEST=OFF \
    -DTBB_EXAMPLES=OFF \
    -DCMAKE_CXX_FLAGS="-Wno-unused-command-line-argument -O3 -msimd128 -pthread ${EH_FLAGS[*]}" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX"
  cmake --build "$BUILD_DIR/oneTBB" -j"$(sysctl -n hw.ncpu)" --target install
fi

em++ -std=c++20 -O3 -msimd128 -pthread "${EH_FLAGS[@]}" \
  "$ROOT/spikes/webgpu/cpu-tape-probe.cpp" \
  "$PREFIX/lib/libtbb.a" \
  -I"$ROOT/vendor/PicoGKRuntime/API" \
  -I"$PREFIX/include" \
  -DPICOGK_BUILD_LIBRARY \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=268435456 \
  -sMAXIMUM_MEMORY=1073741824 \
  -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_CpuTapeProbe_Eval","_CpuTapeProbe_LastThreadCount","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["cwrap","HEAPF32"]' \
  -o "$OUTPUT_DIR/cpu-tape-probe.mjs"
