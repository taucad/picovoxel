#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_root="$repo_root/spikes/webgpu/node-compute"
target_root="$crate_root/target/release"
dist_root="$crate_root/dist"

cargo build --release --manifest-path "$crate_root/Cargo.toml"
mkdir -p "$dist_root"

case "$(uname -s)" in
  Darwin)
    library="$target_root/libpicovoxel_webgpu_node_spike.dylib"
    ;;
  Linux)
    library="$target_root/libpicovoxel_webgpu_node_spike.so"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    library="$target_root/picovoxel_webgpu_node_spike.dll"
    ;;
  *)
    echo "Unsupported native platform: $(uname -s)" >&2
    exit 1
    ;;
esac

cp "$library" "$dist_root/picovoxel-webgpu-node-spike.node"
