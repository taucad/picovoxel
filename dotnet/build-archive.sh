#!/usr/bin/env bash
# Build only the private .NET archive; never invoke the npm wasm builder.
set -euo pipefail
exec node "$(dirname "$0")/build-archive.mjs" "$@"
