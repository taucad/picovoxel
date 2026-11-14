#!/usr/bin/env bash
# Assemble the picovoxel.xyz site (site/) from the built demo: the three.js
# demo at /demo/ with its model routes, the brand assets, and the Cloudflare
# Pages _headers and _redirects. Run after `pnpm run build:demo`; the
# `pages` job in ci.yml uploads site/ (tau-cloud stacks/sites).
#
# Usage: .github/scripts/assemble-site.sh [out-dir]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$REPO_ROOT/site}"

[[ -f "$REPO_ROOT/demo/dist/main.js" ]] || { printf 'demo/dist/main.js is missing: run pnpm run build:demo first\n' >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/demo" "$OUT/assets"
cp "$REPO_ROOT/demo/index.html" "$OUT/demo/index.html"
cp -R "$REPO_ROOT/demo/dist" "$OUT/demo/dist"
cp "$REPO_ROOT/assets/logo.svg" "$OUT/assets/logo.svg"

# The multi-threaded build needs crossOriginIsolated, as demo/serve.mjs serves it.
cat > "$OUT/_headers" <<'HEADERS'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
HEADERS

# The site is the demo; a model route (/demo/<model>) renders the same page,
# which reads the model from its path (demo/main.ts).
cat > "$OUT/_redirects" <<'REDIRECTS'
/ /demo/ 302
/demo/:model /demo/ 200
REDIRECTS

printf 'assembled %s\n' "$OUT"
