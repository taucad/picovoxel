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
# Sources come from vendor/ (scripts/fetch-deps.sh); EMSDK/PICOGK_RUNTIME may point
# elsewhere deliberately, but there is no silent fallback to an unpatched checkout.
EMSDK="${EMSDK:-$HERE/vendor/emsdk}"
PICOGK_RUNTIME="${PICOGK_RUNTIME:-$HERE/vendor/PicoGKRuntime}"
if ! { [ -x "$EMSDK/emsdk" ] && [ -d "$PICOGK_RUNTIME/Source" ] && [ -f "$HERE/vendor/xxhash/xxhash.h" ]; }; then
  echo "build-pico-module: missing vendor/ sources; run scripts/fetch-deps.sh first" >&2
  exit 1
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
RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,addFunction,removeFunction,FS,HEAPF32,HEAPF64,HEAP32,HEAPU32,HEAPU8
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
# D27: -ffile-prefix-map (which implies -fmacro-prefix-map) rewrites the builder's
# checkout path to "." in every __FILE__ the live assert()s embed. The asserts
# stay live on purpose (no -DNDEBUG): an abort on a violated precondition is
# safer than undefined behaviour in the L0 oracle lane.
# shellcheck disable=SC2206 # WASM_FLAGS/EH_FLAGS are space-separated flag lists by contract
CXXFLAGS=(-std=c++20 $WASM_FLAGS $EH_FLAGS "-ffile-prefix-map=$HERE=." "${INCLUDES[@]}" -DPICOGK_BUILD_LIBRARY)

# The TUs are independent, so they compile in parallel, bounded by the core count
# (each em++ at -O3 holds ~1 GB). Bash 3.2-compatible limiter: when the window is
# full, wait for the oldest job; `set -e` turns any failed compile into a failed
# build. The two heaviest TUs (core, tape) start first.
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN)}"
PIDS=()
compile() { # <source> <object> [extra flags...]
  local source="$1" object="$2"
  shift 2
  em++ "${CXXFLAGS[@]}" "$@" -c "$source" -o "$object" &
  PIDS+=("$!")
  if [ "${#PIDS[@]}" -ge "$JOBS" ]; then
    wait "${PIDS[0]}"
    PIDS=("${PIDS[@]:1}")
  fi
}

echo "=== compile core + tape + bulk + props + offset + lattice + hash + boolean + zslice + query TUs (-j$JOBS) ==="
compile "$OUT/PicoGKLibraryCore.cpp" "$OUT/pico_core_module$MT.o"
compile "$HERE/src/pico-tape.cpp" "$OUT/pico_tape_module$MT.o"
compile "$HERE/src/pico-bulk.cpp" "$OUT/pico_bulk_module$MT.o"
compile "$HERE/src/pico-props.cpp" "$OUT/pico_props_module$MT.o"
compile "$HERE/src/pico-offset.cpp" "$OUT/pico_offset_module$MT.o"
compile "$HERE/src/pico-lattice.cpp" "$OUT/pico_lattice_module$MT.o"
compile "$HERE/src/pico-hash.cpp" "$OUT/pico_hash_module$MT.o" -I"$HERE/vendor/xxhash"
compile "$HERE/src/pico-boolean.cpp" "$OUT/pico_boolean_module$MT.o"
compile "$HERE/src/pico-zslice.cpp" "$OUT/pico_zslice_module$MT.o"
compile "$HERE/src/pico-query.cpp" "$OUT/pico_query_module$MT.o"
for pid in ${PIDS[@]+"${PIDS[@]}"}; do wait "$pid"; done

echo "=== link -> $VARIANT.mjs ==="
# shellcheck disable=SC2086 # WASM_FLAGS and EH_FLAGS are flag lists, split on purpose.
em++ -std=c++20 $WASM_FLAGS $EH_FLAGS "-ffile-prefix-map=$HERE=." \
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

echo "$VARIANT.wasm: $(wc -c < "$OUT_JS/$VARIANT.wasm" | tr -d ' ') bytes; $VARIANT.mjs: $(wc -c < "$OUT_JS/$VARIANT.mjs" | tr -d ' ') bytes; malloc=$MALLOC"

# The glue reads minified export names; record them so createPicoRuntime({ wasmModule })
# can refuse a module from another build (test/wasm-exports.test.ts guards drift).
node "$HERE/scripts/generate-wasm-exports.mjs" "$VARIANT" "$OUT_JS"

N=$("$EMSDK/upstream/bin/wasm-dis" "$OUT_JS/$VARIANT.wasm" | grep -cE '\b(f32x4|i32x4|v128)\.' || true)
echo "SIMD instructions: $N"
[ "$N" -gt 0 ] || { echo "FAIL: scalar build (correct but ~26% slow, invisible to functional tests)"; exit 1; }
