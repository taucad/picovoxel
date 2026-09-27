// G0 identity oracle for binary STL streams (NON-DETERMINISM.md §6): the
// order-invariant multiset hash that discriminates "permuted bytes, same mesh"
// (Class 1) from "different mesh" (Class X / UB) — the discriminator §11.1 asks
// for. Built for SK-0.9; kept as general tooling.
//
// Construction (reconciled with NON-DETERMINISM.md §14.5, SK-0.10)
// ----------------------------------------------------------------
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
// SHA-256 rather than §14.5's 128-bit xxh3/BLAKE3: node stdlib, no dependency,
// and strictly stronger. It costs ~4 min over a 10 M-record / 502 MB stream
// against ~40 s of meshing, which is worth it for an oracle run offline; swap in
// xxh3-128 the day this tool goes near CI.
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
//
// Usage
//   node bench/stl-identity.mjs hash <file.stl>...          # identity table
//   node bench/stl-identity.mjs diff <a.stl> <b.stl>         # first divergence
//   node bench/stl-identity.mjs run --build single|multi --size 0.5 \
//        [--label L] [--jsonl F] [--dump FILE]               # HeatX + identity

import { createHash, hash as hashOne } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = 50;
const NORMAL = 12; // bytes of recomputed facet normal, excluded from the hash
const PAYLOAD = 36; // 9 f32 — the three vertices, canonicalized
const ATTR = 48; // offset of the 2-byte attribute word
const GEOMETRY = 48; // normal + vertices — what `diff` compares byte-wise

/** -0.0 -> +0.0, any NaN -> 0x7fc00000, everything else raw f32 bits (§14.5). */
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
  // Hard health boolean (NON-DETERMINISM.md §6 G0): a non-finite coordinate is
  // never legitimate output. src/stl.ts writes NaN when a triangle index points
  // past the vertex array (JS `undefined` through Math.fround), so this counter
  // is the cheapest detector of out-of-range indices in the extracted mesh.
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
  // spike document quotes (SK-0.1's `0ccaa277`/`38cad381`), so it is carried for
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

const readStl = (file) => new Uint8Array(readFileSync(file));
const fmt = (identity) =>
  `${String(identity.triangles).padStart(10)} tris  ${String(identity.stlBytes).padStart(10)} B  ` +
  `sha ${identity.sha256.slice(0, 12)}  multiset ${identity.multiset.slice(0, 24)}…`;

function cmdHash(files) {
  const seen = [];
  for (const file of files) {
    const identity = stlIdentity(readStl(file));
    seen.push({ file, ...identity });
    console.log(`${basename(file).padEnd(38)} ${fmt(identity)}`);
  }
  for (let i = 1; i < seen.length; i++) {
    const [a, b] = [seen[0], seen[i]];
    const same = (key) => a[key] === b[key];
    const verdict = same('sha256')
      ? 'Class 0 — byte-identical'
      : same('multiset')
        ? 'Class 1 — identical triangle multiset, permuted bytes'
        : `CONTENT DIFFERS — multiset mismatch (triangles ${a.triangles} vs ${b.triangles})`;
    console.log(`${basename(a.file)} vs ${basename(b.file)}: ${verdict}`);
  }
  console.log(JSON.stringify(seen, null, 2));
}

/** First differing record, and where (if anywhere) A's record lives inside B. */
function cmdDiff(fileA, fileB) {
  const a = readStl(fileA);
  const b = readStl(fileB);
  const viewA = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const viewB = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = Math.min(viewA.getUint32(80, true), viewB.getUint32(80, true));
  const record = (bytes, index) => bytes.subarray(84 + index * RECORD, 84 + index * RECORD + GEOMETRY);
  const decode = (view, index) =>
    Array.from({ length: 12 }, (_, i) => view.getFloat32(84 + index * RECORD + i * 4, true));

  const differing = [];
  for (let t = 0; t < count && differing.length < 5; t++) {
    if (Buffer.compare(record(a, t), record(b, t)) !== 0) differing.push(t);
  }
  if (differing.length === 0) {
    console.log(`no differing record in the first ${count} — streams agree record-wise`);
    return;
  }
  console.log(`header identical: ${Buffer.compare(a.subarray(0, 84), b.subarray(0, 84)) === 0}`);
  console.log(`first differing record indices: ${differing.join(', ')}`);
  for (const t of differing.slice(0, 3)) {
    console.log(`\nrecord ${t}`);
    console.log(`  A n=[${decode(viewA, t).slice(0, 3)}] v=[${decode(viewA, t).slice(3)}]`);
    console.log(`  B n=[${decode(viewB, t).slice(0, 3)}] v=[${decode(viewB, t).slice(3)}]`);
    // Where does A's record sit in B? A pure permutation puts it somewhere.
    const needle = record(a, t);
    let found = -1;
    for (let s = 0; s < count; s++) {
      if (Buffer.compare(record(b, s), needle) === 0) {
        found = s;
        break;
      }
    }
    console.log(
      `  A[${t}] found in B at index ${found}${found < 0 ? ' (ABSENT — content differs)' : ` (shift ${found - t})`}`,
    );
  }
}

