#!/usr/bin/env bash
# R4 — headless split, without patching upstream.
#
# PicoGKLibrary.cpp is the only mixed translation unit: 140 core exports, then 33
# contiguous Viewer_* exports to EOF (verified: zero non-viewer exports after the
# boundary). Every other Source/*.cpp is PicoGKGL* and viewer-only, so "de-globbing"
# is just not listing them.
#
# The cut is located by PATTERN, not by line 1381, so upstream edits above the
# boundary don't silently truncate core exports.
set -euo pipefail

SRC="${1:?usage: make-core-tu.sh <PicoGKLibrary.cpp> <out.cpp>}"
OUT="${2:?usage: make-core-tu.sh <PicoGKLibrary.cpp> <out.cpp>}"

BOUNDARY=$(grep -n '^PICOGK_API.*[[:space:]]Viewer_' "$SRC" | head -1 | cut -d: -f1)
[ -n "$BOUNDARY" ] || { echo "make-core-tu: no Viewer_* export found — upstream layout changed" >&2; exit 1; }

# The core body never names glad/ImGui/Viewer; only these three includes do.
awk -v end="$((BOUNDARY - 1))" '
  NR > end { exit }
  /^#include "gl\/glad.h"/            { print "// [picogk-js] dropped: " $0; next }
  /^#include "PicoGKGLViewer.h"/      { print "// [picogk-js] dropped: " $0; next }
  /^#include "PicoGKGLViewerManager.h"/ { print "// [picogk-js] dropped: " $0; next }
  { print }
' "$SRC" > "$OUT"

CORE=$(grep -c '^PICOGK_API' "$OUT" || true)
VIEW=$(( $(grep -c '^PICOGK_API' "$SRC" || true) - CORE ))
echo "make-core-tu: cut at line $BOUNDARY — $CORE core exports kept, $VIEW Viewer_* dropped"

# Finding 4 predicted exactly 140/33. A drift here means re-reading the source, not
# adjusting the number.
[ "$CORE" -eq 140 ] || echo "make-core-tu: WARNING expected 140 core exports, got $CORE (upstream drift?)" >&2
grep -q "Viewer_" "$OUT" && { echo "make-core-tu: FAIL viewer code leaked into core TU" >&2; exit 1; }
exit 0
