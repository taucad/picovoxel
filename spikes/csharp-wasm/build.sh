#!/usr/bin/env bash
# C# PicoGK in the browser: builds the unmodified LEAP 71 gyroid-sphere example, the
# PicoGK C# library and ShapeKernel for .NET browser-wasm, with the PicoGK runtime
# (and picovoxel's own exports) statically linked into the same wasm module.
#
# Needs: scripts/fetch-deps.sh sources in vendor/, a .NET 10 SDK with the wasm-tools
# workload on PATH, and an emsdk at the Emscripten version that .NET's workload pins
# (3.1.56 for .NET 10), named by EMSDK_NET. The runtime is rebuilt with that version
# because .NET links its own prebuilt Mono archives with it; picovoxel's 5.0.1 objects
# are not link-compatible with them.
#
# NATIVE=1 also builds the same C# against a native linux-x64 runtime (the baseline).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$ROOT/build/csharp-wasm}"
EMSDK_NET="${EMSDK_NET:?set EMSDK_NET to an emsdk with 3.1.56 activated}"
PICOGK_CS_SHA="0e6cf6b6f4993ec16dbcd72d8f27f26b999980f3"     # leap71/PicoGK (C# library, v2.3.0 line)
SHAPEKERNEL_SHA="827fb6e89c09efdd1c3790bead7bd61b625f1640"   # leap71/LEAP71_ShapeKernel
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN)}"
mkdir -p "$OUT"

# 1. oneTBB hardcodes -fexceptions for Emscripten; emcc 3.1.56 refuses it next to
#    -fwasm-exceptions (5.0.1 lets the later flag win), so this build edits a copy.
rm -rf "$OUT/oneTBB"
cp -r "$ROOT/vendor/oneTBB" "$OUT/oneTBB"
sed -i 's/TBB_COMMON_COMPILE_FLAGS} -fexceptions)/TBB_COMMON_COMPILE_FLAGS} -fwasm-exceptions)/' \
  "$OUT/oneTBB/cmake/compilers/Clang.cmake"

# 2. The runtime at .NET's Emscripten: same scripts, same sources; the legacy-EH
#    setting does not exist in 3.1.56, where legacy is the only wasm EH format.
RT="$OUT/rt"
EMSDK="$EMSDK_NET" ONETBB_SRC="$OUT/oneTBB" EH_FLAGS="-fwasm-exceptions" OUT="$RT" JOBS="$JOBS" \
  bash "$ROOT/scripts/build-deps-wasm.sh"
EMSDK="$EMSDK_NET" EH_FLAGS="-fwasm-exceptions" OUT="$RT" OUT_JS="$RT/js" PREFIX="$RT/wasm-prefix" JOBS="$JOBS" \
  bash "$ROOT/scripts/build-pico-module.sh"
# build-pico-module.sh regenerated src/pico.exports.ts from the 3.1.56 module; restore it.
[ -f "$ROOT/src/pico.wasm" ] && (cd "$ROOT" && node scripts/generate-wasm-exports.mjs pico)

# 3. The C# sources, pinned, then the headless split (prepare.sh).
fetch() { # <dest> <repo> <sha>
  [ -d "$1" ] && return 0
  git init -q "$1"; git -C "$1" fetch -q --depth 1 "https://github.com/$2.git" "$3"; git -C "$1" checkout -q FETCH_HEAD
}
fetch "$OUT/src/PicoGK" leap71/PicoGK "$PICOGK_CS_SHA"
fetch "$OUT/src/ShapeKernel" leap71/LEAP71_ShapeKernel "$SHAPEKERNEL_SHA"

