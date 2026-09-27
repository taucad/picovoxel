// LANES item 3 (D8, ratified 2026-09-27) — the pin-poisoning guard lives where
// pins are written, not at the user-facing export boundary. Every UPDATE_PINS
// arm in the suite and the exact-reference path of bench/g0-identity.mjs call
// this on the source they record, before the compare-or-write branch: a pin is
// an L0 fact, and a source with 'fast' (Class-2) provenance would silently move
// the oracle. Pass the source handle's value provenance (`voxels.lane`,
// `mesh.lane`) — never the session lane; for a fixture loaded from .vdb or STL
// that provenance comes from the persisted tag. test/lanes.test.ts holds the
// static backstop that fails when an UPDATE_PINS arm appears without this call.

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
