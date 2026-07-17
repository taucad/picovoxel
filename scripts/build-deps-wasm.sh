#!/usr/bin/env bash
# Builds the wasm OpenVDB + oneTBB prefix that build-picogk-{wasm,module}.sh link.
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
# WASM_LEGACY_EXCEPTIONS is [compile+link]: pin the legacy EH format everywhere
# (Safari 15.2+; the exnref format is 18.4+, above the 16.4 SIMD floor).
EH_FLAGS="${EH_FLAGS:--fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1}"
# Sources resolve vendor-first (scripts/fetch-deps.sh); the sibling checkouts remain
# the documented local fallback for development without a vendor/ tree.
if [ -z "${EMSDK:-}" ]; then
  if [ -x "$HERE/vendor/emsdk/emsdk" ]; then EMSDK="$HERE/vendor/emsdk"
  else EMSDK="$HOME/git/tau/repos/opencascade.js/deps/emsdk"; fi
fi
if [ -z "${PICOGK_RUNTIME:-}" ]; then
  if [ -d "$HERE/vendor/PicoGKRuntime/Source" ]; then PICOGK_RUNTIME="$HERE/vendor/PicoGKRuntime"
  else PICOGK_RUNTIME="$HOME/git/tau/repos/PicoGKRuntime"; fi
fi
if [ -z "${ONETBB_SRC:-}" ]; then
  if [ -d "$HERE/vendor/oneTBB/src" ]; then ONETBB_SRC="$HERE/vendor/oneTBB"
  else ONETBB_SRC="$HOME/git/tau/repos/oneTBB"; fi
fi
OUT="${OUT:-$HERE/build}"
PREFIX="${PREFIX:-$OUT/wasm-prefix}"

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
[ -d "$EMSDK/upstream/emscripten/node_modules/acorn" ] || \
  (cd "$EMSDK/upstream/emscripten" && npm install acorn --no-save --no-audit --no-fund)

echo "=== oneTBB -> wasm (serial) ==="
emcmake cmake -B "$OUT/tbb-wasm" -S "$ONETBB_SRC" -DCMAKE_BUILD_TYPE=Release \
  -DTBB_STRICT=OFF \
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON -DBUILD_SHARED_LIBS=OFF \
  -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DEMSCRIPTEN_WITHOUT_PTHREAD=true \
  -DCMAKE_CXX_FLAGS="-Wno-unused-command-line-argument $WASM_FLAGS $EH_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/tbb-wasm" -j"$(sysctl -n hw.ncpu)" --target install

echo "=== OpenVDB -> wasm ==="
emcmake cmake -B "$OUT/ovdb-wasm" -S "$PICOGK_RUNTIME/openvdb" -DCMAKE_BUILD_TYPE=Release \
  -DOPENVDB_USE_DELAYED_LOADING=OFF -DUSE_BLOSC=OFF -DUSE_ZLIB=OFF -DUSE_EXR=OFF \
  -DOPENVDB_BUILD_BINARIES=OFF -DOPENVDB_BUILD_UNITTESTS=OFF \
  -DOPENVDB_BUILD_PYTHON_MODULE=OFF -DOPENVDB_BUILD_NANOVDB=OFF \
  -DOPENVDB_CORE_SHARED=OFF -DOPENVDB_CORE_STATIC=ON -DUSE_EXPLICIT_INSTANTIATION=OFF \
  -DTBB_ROOT="$PREFIX" \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_CXX_FLAGS="$WASM_FLAGS $EH_FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$OUT/ovdb-wasm" -j"$(sysctl -n hw.ncpu)"
cmake --install "$OUT/ovdb-wasm" --prefix "$PREFIX"
echo "PREFIX ready: $PREFIX"
ls -la "$PREFIX/lib/"
