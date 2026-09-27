#!/usr/bin/env bash
#
# Build the isolated pthread PicoGK wasm used by the P1/P2 WebGPU spikes.
#
# The output lives under spikes/webgpu and never overwrites the byte-locked L0
# modules in src/. See docs/research/picogk-webgpu-{p1,p2}-*.md.
#
# Required env vars:
#   none
# Optional env vars:
#   EMSDK            emsdk checkout (default: vendor/emsdk)
#   PICOGK_RUNTIME   PicoGKRuntime checkout (default: vendor/PicoGKRuntime)
#   PREFIX           prebuilt pthread OpenVDB/oneTBB prefix
#
# Usage:
#   bash scripts/build-webgpu-picovoxel-spike.sh
#
# Exit codes:
#   0  Success
#   1  Validation or build failure
#   3  Missing dependency

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
EMSDK="${EMSDK:-$REPO_ROOT/vendor/emsdk}"
PICOGK_RUNTIME="${PICOGK_RUNTIME:-$REPO_ROOT/vendor/PicoGKRuntime}"
BUILD_ROOT="$REPO_ROOT/build/webgpu-picovoxel-spike"
PREFIX="${PREFIX:-$REPO_ROOT/build/wasm-prefix-mt}"
OUTPUT_ROOT="$REPO_ROOT/spikes/webgpu/picovoxel-dist"

[[ -x "$EMSDK/emsdk" ]] || { printf '%s\n' 'ERROR: emsdk is missing' >&2; exit 3; }
[[ -d "$PICOGK_RUNTIME/Source" ]] || { printf '%s\n' 'ERROR: PicoGKRuntime is missing' >&2; exit 3; }

if [[ ! -f "$PREFIX/lib/libopenvdb.a" || ! -f "$PREFIX/lib/libtbb.a" ]]; then
  printf '%s\n' '→ building pthread OpenVDB/oneTBB prefix'
  THREADS=1 PREFIX="$PREFIX" bash "$REPO_ROOT/scripts/build-deps-wasm.sh"
fi

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$BUILD_ROOT" "$OUTPUT_ROOT"

printf '%s\n' '→ generating headless core and spike export list'
bash "$REPO_ROOT/scripts/make-core-tu.sh" \
  "$PICOGK_RUNTIME/Source/PicoGKLibrary.cpp" \
  "$BUILD_ROOT/PicoGKLibraryCore.cpp"
cp "$REPO_ROOT/src/pico-exports.txt" "$BUILD_ROOT/pico-webgpu-exports.txt"
printf '%s\n' \
  _Voxels_NanoCreate \
  _Voxels_NanoApplyValues \
  _Voxels_NanoRebuildValues \
  _Voxels_NanoTransformActive \
  _Voxels_NanoBounds \
  _Voxels_NanoSampleBox \
  _Voxels_NanoPopulateSynthetic \
  _Voxels_NanoDispose \
  _Voxels_TapeGpuClassify \
  _Voxels_TapeGpuGetInfo \
  _Voxels_TapeGpuEvalCpuSamples \
  _Voxels_TapeGpuIngest \
  _Voxels_TapeGpuDispose \
  >> "$BUILD_ROOT/pico-webgpu-exports.txt"

WASM_FLAGS=(-O3 -msimd128 -pthread)
EH_FLAGS=(-fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1)
INCLUDES=(
  -I"$REPO_ROOT/shim"
  -I"$PICOGK_RUNTIME/API"
  -I"$PICOGK_RUNTIME/Source"
  -I"$PICOGK_RUNTIME/openvdb/nanovdb"
  -I"$PREFIX/include"
)

printf '%s\n' '→ compiling spike-only zero-patch translation units'
em++ -std=c++20 "${WASM_FLAGS[@]}" "${EH_FLAGS[@]}" \
  -c "$BUILD_ROOT/PicoGKLibraryCore.cpp" \
  -o "$BUILD_ROOT/pico-core.o" \
  "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 "${WASM_FLAGS[@]}" "${EH_FLAGS[@]}" \
  -c "$REPO_ROOT/src/pico-bulk.cpp" \
  -o "$BUILD_ROOT/pico-bulk.o" \
  "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 "${WASM_FLAGS[@]}" "${EH_FLAGS[@]}" \
  -c "$REPO_ROOT/spikes/webgpu/cpp/pico-tape-spike.cpp" \
  -o "$BUILD_ROOT/pico-tape-spike.o" \
  "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 "${WASM_FLAGS[@]}" "${EH_FLAGS[@]}" \
  -c "$REPO_ROOT/spikes/webgpu/cpp/pico-nano.cpp" \
  -o "$BUILD_ROOT/pico-nano.o" \
  "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY \
  -DNANOVDB_USE_OPENVDB -DNANOVDB_USE_TBB

printf '%s\n' '→ linking isolated WebGPU spike module'
em++ -std=c++20 "${WASM_FLAGS[@]}" "${EH_FLAGS[@]}" \
  "$BUILD_ROOT/pico-core.o" \
  "$BUILD_ROOT/pico-bulk.o" \
  "$BUILD_ROOT/pico-tape-spike.o" \
  "$BUILD_ROOT/pico-nano.o" \
  "$PREFIX/lib/libopenvdb.a" \
  "$PREFIX/lib/libtbb.a" \
  -o "$OUTPUT_ROOT/pico-webgpu-spike.mjs" \
  -sMODULARIZE -sEXPORT_ES6=1 -sEXPORT_NAME=createPicoWebGpuSpikeModule \
  -sPTHREAD_POOL_SIZE=12 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=@"$BUILD_ROOT/pico-webgpu-exports.txt" \
  -sEXPORTED_RUNTIME_METHODS=cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction,removeFunction,FS,HEAP8,HEAPU8,HEAPF32,HEAPF64,HEAP32,HEAPU32,PThread

printf '✓ %s\n' "$OUTPUT_ROOT/pico-webgpu-spike.mjs"