async function cmdRun(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const build = arg('--build', 'single');
  const voxelSize = Number(arg('--size', '0.5'));
  const label = arg('--label', `${build}-${voxelSize}`);
  const jsonl = arg('--jsonl');
  const dump = arg('--dump');

  const entry = build === 'multi' ? '../src/multi.ts' : '../src/index.ts';
  const { createPico } = await import(entry);
  const { task } = await import('../examples/helixheatx/run.ts');
  const wasm = readFileSync(resolve(HERE, build === 'multi' ? 'src/pico-multi.wasm' : 'src/pico.wasm'));

  const loadBefore = loadavg()[0];
  const started = performance.now();
  const session = await createPico({ voxelSize });
  const { voxels } = task(session);
  const mesh = voxels.toMesh();
  const stl = mesh.toStl();
  const taskMs = performance.now() - started;
  const peakHeapBytes = session.module.HEAPU32.buffer.byteLength;
  const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
  const volume = new DataView(new ArrayBuffer(8));
  volume.setFloat64(0, voxels.volume);

  const record = {
    label,
    build,
    voxelSize,
    threads,
    volumeHex: volume.getBigUint64(0).toString(16),
    ...stlIdentity(stl),
    peakHeapBytes,
    taskMs: Math.round(taskMs),
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    cpu: `${cpus()[0]?.model} x${cpus().length}`,
    ram: `${Math.round(totalmem() / 2 ** 30)}GiB`,
    os: `${platform()} ${release()}`,
    node: process.version,
    loadBefore,
    loadAfter: loadavg()[0],
    date: new Date().toISOString(),
  };
  if (dump) writeFileSync(dump, stl);
  session.dispose();
  console.log(JSON.stringify(record));
  if (jsonl) appendFileSync(jsonl, JSON.stringify(record) + '\n');
}

/** ponytail: assert-based self-check, no framework — the 256-bit carry and the
 *  multiplicity property are the only non-trivial logic here. */
function cmdSelftest() {
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
  const ms = (records) => stlIdentity(make(records)).multiset;
  const eq = (claim, actual, expected) => {
    if (actual !== expected) throw new Error(`selftest: ${claim}`);
  };
  eq('permutation must preserve the multiset', ms([1, 2, 3]), ms([3, 1, 2]));
  if (ms([1, 2, 3]) === ms([1, 2, 4])) throw new Error('selftest: content change must move the multiset');
  // The XOR trap: {1,1,2} and {2,2,2} both XOR to hash(2), but must not sum alike.
  if (ms([1, 1, 2]) === ms([2, 2, 2])) throw new Error('selftest: multiplicity must be preserved');
  eq('multiset is 256 bits', ms([1]).length, 64);
  // Carry propagation across all eight limbs: 2^256-1 summed with 1 wraps to 0.
  const wrap = new Uint32Array(8).fill(0xffffffff);
  let carry = 1;
  for (let limb = 7; limb >= 0; limb--) {
    const sum = wrap[limb] + carry;
    wrap[limb] = sum >>> 0;
    carry = sum > 0xffffffff ? 1 : 0;
  }
  eq('mod-2^256 wraparound', [...wrap].join(), new Array(8).fill(0).join());
  eq(
    'permuted streams are not byte-identical',
    stlIdentity(make([1, 2, 3])).sha256 === stlIdentity(make([3, 1, 2])).sha256,
    false,
  );

  // §14.5 reconciliation (SK-0.10): the normal is out of the payload, and the
  // two canonicalizations fold. Each claim also asserts the streams really do
  // differ byte-wise, so a no-op construction cannot pass by accident.
  const normalA = makeBits(twelve((f) => (f < 3 ? 0x3f800000 : 0x40000000 + f)));
  const normalB = makeBits(twelve((f) => (f < 3 ? 0xbf800000 : 0x40000000 + f)));
  eq('normal must not enter the hash', stlIdentity(normalA).multiset, stlIdentity(normalB).multiset);
  eq(
    'normal-only change must still move the bytes',
    stlIdentity(normalA).sha256 === stlIdentity(normalB).sha256,
    false,
  );

  const posZero = makeBits(twelve(() => 0x00000000));
  const negZero = makeBits(twelve(() => 0x80000000));
  eq('-0.0 canonicalizes to +0.0', stlIdentity(posZero).multiset, stlIdentity(negZero).multiset);
  eq(
    'signed zero must still move the bytes',
    stlIdentity(posZero).sha256 === stlIdentity(negZero).sha256,
    false,
  );

  const nanA = makeBits(twelve(() => 0x7fc00001));
  const nanB = makeBits(twelve(() => 0xffc12345));
  eq('every NaN payload canonicalizes alike', stlIdentity(nanA).multiset, stlIdentity(nanB).multiset);
  // ...and canonicalization must NEVER mask the health counter.
  eq('NaN still counted', stlIdentity(nanA).nonFiniteRecords, 1);
  eq('NaN is not the finite hash', stlIdentity(nanA).multiset === stlIdentity(posZero).multiset, false);
  eq('infinity is not a NaN', canonicalizeF32Bits(0x7f800000), 0x7f800000);

  console.log('stl-identity selftest: ok');
}

// Import-safe: bench/g0-identity.mjs consumes stlIdentity as a library.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'selftest') cmdSelftest();
  else if (command === 'run') await cmdRun(rest);
  else if (command === 'diff') cmdDiff(rest[0], rest[1]);
  else if (command === 'hash') cmdHash(rest);
  else {
    console.error(
      'usage: stl-identity.mjs hash <file>... | diff <a> <b> | run --build B --size S [--label L] [--jsonl F] [--dump FILE]',
    );
    process.exit(2);
  }
}
