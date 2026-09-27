#!/usr/bin/env bash
# Native PicoGK HelixHeatX sweep — this machine's answer to the published
# voxel-size/time table (LEAP71_HelixHeatX/Documentation/table.png).
#
# Protocol
#   * 1.0 → 0.5 mm in 0.1 mm steps, 5 runs each, ROUND-ROBIN (pass 1 does every
#     size, then pass 2, …). Round-robin rather than 5-in-a-row per size so
#     thermal drift and any ambient load spread evenly across sizes instead of
#     biasing whichever size ran last.
#   * One process per run (PicoGK permits one global library per process, and a
#     fresh process gives every run identical cold-start state).
#   * Before every run: wait until host CPU busy < 5% (the bench discipline in
#     BENCHMARKS.md — measurements taken under load are not comparable).
#   * Between runs: the scratch dir is wiped (each run writes an STL up to
#     ~502 MB plus ten ~37 MB screenshots).
#
# Usage: bash run-sweep.sh [passes]        (default 5)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASSES="${1:-5}"
SIZES=(1.0 0.9 0.8 0.7 0.6 0.5)
# Ideal gate is 5% (BENCHMARKS.md discipline). This machine's achievable floor
# during this campaign was 12-22% busy (user's own VM + desktop apps, which are
# not ours to close), so the gate is set to the floor and the ambient load is
# RECORDED WITH EVERY RUN instead of being asserted away. Calibration for the
# reader: the same 1.0 mm cell measured 19.55 s quiet vs 20.07 s at 32.7% busy,
# i.e. ~2.6% penalty at double this load.
IDLE_LIMIT="${IDLE_LIMIT:-25.0}"   # percent CPU busy allowed before a run may start
IDLE_TIMEOUT=300        # seconds to wait for the machine to go quiet
COOLDOWN=10             # seconds between runs

# ARM selects which picogk dylib is under test. Unset = whatever is already in
# the build output (the published binary shipped in PicoGK/native/osx-arm64).
# Otherwise point PICOGK_DYLIB at a build and give it a LABEL; the dylib is
# copied into the app directory, where PicoGK's DllImport("picogk.26.2")
# resolves it. Every record independently records the library's own build
# stamp, so the arm is provable from the data, not just the filename.
LABEL="${LABEL:-published}"
PICOGK_DYLIB="${PICOGK_DYLIB:-}"
APP_DIR="$HERE/bin/Release/net9.0"

# ALLOC_DYLIB inserts an allocator (mimalloc / tbbmalloc_proxy legs) via
# DYLD_INSERT_LIBRARIES. macOS strips DYLD_* whenever a SIP-protected platform
# binary is exec'd (/bin/bash, /usr/bin/env — and the brew `dotnet` command IS
# a bash wrapper script), so the run must exec the real Mach-O host directly
# with the vars set at that exec. Every record captures the inserted value the
# process itself saw (dyldInsert), not just what this runner intended.
ALLOC_DYLIB="${ALLOC_DYLIB:-}"
ALLOC_LABEL="${ALLOC_LABEL:-system}"
DOTNET_ROOT="$(brew --prefix dotnet@9)/libexec"
DOTNET_HOST="$DOTNET_ROOT/dotnet"
[ -x "$DOTNET_HOST" ] || { echo "FATAL: real dotnet host not found at $DOTNET_HOST (DYLD insertion needs it)"; exit 1; }
if [ -n "$ALLOC_DYLIB" ] && [ ! -f "$ALLOC_DYLIB" ]; then
  echo "FATAL: ALLOC_DYLIB=$ALLOC_DYLIB does not exist"; exit 1
fi

STAMP="$(date +%Y-%m-%d)"
OUT_DIR="$HERE/../results/native"
OUT="$OUT_DIR/native-heatx-$LABEL-$STAMP.jsonl"
WORK="${TMPDIR:-/tmp}/picogk-native-heatx-sweep"
LOG="$OUT_DIR/native-heatx-$LABEL-$STAMP.log"

mkdir -p "$OUT_DIR"

