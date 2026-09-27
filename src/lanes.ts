// Lane provenance, the pure half (the lane contract is described in docs/lanes.md).
//
// A handle's value-class provenance is a SET of members. The persisted grammar
// — used by the `PicoVoxel.Lane` grid tag, the STL header token and the CLI
// header comment alike — is canonical comma-separated members, sorted,
// deduplicated, no spaces: `fast`, or `fast,gpu-l1` for a set with a GPU
// member. Members match `[a-z0-9][a-z0-9-]*`. The TypeScript surface
// keeps the two-value enum: a set collapses to it by least upper bound, where
// the empty set (or only `exact`, the bottom element) is `'exact'` and any
// other member — known or not — is `'fast'`. Unknown members are therefore
// treated fast-like (the conservative direction) and are preserved, never
// rewritten to `fast`; tokens outside the grammar read as the reserved
// member `unknown` instead of being dropped.
//
// No native touchpoints: the slicing subpath imports this module.

import type { PicoLane, ResolvedLane } from './context.ts';
import { PicoError } from './errors.ts';

/** A handle's value-class provenance: canonical members, `[]` = exact. */
export type LaneSet = readonly string[];

export const EXACT_LANE_SET: LaneSet = Object.freeze([]);
export const FAST_LANE_SET: LaneSet = Object.freeze(['fast']);
/** The reserved member standing in for provenance this build cannot read. */
export const UNKNOWN_LANE_MEMBER = 'unknown';

const LANE_MEMBER = /^[a-z0-9][a-z0-9-]*$/;

/** Canonical form: deduplicated, sorted, `exact` (the bottom element) dropped. */
function canonicalLaneSet(members: Iterable<string>): LaneSet {
  return [...new Set(members)].filter((member) => member !== 'exact').sort();
}

/** Parses a persisted set value; malformed tokens become `unknown`, never dropped. */
export function parseLaneSet(value: string): LaneSet {
  return canonicalLaneSet(
    value.split(',').map((member) => (LANE_MEMBER.test(member) ? member : UNKNOWN_LANE_MEMBER)),
  );
}

/** Least upper bound over provenance sets (set union). */
export function unionLaneSets(...sets: LaneSet[]): LaneSet {
  return canonicalLaneSet(sets.flat());
}

/** The TS surface collapse: empty = `'exact'`; any member, known or not, = `'fast'`. */
export function laneOf(set: LaneSet): PicoLane {
  return set.length === 0 ? 'exact' : 'fast';
}

/**
 * A session's `lane: 'fast'` (or resolved `'auto'`) consent covers exactly the
 * `fast` member: the deterministic, value-changing accelerations. Any other
 * member (`gpu-l1`, a relaxed-math member, `unknown`) is outside it, because
 * no export policy is defined for those yet; so for consent an unknown member
 * is NOT fast-like (that would be the permissive direction).
 */
function withinFastConsent(set: LaneSet): boolean {
  return set.every((member) => member === 'fast');
}

/**
 * The export boundary for stampable formats (STL, `.vdb`), keyed by the
 * session's claim: exact provenance always exports; `fast` provenance
 * exports freely in a session that declared `lane: 'fast'`; everything else
 * needs this export's `acceptLane: 'fast'`. The message names only remedies
 * that actually apply.
 */
export function assertLaneExport(
  where: string,
  subject: string,
  set: LaneSet,
  sessionLane: ResolvedLane,
  acceptLane: 'fast' | undefined,
): void {
  if (set.length === 0 || acceptLane === 'fast') return;
  const fastOnly = withinFastConsent(set);
  if (fastOnly && sessionLane === 'fast') return;
  const why = fastOnly
    ? 'this session declared no lane, so nothing consented to exporting them'
    : `members other than 'fast' are outside what a lane: 'fast' session consents to (no export policy ` +
      'covers them), so this export must be acknowledged on its own';
  throw new PicoError(
    'PICO_LANE_EXPORT',
    `${where}() on ${subject} with non-exact provenance (${set.join(',')}): its bytes will not match an exact ` +
      `build of the same model, and ${why}. Either acknowledge this export with ${where}({ acceptLane: 'fast' })` +
      (fastOnly ? ", or declare the lane once with createPico({ lane: 'fast' })" : '') +
      ` — the lane set is recorded in the artifact either way. For bytes that match the exact reference, rebuild ` +
      "it in a lane: 'exact' session (a replay, not a conversion).",
  );
}

/** The provenance token the STL header and the CLI header comment carry. */
export function formatLaneToken(set: LaneSet): string {
  return `LANE=${set.join(',')}`;
}

/**
 * Finds the provenance token in header text: whitespace- or
 * NUL-delimited, anchored at a token start and case-exact, so `PLANE=FASTENED`
 * or `lane=fast` never match. The first `LANE=` token wins; none = exact.
 */
export function findLaneToken(text: string): LaneSet {
  // oxlint-disable-next-line eslint/no-control-regex -- NUL is a real delimiter: STL headers pad with NUL bytes
  const token = text.split(/[\s\0]+/).find((candidate) => candidate.startsWith('LANE='));
  return token === undefined ? EXACT_LANE_SET : parseLaneSet(token.slice('LANE='.length));
}
