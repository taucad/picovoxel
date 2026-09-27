#!/usr/bin/env bash
# R4 — pinned, checksummed source fetch into vendor/ (gitignored).
#
# Every input to the wasm build is pinned: PicoGKRuntime at the SHA all measurements
# certify (OQ1 default), the OpenVDB commit its submodule references, oneTBB at
# v2022.2.0, emsdk at 5.0.1. Tarballs are sha256-verified; GitHub regenerates commit
# tarballs on the fly, so if their compression ever changes the mismatch fails loudly
# and the pin gets re-verified by hand — that is the intended failure mode.
#
# emsdk is different: the emsdk repo is a thin manager and the toolchain binaries it
# installs are verified by emsdk's own hash manifest. The manager itself is pinned to
# the commit of its $EMSDK_VERSION release tag, and acorn (which emcc's JS optimizer
# imports but emsdk does not install) to the version emscripten's own lockfile names.
# An existing toolchain — vendor/emsdk from a previous run or cache, or one named by
# EMSDK — is reused only when its version matches; anything else fails loudly.
#
# Idempotent: existing tarballs are re-verified, not re-downloaded; extraction is
# stamped. A second run with a warm vendor/ does no network IO.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$HERE/vendor"
DL="$VENDOR/downloads"
mkdir -p "$DL"

PICOGK_RUNTIME_SHA="0f26321c18ed878a7820ef769c38fd5d49d39242"
PICOGK_RUNTIME_SHA256="3ba621cd555751e073490cdace3319698888a79867a15773c9ee7b12225a7096"
OPENVDB_SHA="7c03e1f084873cd1b3422c7ff7aec6ee681b3b38"   # PicoGKRuntime's submodule pin (13.0.0 line)
OPENVDB_SHA256="b3bbac7dd950d8d64f0fd0448dcc9efcd4e0e257c4a081fb606a00e1d75760d6"
ONETBB_SHA="06ce6212da6710f4bb2d20a1904b018aa44069bf"    # v2022.2.0
ONETBB_SHA256="f588cbd1635ebe2dbc1ac4a82e7bcf9aa90be40c98259b237bb7ae288fac269e"
XXHASH_TAG="v0.8.3"                                      # single header, BSD-2 (NOTICE)
XXHASH_SHA256="17973c0dc49d9854ca26caa191f0e12f7a424b68858d9a78de3860d959d85e4b"
EMSDK_VERSION="5.0.1"
EMSDK_MANAGER_SHA="14c18b569f55138fe4963924162244251f454fb0" # emscripten-core/emsdk tag 5.0.1
ACORN_VERSION="8.15.0"                                     # emscripten 5.0.1 package-lock.json

# fetch <name> <repo> <commit> <sha256> — download once, verify always.
fetch() {
  local name="$1" repo="$2" commit="$3" want="$4"
  local tarball="$DL/$name-${commit:0:8}.tar.gz"
  if [ ! -f "$tarball" ]; then
    echo "fetch-deps: downloading $name @ ${commit:0:8}"
    curl -sfL -o "$tarball.tmp" "https://codeload.github.com/$repo/tar.gz/$commit"
    mv "$tarball.tmp" "$tarball"
  fi
  local got
  got="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "fetch-deps: FAIL sha256 mismatch for $name" >&2
    echo "  want $want" >&2
    echo "  got  $got" >&2
    exit 1
  fi
  echo "fetch-deps: $name ${commit:0:8} verified"
}

