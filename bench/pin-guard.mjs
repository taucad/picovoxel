// LANES item 3 (D8, ratified 2026-09-27) — the pin-poisoning guard lives where
// pins are written, not at the user-facing export boundary. Every UPDATE_PINS
// arm in the suite and the exact-reference path of bench/g0-identity.mjs call
// this on the source they record, before the compare-or-write branch: a pin is
// an L0 fact, and a source with 'fast' (Class-2) provenance would silently move
// the oracle. Pass the source handle's value provenance (`voxels.lane`,
// `mesh.lane`) — never the session lane; for a fixture loaded from .vdb or STL
// that provenance comes from the persisted tag. test/lanes.test.ts runs
// unguardedPinArms over every source under test/, bench/ and scripts/: an
// UPDATE_PINS/UPDATE_SNAPSHOTS arm without this call fails the suite.

/**
 * Throws unless `lane` is `'exact'`.
 * @param {string | undefined} lane the source's value provenance
 * @param {string} label the pin being recorded, for the message
 */
export function assertPinSource(lane, label) {
  if (lane !== 'exact') {
    throw new Error(
      `${label}: refusing to pin a source with '${lane}' provenance — pins record L0 (exact-provenance) values ` +
        'only. Rebuild the fixture without Class-2 ops (no fastRenorm, not in a lane: \'fast\' session).',
    );
  }
}

// A pin-writing arm: an `if` whose condition names updatePins/updateSnapshots
// or reads the UPDATE_PINS/UPDATE_SNAPSHOTS env flag itself. Matched on the RAW
// source, so an arm that sits in a comment still counts (fail-closed).
const PIN_ARM = /\bif\s*\([^)]*(?:\bupdate(?:Pins|Snapshots)\b|UPDATE_(?:PINS|SNAPSHOTS))/g;
const GUARD_CALL = /\bassertPinSource\s*\(/g;
// Comments are blanked (length-preserving) before looking for guard calls, so
// a guard mentioned in a comment never satisfies an arm.
// ponytail: `//` inside a string literal blanks the rest of that line — that
// can only hide a guard (fail-closed), never invent one.
const blankComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));

/**
 * The static half of the guard: returns the 1-based line of every pin arm that
 * is not preceded by an assertPinSource call since the previous arm (or the
 * start of the file), plus `0` when the file names the flag in code but has no
 * recognisable arm (a writer keyed some other way). [] = fully guarded.
 * @param {string} source
 * @returns {number[]}
 */
export function unguardedPinArms(source) {
  const code = blankComments(source);
  const guards = [...code.matchAll(GUARD_CALL)].map((match) => match.index);
  const arms = [...source.matchAll(PIN_ARM)].map((match) => match.index);
  const lineOf = (at) => source.slice(0, at).split('\n').length;
  const failures = [];
  let previous = -1;
  for (const arm of arms) {
    if (!guards.some((guard) => guard > previous && guard < arm)) failures.push(lineOf(arm));
    previous = arm;
  }
  if (arms.length === 0 && /UPDATE_(?:PINS|SNAPSHOTS)/.test(code)) failures.push(0);
  return failures;
}
