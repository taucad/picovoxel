#!/usr/bin/env bash
# Library module build — produces picogk.mjs + picogk.wasm (MODULARIZE/EXPORT_ES6),
# the artifact `src/index.mjs` loads. Reconstructed 2026-07-18 from the build-harness
# flag matrix + shipped-artifact forensics (256MB initial memory, 144 exported
# functions, runtime-method set measured from src/*.mjs usage); this build was
# previously ad hoc. The parity CLI harness lives in build-picogk-wasm.sh.
#
# Exceptions: -fwasm-exceptions (native wasm EH). JS EH (-fexceptions) routed every
# potentially-throwing call in EH-aware frames through JS invoke_* trampolines; wasm
# EH keeps unwinding inside wasm. Exception support itself is MANDATORY either way:
# HandleManager::roGet throws through extern "C" and PicoGKLibrary.cpp has zero
# try/catch — without support one bad handle kills the module. Escaped C++ throws
# surface in JS as WebAssembly.Exception (not the JS-EH bare Number) — see
# src/errors.mjs. WASM_LEGACY_EXCEPTIONS is pinned ON: the legacy EH format is
# Safari 15.2+, inside the 16.4 SIMD floor; the newer exnref format is Safari 18.4+
# and would break the floor if an emsdk upgrade flips the default.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Sources resolve vendor-first (scripts/fetch-deps.sh); siblings are the fallback.
if [ -z "${EMSDK:-}" ]; then
  if [ -x "$HERE/vendor/emsdk/emsdk" ]; then EMSDK="$HERE/vendor/emsdk"
  else EMSDK="$HOME/git/tau/repos/opencascade.js/deps/emsdk"; fi
fi
if [ -z "${PICOGK_RUNTIME:-}" ]; then
  if [ -d "$HERE/vendor/PicoGKRuntime/Source" ]; then PICOGK_RUNTIME="$HERE/vendor/PicoGKRuntime"
  else PICOGK_RUNTIME="$HOME/git/tau/repos/PicoGKRuntime"; fi
fi
OUT="${OUT:-$HERE/build}"
PREFIX="${PREFIX:-$OUT/wasm-prefix}"
OUT_JS="${OUT_JS:-$HERE/src}"
WASM_FLAGS="${WASM_FLAGS:--O3 -msimd128}"
EH_FLAGS="${EH_FLAGS:--fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1}"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$OUT" "$OUT_JS"

echo "=== generate headless core TU ==="
bash "$HERE/scripts/make-core-tu.sh" \
  "$PICOGK_RUNTIME/Source/PicoGKLibrary.cpp" "$OUT/PicoGKLibraryCore.cpp"

INCLUDES=(-I"$HERE/shim" -I"$PICOGK_RUNTIME/API" -I"$PICOGK_RUNTIME/Source" -I"$PREFIX/include")

echo "=== compile core + bulk TUs ==="
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$OUT/PicoGKLibraryCore.cpp" \
  -o "$OUT/picogk_core_module.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/picogk-bulk.cpp" \
  -o "$OUT/picogk_bulk_module.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY

echo "=== link -> picogk.mjs ==="
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS \
  "$OUT/picogk_core_module.o" "$OUT/picogk_bulk_module.o" \
  "$PREFIX/lib/libopenvdb.a" "$PREFIX/lib/libtbb.a" \
  -o "$OUT_JS/picogk.mjs" \
  -sMODULARIZE -sEXPORT_ES6=1 -sEXPORT_NAME=createPicoGKModule \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=@"$HERE/src/picogk-exports.txt" \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction,removeFunction,FS,HEAPF32,HEAP32,HEAPU32

echo "picogk.wasm: $(stat -f%z "$OUT_JS/picogk.wasm") bytes; picogk.mjs: $(stat -f%z "$OUT_JS/picogk.mjs") bytes"

N=$("$EMSDK/upstream/bin/wasm-dis" "$OUT_JS/picogk.wasm" | grep -cE '\b(f32x4|i32x4|v128)\.' || true)
echo "SIMD instructions: $N"
[ "$N" -gt 0 ] || { echo "FAIL: scalar build (correct but ~26% slow, invisible to functional tests)"; exit 1; }