# extract <tarball> <dest> [patchdir] — strip the GitHub top-level dir; stamped
# for idempotence. Patches (SK-0.7) are part of the stamp, not a separate step:
# editing one changes the stamp, which forces a clean re-extract, so a patched
# tree can never be double-patched or left stale. Vendored trees stay pristine
# apart from what patches/ says (see patches/*/*.patch for the why + upstream
# status); a flag-level override is always preferred to a patch.
extract() {
  local tarball="$1" dest="$2" patchdir="${3:-}"
  local stamp="$dest/.fetch-deps-stamp"
  local want
  want="$(basename "$tarball")"
  if [ -n "$patchdir" ]; then
    # Hash filenames alongside content, in glob (= application) order, so a
    # rename or reorder re-extracts even when the concatenated bytes match.
    want="$want $(for p in "$patchdir"/*.patch; do basename "$p"; cat "$p"; done | shasum -a 256 | cut -d' ' -f1)"
  fi
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    return 0
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tarball" -C "$dest" --strip-components=1
  echo "fetch-deps: extracted $(basename "$tarball") -> ${dest#"$HERE"/}"
  if [ -n "$patchdir" ]; then
    for p in "$patchdir"/*.patch; do
      patch -p1 --fuzz=0 -d "$dest" < "$p"  # fuzz 0: approximate context matches are conflicts, not applications
      echo "fetch-deps: applied ${p#"$HERE"/}"
    done
  fi
  echo "$want" > "$stamp"
}

fetch PicoGKRuntime leap71/PicoGKRuntime "$PICOGK_RUNTIME_SHA" "$PICOGK_RUNTIME_SHA256"
fetch openvdb AcademySoftwareFoundation/openvdb "$OPENVDB_SHA" "$OPENVDB_SHA256"
fetch oneTBB uxlfoundation/oneTBB "$ONETBB_SHA" "$ONETBB_SHA256"

extract "$DL/PicoGKRuntime-${PICOGK_RUNTIME_SHA:0:8}.tar.gz" "$VENDOR/PicoGKRuntime" "$HERE/patches/PicoGKRuntime"
# The openvdb submodule ships empty in the runtime tarball; fill it at its mount point.
extract "$DL/openvdb-${OPENVDB_SHA:0:8}.tar.gz" "$VENDOR/PicoGKRuntime/openvdb" "$HERE/patches/openvdb"
extract "$DL/oneTBB-${ONETBB_SHA:0:8}.tar.gz" "$VENDOR/oneTBB" "$HERE/patches/oneTBB"

# xxhash: one header, fetched raw — the XXH3-128 the G0 canonical grid hash uses.
# Same verify-always rule as the tarballs.
if [ ! -f "$DL/xxhash-$XXHASH_TAG.h" ]; then
  echo "fetch-deps: downloading xxhash.h @ $XXHASH_TAG"
  curl -sfL -o "$DL/xxhash-$XXHASH_TAG.h.tmp" \
    "https://raw.githubusercontent.com/Cyan4973/xxHash/$XXHASH_TAG/xxhash.h"
  mv "$DL/xxhash-$XXHASH_TAG.h.tmp" "$DL/xxhash-$XXHASH_TAG.h"
fi
XXHASH_GOT="$(shasum -a 256 "$DL/xxhash-$XXHASH_TAG.h" | cut -d' ' -f1)"
if [ "$XXHASH_GOT" != "$XXHASH_SHA256" ]; then
  echo "fetch-deps: FAIL sha256 mismatch for xxhash.h (want $XXHASH_SHA256 got $XXHASH_GOT)" >&2
  exit 1
fi
mkdir -p "$VENDOR/xxhash"
cp "$DL/xxhash-$XXHASH_TAG.h" "$VENDOR/xxhash/xxhash.h"
echo "fetch-deps: xxhash $XXHASH_TAG verified"

# emsdk: reuse a toolchain only at the pinned version, else install into vendor/.
# The stamp records every pin the install depends on, so a pin bump reinstalls.
EMSDK_STAMP_WANT="$EMSDK_MANAGER_SHA $EMSDK_VERSION acorn@$ACORN_VERSION"
emsdk_version() { tr -d '"[:space:]' < "$1/upstream/emscripten/emscripten-version.txt" 2>/dev/null || true; }
if [ -n "${EMSDK:-}" ]; then
  [ -x "$EMSDK/emsdk" ] || { echo "fetch-deps: FAIL EMSDK=$EMSDK is not an emsdk checkout" >&2; exit 1; }
  [ "$(emsdk_version "$EMSDK")" = "$EMSDK_VERSION" ] || {
    echo "fetch-deps: FAIL EMSDK=$EMSDK has emscripten $(emsdk_version "$EMSDK"), expected $EMSDK_VERSION" >&2
    exit 1
  }
  EMSDK_DIR="$EMSDK"
  echo "fetch-deps: using existing EMSDK at $EMSDK ($EMSDK_VERSION)"
elif [ -f "$VENDOR/emsdk/.fetch-deps-stamp" ] && [ "$(cat "$VENDOR/emsdk/.fetch-deps-stamp")" = "$EMSDK_STAMP_WANT" ] \
  && [ "$(emsdk_version "$VENDOR/emsdk")" = "$EMSDK_VERSION" ]; then
  EMSDK_DIR="$VENDOR/emsdk"
  echo "fetch-deps: vendor emsdk $EMSDK_VERSION already installed"
else
  echo "fetch-deps: installing emsdk $EMSDK_VERSION into vendor/ (binaries verified by emsdk's manifest)"
  rm -rf "$VENDOR/emsdk"
  git init --quiet "$VENDOR/emsdk"
  git -C "$VENDOR/emsdk" fetch --quiet --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_MANAGER_SHA"
  git -C "$VENDOR/emsdk" checkout --quiet --detach FETCH_HEAD
  "$VENDOR/emsdk/emsdk" install "$EMSDK_VERSION"
  "$VENDOR/emsdk/emsdk" activate "$EMSDK_VERSION"
  EMSDK_DIR="$VENDOR/emsdk"
fi

# emcc's acorn-optimizer runs at every -O level, so a missing acorn fails the link
# after the wasm is emitted. Install the pinned version, never whatever is latest.
ACORN_DIR="$EMSDK_DIR/upstream/emscripten/node_modules/acorn"
if [ "$(node -p "require('$ACORN_DIR/package.json').version" 2>/dev/null || true)" != "$ACORN_VERSION" ]; then
  (cd "$EMSDK_DIR/upstream/emscripten" && npm install "acorn@$ACORN_VERSION" --no-save --no-audit --no-fund)
fi
[ "$EMSDK_DIR" = "$VENDOR/emsdk" ] && echo "$EMSDK_STAMP_WANT" > "$VENDOR/emsdk/.fetch-deps-stamp"

echo "fetch-deps: vendor/ ready"
