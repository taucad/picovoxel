// Lane provenance, the pure half (§14.1; LANES D-pre.1 as ratified 2026-09-27).
//
// A handle's value-class provenance is a SET of members (LANES item 4). The
// persisted grammar — used by the `PicoVoxel.Lane` grid tag, the STL header
// token and the CLI header comment alike — is canonical comma-separated
// members, sorted, deduplicated, no spaces: `fast` today, `fast,gpu-l1` once
// GPU lanes land. Members match `[a-z0-9][a-z0-9-]*`. The TypeScript surface
// keeps the two-value enum: a set collapses to it by least upper bound, where
// the empty set (or only `exact`, the bottom element) is `'exact'` and any
// other member — known or not — is `'fast'`. Unknown members are therefore
// treated fast-like (the conservative direction) and are preserved, never
// rewritten to `fast`; tokens outside the grammar read as the reserved
// member `unknown` instead of being dropped.
//
// No native touchpoints: the slicing subpath imports this module.

import type { PicoLane } from './context.ts';

/** A handle's value-class provenance: canonical members, `[]` = exact. */
export type LaneSet = readonly string[];

export const EXACT_LANE_SET: LaneSet = Object.freeze([]);
export const FAST_LANE_SET: LaneSet = Object.freeze(['fast']);
/** The reserved member standing in for provenance this build cannot read. */
export const UNKNOWN_LANE_MEMBER = 'unknown';

const LANE_MEMBER = /^[a-z0-9][a-z0-9-]*$/;

/** Canonical form: deduplicated, sorted, `exact` (the bottom element) dropped. */
export function canonicalLaneSet(members: Iterable<string>): LaneSet {
  return [...new Set(members)].filter((member) => member !== 'exact').sort();
}

/** Parses a persisted set value; malformed tokens become `unknown`, never dropped. */
export function parseLaneSet(value: string): LaneSet {
  return canonicalLaneSet(value.split(',').map((member) => (LANE_MEMBER.test(member) ? member : UNKNOWN_LANE_MEMBER)));
}

/** Least upper bound over provenance sets (set union). */
export function unionLaneSets(...sets: LaneSet[]): LaneSet {
  return canonicalLaneSet(sets.flat());
}

/** The TS surface collapse: empty = `'exact'`; any member, known or not, = `'fast'`. */
export function laneOf(set: LaneSet): PicoLane {
  return set.length === 0 ? 'exact' : 'fast';
}

/** The provenance token the STL header and the CLI header comment carry. */
export function formatLaneToken(set: LaneSet): string {
  return `LANE=${set.join(',')}`;
}

/**
 * LANES defect 2 — finds the provenance token in header text: whitespace- or
 * NUL-delimited, anchored at a token start and case-exact, so `PLANE=FASTENED`
 * or `lane=fast` never match. The first `LANE=` token wins; none = exact.
 */
export function findLaneToken(text: string): LaneSet {
  const token = text.split(/[\s\0]+/).find((candidate) => candidate.startsWith('LANE='));
  return token === undefined ? EXACT_LANE_SET : parseLaneSet(token.slice('LANE='.length));
}
