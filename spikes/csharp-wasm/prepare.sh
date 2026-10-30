#!/usr/bin/env bash
# Headless split of the unmodified PicoGK C# library: drop Viewer/ and the Viewer
# partial in Interop.cs (the runtime's Viewer_* exports are not in the wasm core).
set -euo pipefail
SRC="$1"; DST="$2"
rm -rf "$DST"; mkdir -p "$DST"
(cd "$SRC" && find . -name '*.cs' -not -path './Viewer/*' -not -path './obj/*' -not -path './bin/*') | while read -r f; do
  mkdir -p "$DST/$(dirname "$f")"; cp "$SRC/$f" "$DST/$f"; done
# Interop.cs: cut from "public partial class Viewer" to the line before "public partial class OpenVdbFile".
awk '/^    public partial class Viewer : IDisposable/{skip=1} /^    public partial class OpenVdbFile/{skip=0} !skip' \
  "$SRC/Internals/Interop.cs" > "$DST/Internals/Interop.cs"
python3 "$(dirname "$0")/patch-callbacks.py" "$DST"
