#!/usr/bin/env bash
# Library module build — produces pico.mjs + pico.wasm (MODULARIZE/EXPORT_ES6),
# the artifact `src/index.mjs` loads. Reconstructed 2026-07-18 from the build-harness
# flag matrix + shipped-artifact forensics (256MB initial memory, 144 exported
# functions, runtime-method set measured from src/*.mjs usage); this build was
# previously ad hoc. The parity CLI harness lives in build-pico-wasm.sh.
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
OUT_JS="${OUT_JS:-$HERE/src}"
WASM_FLAGS="${WASM_FLAGS:--O3 -msimd128}"
EH_FLAGS="${EH_FLAGS:--fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1}"
# Allocator (SK-0.1): link-time only — the dep archives call malloc/free and bind
# at link, so A/B needs no dep rebuild. emscripten's default is dlmalloc, whose
# global free-list mutex serializes the 12-thread creation paths.
# Lane-scoped defaults (SKv2-0 V0.3, per the SK-0-EXIT decision table): the MT
# fast lane (pico-multi) defaults to mimalloc — HeatX multi construct 2.164×
# [CI 2.141–2.178], byte-identical to dlmalloc across all 64 exit-baseline
# comparisons. The single-thread artifact is the L0 oracle lane and stays
# dlmalloc (mimalloc is 0.84–0.99× on 45 of 73 ST phases anyway). MALLOC=…
# still overrides either default for A/B runs.
# THREADS=1 — pthread variant: links the -mt prefix (shared-memory ABI, built by
# THREADS=1 build-deps-wasm.sh) into pico-multi.mjs/.wasm. The pool is
# pre-spawned at nproc: TBB workers park in it, and a pre-spawned pool is the
# only shape that can't deadlock when the main thread blocks in a parallel_for
# (spawn-on-demand needs the event loop, which a blocked main thread never
# reaches). emcc 5.x emits no separate worker file — the glue self-spawns via
# import.meta.url, so the sibling-pair asset shape is unchanged.
RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction,removeFunction,FS,HEAPF32,HEAPF64,HEAP32,HEAPU32
if [ "${THREADS:-0}" = "1" ]; then
  MT="-mt"; VARIANT="pico-multi"
  MALLOC="${MALLOC:-mimalloc}"
  WASM_FLAGS="$WASM_FLAGS -pthread"
  THREAD_LINK_FLAGS=(-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency)
  # PThread exposes pool state: the multi entry's thread warmup is observable
  # (tests assert workers actually engaged — oneTBB serializes silently if not).
  RUNTIME_METHODS="$RUNTIME_METHODS,PThread"
else
  MT=""; VARIANT="pico"
  MALLOC="${MALLOC:-dlmalloc}"
  THREAD_LINK_FLAGS=()
fi
PREFIX="${PREFIX:-$OUT/wasm-prefix$MT}"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$OUT" "$OUT_JS"

echo "=== generate headless core TU ==="
bash "$HERE/scripts/make-core-tu.sh" \
  "$PICOGK_RUNTIME/Source/PicoGKLibrary.cpp" "$OUT/PicoGKLibraryCore.cpp"

INCLUDES=(-I"$HERE/shim" -I"$PICOGK_RUNTIME/API" -I"$PICOGK_RUNTIME/Source" -I"$PREFIX/include")

echo "=== compile core + bulk + tape + props + offset + lattice + hash TUs ==="
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$OUT/PicoGKLibraryCore.cpp" \
  -o "$OUT/pico_core_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-bulk.cpp" \
  -o "$OUT/pico_bulk_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-tape.cpp" \
  -o "$OUT/pico_tape_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-props.cpp" \
  -o "$OUT/pico_props_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-offset.cpp" \
  -o "$OUT/pico_offset_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-lattice.cpp" \
  -o "$OUT/pico_lattice_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-hash.cpp" \
  -o "$OUT/pico_hash_module$MT.o" "${INCLUDES[@]}" -I"$HERE/vendor/xxhash" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-boolean.cpp" \
  -o "$OUT/pico_boolean_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-zslice.cpp" \
  -o "$OUT/pico_zslice_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS -c "$HERE/src/pico-query.cpp" \
  -o "$OUT/pico_query_module$MT.o" "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY

echo "=== link -> $VARIANT.mjs ==="
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS \
  "$OUT/pico_core_module$MT.o" "$OUT/pico_bulk_module$MT.o" "$OUT/pico_tape_module$MT.o" \
  "$OUT/pico_props_module$MT.o" "$OUT/pico_offset_module$MT.o" \
  "$OUT/pico_lattice_module$MT.o" "$OUT/pico_hash_module$MT.o" "$OUT/pico_boolean_module$MT.o" \
  "$OUT/pico_zslice_module$MT.o" "$OUT/pico_query_module$MT.o" \
  "$PREFIX/lib/libopenvdb.a" "$PREFIX/lib/libtbb.a" \
  -o "$OUT_JS/$VARIANT.mjs" \
  ${THREAD_LINK_FLAGS[@]+"${THREAD_LINK_FLAGS[@]}"} \
  -sMODULARIZE -sEXPORT_ES6=1 -sEXPORT_NAME=createPicoModule \
  -sMALLOC="$MALLOC" \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=@"$HERE/src/pico-exports.txt" \
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS"

echo "$VARIANT.wasm: $(stat -f%z "$OUT_JS/$VARIANT.wasm") bytes; $VARIANT.mjs: $(stat -f%z "$OUT_JS/$VARIANT.mjs") bytes; malloc=$MALLOC"

N=$("$EMSDK/upstream/bin/wasm-dis" "$OUT_JS/$VARIANT.wasm" | grep -cE '\b(f32x4|i32x4|v128)\.' || true)
echo "SIMD instructions: $N"
[ "$N" -gt 0 ] || { echo "FAIL: scalar build (correct but ~26% slow, invisible to functional tests)"; exit 1; }