APP="$OUT/app"
rm -rf "$APP"; mkdir -p "$APP/native" "$APP/examples"
cp "$HERE"/{gyroid.csproj,main.mjs,index.html,runtimeconfig.template.json} "$APP/"
cp -r "$HERE/host" "$APP/host"
cp "$HERE/prepare.sh" "$HERE/patch-callbacks.py" "$APP/"
bash "$APP/prepare.sh" "$OUT/src/PicoGK" "$APP/picogk"
cp -r "$OUT/src/ShapeKernel/ShapeKernel" "$APP/shapekernel"
cp "$OUT/src/ShapeKernel/Examples/Ex_ImplicitGyroidSphere.cs" "$APP/examples/"

# 4. The PicoGK runtime as the archive the DllImport name resolves to.
source "$EMSDK_NET/emsdk_env.sh" >/dev/null 2>&1
emar rcs "$APP/native/picogk.26.2.a" "$RT"/pico_*_module.o
cp "$RT/wasm-prefix/lib/libopenvdb.a" "$RT/wasm-prefix/lib/libtbb.a" "$APP/native/"

(cd "$APP" && dotnet publish -c Release)
cp "$APP/index.html" "$APP/bin/Release/net10.0/browser-wasm/AppBundle/"
echo "AppBundle: $APP/bin/Release/net10.0/browser-wasm/AppBundle (node main.mjs <voxel> <runs>)"

if [ "${NATIVE:-0}" = "1" ]; then
  # The native baseline: the upstream core TU only (picovoxel's TUs are wasm-specific).
  N="$OUT/native-linux"; V="$ROOT/vendor"; mkdir -p "$N"
  FL=(-O3 -fPIC -ffp-contract=off)
  cmake -G Ninja -B "$N/tbb" -S "$V/oneTBB" -DCMAKE_BUILD_TYPE=Release -DTBB_STRICT=OFF -DTBB_TEST=OFF \
    -DTBB_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX="$N/prefix"
  cmake --build "$N/tbb" --target install
  cmake -G Ninja -B "$N/ovdb" -S "$V/PicoGKRuntime/openvdb" -DCMAKE_BUILD_TYPE=Release \
    -DOPENVDB_USE_DELAYED_LOADING=OFF -DUSE_BLOSC=OFF -DUSE_ZLIB=OFF -DUSE_EXR=OFF \
    -DOPENVDB_BUILD_BINARIES=OFF -DOPENVDB_BUILD_UNITTESTS=OFF -DOPENVDB_BUILD_PYTHON_MODULE=OFF \
    -DOPENVDB_BUILD_NANOVDB=OFF -DOPENVDB_CORE_SHARED=OFF -DOPENVDB_CORE_STATIC=ON \
    -DUSE_EXPLICIT_INSTANTIATION=OFF -DTBB_ROOT="$N/prefix" -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DCMAKE_CXX_FLAGS="${FL[*]}" -DCMAKE_INSTALL_PREFIX="$N/prefix"
  cmake --build "$N/ovdb"
  cmake --install "$N/ovdb"
  bash "$ROOT/scripts/make-core-tu.sh" "$V/PicoGKRuntime/Source/PicoGKLibrary.cpp" "$N/core.cpp"
  g++ -std=c++20 "${FL[@]}" -include cstdint -DPICOGK_BUILD_LIBRARY -DOPENVDB_STATICLIB -I"$ROOT/shim" \
    -I"$V/PicoGKRuntime/API" -I"$V/PicoGKRuntime/Source" -I"$N/prefix/include" -c "$N/core.cpp" -o "$N/core.o"
  g++ -shared "${FL[@]}" "$N/core.o" "$N/prefix/lib/libopenvdb.a" "$N/prefix/lib/libtbb.a" -lpthread -ldl \
    -Wl,--no-undefined -o "$N/picogk.26.2.so"
  mkdir -p "$OUT/native-host"; cp "$HERE/native-host/gyroid-native.csproj" "$OUT/native-host/"
  (cd "$OUT/native-host" && dotnet build -c Release)
  echo "native: $OUT/native-host/bin/Release/net10.0/linux-x64/gyroid-native <voxel> <runs>"
fi
