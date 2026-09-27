#!/usr/bin/env bash
# C++ coverage report (close-out T3.1/D8): merges the .profraw files the vitest
# flush (test/cpp-coverage-setup.ts) wrote and exports lcov for the nine own TUs.
#   PROFILE_DIR  .profraw directory (the run's PICOVOXEL_CPP_COVERAGE_DIR)
#   WASM         the COVERAGE=1 pico.wasm the run loaded (default src/pico.wasm)
#   OUT_DIR      where merged.profdata, lcov.info and report.txt go
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK="${EMSDK:-$HERE/vendor/emsdk}"
PROFILE_DIR="${PROFILE_DIR:?set PROFILE_DIR to the PICOVOXEL_CPP_COVERAGE_DIR of the run}"
WASM="${WASM:-$HERE/src/pico.wasm}"
OUT_DIR="${OUT_DIR:-$HERE/coverage/cpp}"
BIN="$EMSDK/upstream/bin"
mkdir -p "$OUT_DIR"

shopt -s nullglob
profiles=("$PROFILE_DIR"/*.profraw)
[ "${#profiles[@]}" -gt 0 ] || { echo "coverage-cpp: no .profraw in $PROFILE_DIR" >&2; exit 1; }
"$BIN/llvm-profdata" merge -sparse "${profiles[@]}" -o "$OUT_DIR/merged.profdata"

# -ffile-prefix-map records the own TUs as relative src/pico-*.cpp, which llvm-cov's
# positional SOURCES filter (real paths) never matches; filter the other roots out
# instead: dep and vendored headers (build/, vendor/), the ImGui stand-in (shim/,
# outside D8's nine TUs) and absolute sysroot paths.
cd "$HERE"
filter=(-ignore-filename-regex='^(build/|vendor/|shim/|/)')
"$BIN/llvm-cov" export "$WASM" -instr-profile="$OUT_DIR/merged.profdata" -format=lcov "${filter[@]}" > "$OUT_DIR/lcov.info"
"$BIN/llvm-cov" report "$WASM" -instr-profile="$OUT_DIR/merged.profdata" "${filter[@]}" | tee "$OUT_DIR/report.txt"
want=(src/pico-*.cpp)
got="$(grep -c '^SF:src/pico-.*\.cpp$' "$OUT_DIR/lcov.info" || true)"
all="$(grep -c '^SF:' "$OUT_DIR/lcov.info" || true)"
echo "coverage-cpp: ${#profiles[@]} profiles; $got of ${#want[@]} own TUs ($all files) in $OUT_DIR/lcov.info"
[ "$got" = "${#want[@]}" ] && [ "$all" = "$got" ] || { echo "coverage-cpp: FAIL lcov must hold exactly the own TUs" >&2; exit 1; }
