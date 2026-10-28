import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareStl, compareMesh, identity } from '../compare-files.mjs';

function triangle() {
  const bytes = Buffer.alloc(134);
  bytes.writeUInt32LE(1, 80);
  for (let i = 0; i < 12; i++) bytes.writeFloatLE(i + 0.25, 84 + i * 4);
  return bytes;
}
test('byte equality remains the gate, including header and attributes', () => {
  const before = triangle();
  assert.equal(compareStl(before, Buffer.from(before)).identical, true);
  for (const offset of [0, 132]) {
    const after = Buffer.from(before);
    after[offset] ^= 1;
    const result = compareStl(before, after);
    assert.equal(result.identical, false);
    assert.equal(result.classification, 'other-byte-difference');
  }
});
test('NaN encoding attribution does not pass the byte gate', () => {
  const before = triangle();
  const after = triangle();
  before.writeUInt32LE(0xffc00000, 84);
  after.writeUInt32LE(0x7fc00000, 84);
  const result = compareStl(before, after);
  assert.equal(result.identical, false);
  assert.equal(result.classification, 'nan-normal-encoding-only');
  assert.equal(result.normalWords, 1);
  assert.equal(result.nanNormalWords, 1);
  assert.equal(result.vertexWords, 0);
  after.writeUInt32LE(0x7fc00000, 96);
  assert.equal(compareStl(before, after).classification, 'other-byte-difference');
});
test('finite normal changes and malformed envelopes remain failures', () => {
  const before = triangle();
  const after = triangle();
  after.writeFloatLE(2, 84);
  assert.equal(compareStl(before, after).classification, 'other-byte-difference');
  assert.throws(() => compareStl(Buffer.alloc(83), after), /Truncated/);
  assert.throws(() => compareStl(before.subarray(0, 133), after), /count\/length/);
});

test('historical payload digests agree with the independent 64-bit recurrence', () => {
  for (const size of [0, 1, 50, 16384]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 151 + 231) & 255));
    let hash = 1469598103934665603n;
    for (const value of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(value)) * 1099511628211n);
    assert.equal(identity(bytes).historicalFnv64, hash.toString(16).padStart(16, '0'));
  }
});

// Raw mesh equality is structural and bitwise; malformed matching outputs fail.
function rawMesh() {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(3, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeFloatLE(1, 20);
  bytes.writeFloatLE(1, 36);
  bytes.writeUInt32LE(1, 48);
  bytes.writeUInt32LE(2, 52);
  return bytes;
}
test('raw mesh comparator preserves vertex bits and triangle order', () => {
  const before = rawMesh();
  assert.equal(compareMesh(before, before).identical, true);
  const after = Buffer.from(before);
  after.writeFloatLE(-0, 8);
  const result = compareMesh(before, after);
  assert.equal(result.identical, false);
  assert.equal(result.vertexWords, 1);
  after.writeUInt32LE(2, 48);
  after.writeUInt32LE(1, 52);
  assert.equal(compareMesh(before, after).triangleIndices, 2);
});
test('matching malformed meshes cannot pass parity', () => {
  const truncated = rawMesh().subarray(0, 52);
  assert.throws(() => compareMesh(truncated, truncated), /count\/length/);
  const invalid = rawMesh();
  invalid.writeUInt32LE(3, 48);
  assert.throws(() => compareMesh(invalid, invalid), /index out of bounds/);
  const nan = rawMesh();
  nan.writeFloatLE(NaN, 8);
  assert.throws(() => compareMesh(nan, nan), /Non-finite/);
});
