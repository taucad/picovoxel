#!/usr/bin/env bash
# Builds the wasm OpenVDB + oneTBB prefix that build-pico-{wasm,module}.sh link.
# Extracted from bench/build.sh (R6) so the prefix is rebuildable without running
# the native benches.
#
# EH note (measured 2026-07-18): the EH model must match the final link, and only
# oneTBB breaks under a mismatch — it hardcodes -fexceptions for Emscripten
# (cmake/compilers/Clang.cmake:17), leaving real __resumeException/invoke_* JS-EH
# imports in libtbb.a that fail a -fwasm-exceptions link. -fwasm-exceptions wins
# over a co-occurring -fexceptions in either order (probed on emcc 5.0.1), so
# appending it via CMAKE_CXX_FLAGS overrides oneTBB's flag without a patch.
# OpenVDB emits no JS-EH imports either way (beware: nm|grep invoke_ false-matches
# mangled std::__invoke_*), but under wasm EH it compiles its own catch landing
# pads (+745KB archive), so keep EH_FLAGS on both builds for one coherent model.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM_FLAGS="${WASM_FLAGS:--O3 -msimd128}"
# THREADS=1 — pthread variant in its own -mt tree. Shared-memory ABI: these
# objects are NOT link-compatible with the serial ones, hence separate dirs.
# oneTBB gets real pthreads (no EMSCRIPTEN_WITHOUT_PTHREAD).
if [ "${THREADS:-0}" = "1" ]; then MT="-mt"; WASM_FLAGS="$WASM_FLAGS -pthread"; TBB_PTHREAD_ARGS=(); else MT=""; TBB_PTHREAD_ARGS=(-DEMSCRIPTEN_WITHOUT_PTHREAD=true); fi
# WASM_LEGACY_EXCEPTIONS is [compile+link]: pin the legacy EH format everywhere
# (Safari 15.2+; the exnref format is 18.4+, above the 16.4 SIMD floor).
EH_FLAGS="${EH_FLAGS:--fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1}"
# Sources come from vendor/ (scripts/fetch-deps.sh: pinned, patched, stamped).
# EMSDK/PICOGK_RUNTIME/ONETBB_SRC may point elsewhere deliberately; there is no
# silent fallback to an unpatched checkout.
EMSDK="${EMSDK:-$HERE/vendor/emsdk}"
PICOGK_RUNTIME="${PICOGK_RUNTIME:-$HERE/vendor/PicoGKRuntime}"
ONETBB_SRC="${ONETBB_SRC:-$HERE/vendor/oneTBB}"
if ! { [ -x "$EMSDK/emsdk" ] && [ -d "$PICOGK_RUNTIME/openvdb" ] && [ -d "$ONETBB_SRC/src" ]; }; then
  echo "build-deps-wasm: missing vendor/ sources; run scripts/fetch-deps.sh first" >&2
  exit 1
fi
OUT="${OUT:-$HERE/build}"
PREFIX="${PREFIX:-$OUT/wasm-prefix$MT}"

# D27: builder paths never reach the archives' __FILE__ strings or the shipped wasm.
WASM_FLAGS="$WASM_FLAGS -ffile-prefix-map=$HERE=."
JOBS="$(getconf _NPROCESSORS_ONLN)"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

# TBB_EMSCRIPTEN_STACK_SIZE (SK-0.7): worker pthread stack, 64 KB upstream. Deep
# OpenVDB tree recursion runs on those stacks and -O3 emits no overflow check, so
# an overflow is silent heap corruption rather than a crash. 1 MB is native-ish
# headroom and costs ~1 MB per launched worker of a 256 MB heap. The knob is only
# reachable because patches/oneTBB makes it overridable.
echo "=== oneTBB -> wasm (${MT:+pthread}${MT:-serial}) ==="
emcmake cmake -B "$OUT/tbb-wasm$MT" -S "$ONETBB_SRC" -DCMAKE_BUILD_TYPE=Release \
  -DTBB_STRICT=OFF \
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON -DBUILD_SHARED_LIBS=OFF \
  -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF ${TBB_PTHREAD_ARGS[@]+"${TBB_PTHREAD_ARGS[@]}"} \
  -DTBB_EMSCRIPTEN_STACK_SIZE="${TBB_STACK_SIZE:-1048576}" \
  -DCMAKE_CXX_FLAGS="-Wno-unused-command-line-argument $WASM_FLAGS $EH_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/tbb-wasm$MT" -j"$JOBS" --target install

echo "=== OpenVDB -> wasm ==="
emcmake cmake -B "$OUT/ovdb-wasm$MT" -S "$PICOGK_RUNTIME/openvdb" -DCMAKE_BUILD_TYPE=Release \
  -DOPENVDB_USE_DELAYED_LOADING=OFF -DUSE_BLOSC=OFF -DUSE_ZLIB=OFF -DUSE_EXR=OFF \
  -DOPENVDB_BUILD_BINARIES=OFF -DOPENVDB_BUILD_UNITTESTS=OFF \
  -DOPENVDB_BUILD_PYTHON_MODULE=OFF -DOPENVDB_BUILD_NANOVDB=OFF \
  -DOPENVDB_CORE_SHARED=OFF -DOPENVDB_CORE_STATIC=ON -DUSE_EXPLICIT_INSTANTIATION=OFF \
  -DTBB_ROOT="$PREFIX" \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_CXX_FLAGS="$WASM_FLAGS $EH_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/ovdb-wasm$MT" -j"$JOBS"
cmake --install "$OUT/ovdb-wasm$MT" --prefix "$PREFIX"
echo "PREFIX ready: $PREFIX"
ls -la "$PREFIX/lib/"