if [ -n "$PICOGK_DYLIB" ]; then
  # rm BEFORE cp, always. Overwriting a code-signed Mach-O in place leaves the
  # kernel's cached signature pointing at pages that no longer match, and every
  # subsequent run dies instantly with SIGKILL (Code Signature Invalid,
  # CODESIGNING/"Invalid Page") having produced nothing. Replacing the inode
  # avoids it. Cost me a whole silent sweep on 2026-08-10.
  rm -f "$APP_DIR/picogk.26.2.dylib"
  cp "$PICOGK_DYLIB" "$APP_DIR/picogk.26.2.dylib"
fi

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# Host CPU busy % from top's SECOND sample (the first is cumulative since boot
# and would read as near-idle no matter what the machine is doing right now).
cpu_busy() {
  local idle
  idle="$(top -l 2 -n 0 -s 1 2>/dev/null | grep 'CPU usage' | tail -1 |
          sed -E 's/.*, ([0-9.]+)% idle.*/\1/')"
  [ -z "$idle" ] && { echo "100.0"; return; }
  awk -v i="$idle" 'BEGIN { printf "%.1f", 100 - i }'
}

wait_for_idle() {
  local waited=0 busy
  while :; do
    busy="$(cpu_busy)"
    if awk -v b="$busy" -v l="$IDLE_LIMIT" 'BEGIN { exit !(b < l) }'; then
      echo "$busy"; return 0
    fi
    # say goes to stderr here: wait_for_idle runs inside $(…), and anything it
    # prints to stdout would be captured INTO the busy value (the 2026-08-09
    # u5 sweep recorded wait transcripts inside hostBusyPercentBefore this way
    # — the real reading is the last line of the field in those records).
    if [ "$waited" -ge "$IDLE_TIMEOUT" ]; then
      say "  WARN machine still busy (${busy}%) after ${IDLE_TIMEOUT}s — proceeding, run is flagged" >&2
      echo "$busy"; return 1
    fi
    say "  waiting for idle: ${busy}% busy (limit ${IDLE_LIMIT}%)" >&2
    sleep 15; waited=$((waited + 15))
  done
}

say "=== native HeatX sweep [$LABEL]: ${#SIZES[@]} sizes x $PASSES passes = $(( ${#SIZES[@]} * PASSES )) runs"
say "    dylib: ${PICOGK_DYLIB:-<as-built: published binary>}"
say "    alloc: $ALLOC_LABEL${ALLOC_DYLIB:+ ($ALLOC_DYLIB)}"
say "    out:  $OUT"
say "    host: $(sysctl -n machdep.cpu.brand_string) / $(sysctl -n hw.ncpu) cores / $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
say "    power: $(pmset -g 2>/dev/null | grep -i lowpowermode || echo 'lowpowermode unknown')"
say "    dotnet $(dotnet --version) · PicoGK $(cd "$HERE/../../../PicoGK" && git log --oneline -1) · runtime $(cd "$HERE/../../../PicoGKRuntime" && git describe --tags 2>/dev/null)"

for pass in $(seq 1 "$PASSES"); do
  for size in "${SIZES[@]}"; do
    rm -rf "$WORK"; mkdir -p "$WORK"
    busy="$(wait_for_idle)"; idle_ok=$?
    say "pass $pass/$PASSES  voxel ${size}mm  (host ${busy}% busy)"
    start=$(date +%s)
    HEATX_HOST_BUSY="$busy" HEATX_ALLOC="$ALLOC_LABEL" DOTNET_ROOT="$DOTNET_ROOT" \
      DYLD_INSERT_LIBRARIES="$ALLOC_DYLIB" "$DOTNET_HOST" "$HERE/bin/Release/net9.0/NativeHeatX.dll" \
      --voxel "$size" --run "$pass" --out "$OUT" --work "$WORK" >>"$LOG" 2>&1
    rc=$?
    elapsed=$(( $(date +%s) - start ))
    if [ $rc -ne 0 ]; then
      say "  FAILED rc=$rc after ${elapsed}s — see $LOG"
    else
      say "  ok in ${elapsed}s $( [ $idle_ok -ne 0 ] && echo '(NOT IDLE — suspect)' )"
    fi
    rm -rf "$WORK"
    sleep "$COOLDOWN"
  done
done

say "=== sweep complete: $(wc -l < "$OUT" | tr -d ' ') records in $OUT"
