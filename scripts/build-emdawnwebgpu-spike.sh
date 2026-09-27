#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK="${EMSDK:-$ROOT/vendor/emsdk}"
SOURCE="$ROOT/spikes/webgpu/emdawn/hello-compute.cpp"
SHADER="$ROOT/spikes/webgpu/emdawn/hello-compute.wgsl"
BASELINE="$ROOT/spikes/webgpu/emdawn/baseline.cpp"
OUTPUT="$ROOT/spikes/webgpu/emdawn/dist"
# shellcheck disable=SC2054 # -sENVIRONMENT takes a comma list as one flag.
COMMON=(
  -std=c++20
  -O3
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker
  -sEXIT_RUNTIME=0
  --closure=1
)

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$OUTPUT"

em++ "${COMMON[@]}" "$BASELINE" -o "$OUTPUT/baseline.mjs"

em++ "${COMMON[@]}" \
  --use-port=emdawnwebgpu \
  --embed-file "$SHADER@/emdawn-hello-compute.wgsl" \
  "$SOURCE" \
  -o "$OUTPUT/callback.mjs"

em++ "${COMMON[@]}" \
  --use-port=emdawnwebgpu \
  --embed-file "$SHADER@/emdawn-hello-compute.wgsl" \
  -DPICOVOXEL_BLOCKING_WAIT=1 \
  -sASYNCIFY=1 \
  "$SOURCE" \
  -o "$OUTPUT/blocking.mjs"
