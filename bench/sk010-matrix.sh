#!/usr/bin/env bash
# SK-0.10 re-verdict driver: swap a prebuilt allocator artifact into src/ and run
# the identity oracle N times per cell. Temporary spike instrument.
set -euo pipefail
# Sourced as well as executed, so resolve from BASH_SOURCE, not $0.
HERE="${HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="$HERE/bench/results/webgpu-v2/sk-0.10-oracle.jsonl"

run_cell() {           # run_cell <artifact-dir> <build> <size> <n> <label-prefix>
  local dir="$1" build="$2" size="$3" n="$4" tag="$5"
  if [ "$build" = multi ]; then
    cp "$HERE/build/sk09/$dir/pico-multi.wasm" "$HERE/build/sk09/$dir/pico-multi.mjs" "$HERE/src/"
  else
    cp "$HERE/build/sk09/$dir/pico.wasm" "$HERE/build/sk09/$dir/pico.mjs" "$HERE/src/"
  fi
  for i in $(seq 1 "$n"); do
    echo "=== $tag $size run $i/$n (load $(uptime | sed 's/.*averages: //'))"
    node "$HERE/bench/stl-identity.mjs" run --build "$build" --size "$size" \
      --label "$tag-$size-$i" --jsonl "$OUT" 2>/dev/null | tail -1
  done
}
