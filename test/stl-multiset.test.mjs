// The STL multiset hash (bench/stl-multiset.mjs): the 256-bit carry, the
// multiplicity property and the canonicalizations are the non-trivial logic.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RECORD, canonicalizeF32Bits, stlIdentity } from '../bench/stl-multiset.mjs';

const GEOMETRY = 48;

/** One record per seed, every geometry byte set to the seed. */
const make = (records) => {
  const bytes = new Uint8Array(84 + records.length * RECORD);
  new DataView(bytes.buffer).setUint32(80, records.length, true);
  records.forEach((seed, t) => bytes.fill(seed, 84 + t * RECORD, 84 + t * RECORD + GEOMETRY));
  return bytes;
};

/** One record from twelve explicit f32 bit patterns (normal, then vertices). */
const makeBits = (...records) => {
  const bytes = new Uint8Array(84 + records.length * RECORD);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, records.length, true);
  records.forEach((bits, t) => bits.forEach((b, f) => view.setUint32(84 + t * RECORD + f * 4, b, true)));
  return bytes;
};
const twelve = (fill) => Array.from({ length: 12 }, (_, f) => fill(f));
const multiset = (records) => stlIdentity(make(records)).multiset;

test('the multiset ignores order, sees content and keeps multiplicity', () => {
  assert.equal(multiset([1, 2, 3]), multiset([3, 1, 2]), 'permutation must preserve the multiset');
  assert.notEqual(multiset([1, 2, 3]), multiset([1, 2, 4]), 'content change must move the multiset');
  // The XOR trap: {1,1,2} and {2,2,2} both XOR to hash(2), but must not sum alike.
  assert.notEqual(multiset([1, 1, 2]), multiset([2, 2, 2]), 'multiplicity must be preserved');
  assert.equal(multiset([1]).length, 64, 'multiset is 256 bits');
  assert.notEqual(
    stlIdentity(make([1, 2, 3])).sha256,
    stlIdentity(make([3, 1, 2])).sha256,
    'permuted streams are not byte-identical',
  );
});

test('the 256-bit sum carries across every limb and wraps modulo 2^256', () => {
  // Two records whose digests are unknown can still pin the arithmetic: the
  // sum of a record set equals the limb-wise sum of each record's own digest.
  const limbs = (hex) => Array.from({ length: 8 }, (_, i) => BigInt(`0x${hex.slice(i * 8, i * 8 + 8)}`));
  const value = (hex) => limbs(hex).reduce((acc, limb) => (acc << 32n) | limb, 0n);
  const a = value(multiset([7]));
  const b = value(multiset([9]));
  assert.equal(value(multiset([7, 9])), (a + b) % 2n ** 256n);
  assert.equal(value(multiset([7, 7, 7])), (3n * a) % 2n ** 256n);
});

test('the normal stays out of the hash, and both canonicalizations fold', () => {
  // Each claim also asserts the streams differ byte-wise, so a no-op
  // construction cannot pass by accident.
  const normalA = makeBits(twelve((f) => (f < 3 ? 0x3f800000 : 0x40000000 + f)));
  const normalB = makeBits(twelve((f) => (f < 3 ? 0xbf800000 : 0x40000000 + f)));
  assert.equal(
    stlIdentity(normalA).multiset,
    stlIdentity(normalB).multiset,
    'normal must not enter the hash',
  );
  assert.notEqual(
    stlIdentity(normalA).sha256,
    stlIdentity(normalB).sha256,
    'normal-only change moves the bytes',
  );

  const posZero = makeBits(twelve(() => 0x00000000));
  const negZero = makeBits(twelve(() => 0x80000000));
  assert.equal(stlIdentity(posZero).multiset, stlIdentity(negZero).multiset, '-0.0 canonicalizes to +0.0');
  assert.notEqual(stlIdentity(posZero).sha256, stlIdentity(negZero).sha256, 'signed zero moves the bytes');

  const nanA = makeBits(twelve(() => 0x7fc00001));
  const nanB = makeBits(twelve(() => 0xffc12345));
  assert.equal(
    stlIdentity(nanA).multiset,
    stlIdentity(nanB).multiset,
    'every NaN payload canonicalizes alike',
  );
  assert.notEqual(stlIdentity(nanA).multiset, stlIdentity(posZero).multiset, 'NaN is not the finite hash');
  assert.equal(canonicalizeF32Bits(0x7f800000), 0x7f800000, 'infinity is not a NaN');
});

test('non-finite records and attribute words are counted, never hidden', () => {
  const finite = twelve(() => 0x3f800000);
  const identity = stlIdentity(
    makeBits(
      finite,
      twelve(() => 0x7fc00000),
      finite,
      twelve(() => 0x7f800000),
    ),
  );
  assert.deepEqual(
    [identity.nonFiniteRecords, identity.firstNonFinite, identity.lastNonFinite],
    [2, 1, 3],
    'canonicalization must never mask the health counter',
  );
  assert.deepEqual(
    [stlIdentity(makeBits(finite)).firstNonFinite, stlIdentity(makeBits(finite)).lastNonFinite],
    [-1, -1],
  );

  const flagged = makeBits(finite, finite);
  new DataView(flagged.buffer).setUint16(84 + 48, 1, true);
  assert.equal(stlIdentity(flagged).attrNonZero, 1);
  assert.equal(stlIdentity(flagged).triangles, 2);
  assert.equal(stlIdentity(flagged).stlBytes, 84 + 2 * RECORD);
  assert.match(stlIdentity(flagged).stlFnv, /^[0-9a-f]+$/);
  assert.match(stlIdentity(flagged).headerSha256, /^[0-9a-f]{64}$/);
});
