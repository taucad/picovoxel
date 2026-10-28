/** Compare exact geometry bytes and attribute STL differences without changing them. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Summarize one immutable payload. */
export function identity(bytes) {
  // Two uint32 limbs keep the historical FNV recurrence exact without a BigInt
  // allocation for every byte in a large STL. Prime = 2^40 + 435.
  let low = 0x739d0383;
  let high = 0x14650fb0;
  for (const byte of bytes) {
    const input = (low ^ byte) >>> 0;
    const product = input * 435;
    high = (high * 435 + Math.floor(product / 0x100000000) + ((input << 8) >>> 0)) >>> 0;
    low = product >>> 0;
  }
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    historicalFnv64: high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0'),
  };
}

/** Decode only the structural envelope; do not normalize NaNs or reorder triangles. */
function stl(bytes) {
  if (bytes.length < 84) throw new Error('Truncated binary STL header');
  const count = bytes.readUInt32LE(80);
  if (bytes.length !== 84 + count * 50) throw new Error('Binary STL count/length mismatch');
  return count;
}

/** Attribute byte mismatches while leaving exact equality as the gate. */
export function compareStl(before, after) {
  const beforeCount = stl(before);
  const afterCount = stl(after);
  const result = {
    identical: before.equals(after),
    before: identity(before),
    after: identity(after),
    triangles: { before: beforeCount, after: afterCount },
    headerEqual: before.subarray(0, 80).equals(after.subarray(0, 80)),
    normalWords: 0,
    nanNormalWords: 0,
    vertexWords: 0,
    attributes: 0,
    samples: [],
  };
  for (let triangle = 0; triangle < Math.min(beforeCount, afterCount); triangle++) {
    const start = 84 + triangle * 50;
    for (let word = 0; word < 12; word++) {
      const offset = start + word * 4;
      const a = before.readUInt32LE(offset);
      const b = after.readUInt32LE(offset);
      if (a === b) continue;
      if (word < 3) {
        result.normalWords++;
        if (Number.isNaN(before.readFloatLE(offset)) && Number.isNaN(after.readFloatLE(offset)))
          result.nanNormalWords++;
      } else result.vertexWords++;
      if (result.samples.length < 16)
        result.samples.push({ triangle, word, offset, before: a.toString(16), after: b.toString(16) });
    }
    if (before.readUInt16LE(start + 48) !== after.readUInt16LE(start + 48)) result.attributes++;
  }
  result.classification = result.identical
    ? 'identical'
    : result.headerEqual &&
        beforeCount === afterCount &&
        result.attributes === 0 &&
        result.vertexWords === 0 &&
        result.normalWords > 0 &&
        result.normalWords === result.nanNormalWords
      ? 'nan-normal-encoding-only'
      : 'other-byte-difference';
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, after, output, ...extra] = process.argv.slice(2);
  if (!before || !after || !output || extra.length)
    throw new Error('Usage: node dotnet/compare-files.mjs <before.stl> <after.stl> <new report.json>');
  const result = compareStl(readFileSync(before), readFileSync(after));
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  if (!result.identical) process.exitCode = 1;
}

/** Validate the raw mesh envelope emitted by the parity consumer. */
function mesh(bytes) {
  if (bytes.length < 8) throw new Error('Truncated raw mesh header');
  const vertices = bytes.readUInt32LE(0);
  const triangles = bytes.readUInt32LE(4);
  const indexStart = 8 + vertices * 12;
  if (bytes.length !== indexStart + triangles * 12) throw new Error('Raw mesh count/length mismatch');
  for (let offset = 8; offset < indexStart; offset += 4)
    if (!Number.isFinite(bytes.readFloatLE(offset))) throw new Error('Non-finite raw mesh position');
  for (let offset = indexStart; offset < bytes.length; offset += 4)
    if (bytes.readUInt32LE(offset) >= vertices) throw new Error('Raw mesh index out of bounds');
  return { vertices, triangles, indexStart };
}

/** Compare vertex float bits and triangle indices in their original order. */
export function compareMesh(before, after) {
  const a = mesh(before);
  const b = mesh(after);
  const result = {
    identical: before.equals(after),
    before: { ...identity(before), vertices: a.vertices, triangles: a.triangles },
    after: { ...identity(after), vertices: b.vertices, triangles: b.triangles },
    vertexWords: 0,
    triangleIndices: 0,
    samples: [],
  };
  for (const [kind, startA, startB, count] of [
    ['vertexWords', 8, 8, Math.min(a.vertices, b.vertices) * 3],
    ['triangleIndices', a.indexStart, b.indexStart, Math.min(a.triangles, b.triangles) * 3],
  ]) {
    for (let word = 0; word < count; word++) {
      const x = before.readUInt32LE(startA + word * 4);
      const y = after.readUInt32LE(startB + word * 4);
      if (x === y) continue;
      result[kind]++;
      if (result.samples.length < 16) result.samples.push({ kind, word, before: x, after: y });
    }
  }
  return result;
}
