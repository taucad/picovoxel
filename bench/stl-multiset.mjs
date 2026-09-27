// The order-invariant multiset hash of a binary STL stream: it tells "permuted
// bytes, same mesh" apart from "different mesh". bench/g0-identity.mjs and
// bench/stl-identity.mjs consume it; test/stl-multiset.test.mjs covers it.
//
// Construction
// ------------
// A binary STL is an 80-byte header + uint32 count + N 50-byte records. Each
// record is 12 little-endian f32 (facet normal, then three vertices) followed by
// a 2-byte attribute word this writer always sets to 0 (src/stl.ts).
//
// The payload is the **36-byte vertex triple only**. The normal is dropped: it
// is recomputed by the writer from the three vertices
// (normalize(cross(v2-v1, v3-v1)) in float64, rounded to f32), so it carries no
// independent geometry — only a rounding-coupling site. Vertex *rotation*
// within a facet still moves the hash, because the three vertices are hashed in
// order.
//
// The 9 floats are canonicalized before hashing: -0.0 -> +0.0 and every NaN
// bit pattern -> 0x7fc00000. Two builds that differ only in a signed zero or in
// which NaN payload they happened to produce are the same mesh; a hash that
// separates them reports noise. Canonicalization can never hide a NaN, because
// `nonFiniteRecords` below counts them independently of the hash.
//
// Per-record: d_i = SHA-256(canonical payload_i), read as a 256-bit big-endian
// integer. Combined: H = (sum_i d_i) mod 2^256, in 8 uint32 limbs with carry.
// SHA-256 rather than a 128-bit xxh3/BLAKE3: node stdlib, no dependency,
// and strictly stronger. It costs ~4 min over a 10 M-record / 502 MB stream
// against ~40 s of meshing, which is worth it for an oracle run offline.
// ponytail: SHA-256 per record; swap in xxh3-128 if this ever runs per commit.
// The record count is carried as the sibling field `triangles` and compared
// alongside rather than folded in — equivalent discriminating power.
//
// Why not XOR, and why not a sum of weak hashes:
//   * XOR is multiplicity-blind — any record appearing an even number of times
//     cancels, so "one facet duplicated, another dropped" can vanish. Modular
//     addition preserves multiplicity, which makes this a true *multiset* hash.
//   * A commutative combination of 32/64-bit hashes (FNV, CRC) collides by
//     birthday at ~2^16/2^32 records; a 10 M-triangle mesh is already past that
//     for 32-bit. With SHA-256 digests the summands are computationally
//     indistinguishable from uniform 256-bit values, so two distinct multisets
//     landing on the same sum is a ~2^-256 event for non-adversarial inputs
//     (allocator order, races, uninitialised reads), and constructing one
//     deliberately is a 256-bit generalized-birthday/subset-sum problem. No
//     input here is adversarial; the bar is "cannot happen by accident", and
//     2^-256 clears it by ~70 orders of magnitude over the number of records.

import { createHash, hash as hashOne } from 'node:crypto';

/** Bytes per binary STL facet record. */
export const RECORD = 50;
const NORMAL = 12; // bytes of recomputed facet normal, excluded from the hash
const PAYLOAD = 36; // 9 f32 — the three vertices, canonicalized
const ATTR = 48; // offset of the 2-byte attribute word

/** -0.0 -> +0.0, any NaN -> 0x7fc00000, everything else raw f32 bits. */
export function canonicalizeF32Bits(bits) {
  if ((bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0) return 0x7fc00000;
  return bits === 0x80000000 ? 0 : bits;
}

/** Order-invariant multiset hash + the cheap scalar identities, over STL bytes. */
export function stlIdentity(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const limbs = new Uint32Array(8);
  let attrNonZero = 0;
  // Hard health counter: a non-finite coordinate is never legitimate output.
  // src/stl.ts writes NaN when a triangle index points past the vertex array
  // (JS `undefined` through Math.fround), so this counter is the cheapest
  // detector of out-of-range indices in the extracted mesh.
  let nonFiniteRecords = 0;
  let firstNonFinite = -1;
  let lastNonFinite = -1;
  // One reusable canonical payload buffer — 10 M allocations is the difference
  // between a 20 s pass and a minute of GC.
  const payload = Buffer.allocUnsafe(PAYLOAD);
  for (let t = 0; t < triangles; t++) {
    const at = 84 + t * RECORD;
    for (let f = 0; f < 12; f++) {
      if (!Number.isFinite(view.getFloat32(at + f * 4, true))) {
        nonFiniteRecords++;
        if (firstNonFinite < 0) firstNonFinite = t;
        lastNonFinite = t;
        break;
      }
    }
    for (let f = 0; f < 9; f++) {
      payload.writeUInt32LE(canonicalizeF32Bits(view.getUint32(at + NORMAL + f * 4, true)), f * 4);
    }
    const digest = hashOne('sha256', payload, 'buffer');
    // 256-bit add, most-significant limb first so the carry walks downward.
    let carry = 0;
    for (let limb = 7; limb >= 0; limb--) {
      const sum = limbs[limb] + digest.readUInt32BE(limb * 4) + carry;
      limbs[limb] = sum >>> 0;
      carry = sum > 0xffffffff ? 1 : 0;
    }
    if (view.getUint16(at + ATTR, true) !== 0) attrNonZero++;
  }
  // FNV-1a over the whole stream: weak, but it is the identifier every prior
  // earlier benchmark record quotes (`0ccaa277`/`38cad381`), so it is carried for
  // cross-referencing only — sha256 is the byte oracle.
  let fnv = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    fnv = Math.imul(fnv ^ bytes[i], 0x01000193) >>> 0;
  }
  return {
    stlBytes: bytes.length,
    triangles,
    stlFnv: fnv.toString(16),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    headerSha256: createHash('sha256').update(bytes.subarray(0, 84)).digest('hex'),
    multiset: [...limbs].map((n) => n.toString(16).padStart(8, '0')).join(''),
    attrNonZero,
    nonFiniteRecords,
    firstNonFinite,
    lastNonFinite,
  };
}
