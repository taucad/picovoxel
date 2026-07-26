// SK-0.10 scratch probe: mesh index-array forensics on a HeatX run.
// Reports vertex/triangle counts, NaN vertices, OOB index counts, and a
// histogram of the OOB *values* — the discriminator between "INVALID_IDX was
// emitted" and "the slot held arbitrary stale heap".
// Temporary instrument; not part of the shipped bench set.
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const build = arg('--build', 'multi');
const voxelSize = Number(arg('--size', '0.5'));

const entry = build === 'multi' ? '../src/multi.ts' : '../src/index.ts';
const { createPico } = await import(entry);
const { task } = await import('../examples/helixheatx/run.ts');

const loadBefore = loadavg()[0];
const session = await createPico({ voxelSize });
// Log every large JS-side staging allocation and whether it lands past 2 GiB
// (where an i32 wasm return comes back to JS as a negative number).
const mallocLog = [];
{
  const m = session.module;
  const orig = m._malloc.bind(m);
  m._malloc = (bytes) => {
    const p = orig(bytes);
    if (bytes > 1 << 20) mallocLog.push({ bytes, pointer: p, unsigned: p >>> 0, negative: p < 0 });
    return p;
  };
}
const { voxels } = task(session);
const volume = new DataView(new ArrayBuffer(8));
volume.setFloat64(0, voxels.volume);
const mesh = voxels.toMesh();
const { vertices, triangles, vertexCount, triangleCount } = mesh;

let nanVertices = 0;
for (let i = 0; i < vertices.length; i++) if (!Number.isFinite(vertices[i])) nanVertices++;

const INVALID = 0xffffffff;
let oob = 0;
let invalid = 0;
let maxIndex = 0;
const otherOob = new Map();
// A quad contributes two triangles; classify per triangle whether *all three*
// corners are bad (a wholly-unwritten source quad) or only some (a real emit).
let allBadTris = 0;
let someBadTris = 0;
for (let t = 0; t < triangleCount; t++) {
  let bad = 0;
  for (let k = 0; k < 3; k++) {
    const v = triangles[t * 3 + k];
    if (v > maxIndex) maxIndex = v;
    if (v >= vertexCount) {
      oob++;
      bad++;
      if (v === INVALID) invalid++;
      else if (otherOob.size < 24) otherOob.set(v, (otherOob.get(v) ?? 0) + 1);
    }
  }
  if (bad === 3) allBadTris++;
  else if (bad > 0) someBadTris++;
}

// Do bad triangles arrive in *pairs* (2i, 2i+1 from one quad)?
let pairedBadQuads = 0;
let splitBadQuads = 0;
for (let q = 0; q * 2 + 1 < triangleCount; q++) {
  const badA = [0, 1, 2].some((k) => triangles[q * 6 + k] >= vertexCount);
  const badB = [0, 1, 2].some((k) => triangles[q * 6 + 3 + k] >= vertexCount);
  if (badA && badB) pairedBadQuads++;
  else if (badA || badB) splitBadQuads++;
}

// Provenance of a bad pair: a stale *quad* (q0..q3) splits into (q2,q1,q0) and
// (q0,q3,q2), so the two triangles must share corners crosswise. A stale
// *triangle array* has no such relation. This separates "mFlatQuads holds
// stale bytes" from "PicoGK's m_oTriangles holds stale bytes".
let quadShaped = 0;
let notQuadShaped = 0;
for (let q = 0; q * 6 + 5 < triangles.length; q++) {
  const a = [triangles[q * 6], triangles[q * 6 + 1], triangles[q * 6 + 2]];
  const b = [triangles[q * 6 + 3], triangles[q * 6 + 4], triangles[q * 6 + 5]];
  if (!a.some((v) => v >= vertexCount) && !b.some((v) => v >= vertexCount)) continue;
  if (a[0] === b[2] && a[2] === b[0]) quadShaped++;
  else notQuadShaped++;
}

// Leading run: how far into the array does the corruption start?
let firstBad = -1;
let lastGood = -1;
for (let t = 0; t < triangleCount; t++) {
  const bad = [0, 1, 2].some((k) => triangles[t * 3 + k] >= vertexCount);
  if (bad && firstBad < 0) firstBad = t;
  if (!bad) lastGood = t;
}

console.log(
  JSON.stringify(
    {
      build,
      voxelSize,
      threads: (session.module.PThread?.runningWorkers.length ?? 0) + 1,
      wasmSha256: null,
      volumeHex: volume.getBigUint64(0).toString(16),
      vertexCount,
      triangleCount,
      vertexFloats: vertices.length,
      indexCount: triangles.length,
      nanVertices,
      maxIndex,
      oob,
      invalidIdx: invalid,
      otherOobSample: [...otherOob.entries()].slice(0, 24),
      allBadTris,
      someBadTris,
      pairedBadQuads,
      splitBadQuads,
      quadShaped,
      notQuadShaped,
      firstBad,
      lastGood,
      peakHeapBytes: session.module.HEAPU32.buffer.byteLength,
      loadBefore,
      loadAfter: loadavg()[0],
      mallocLog,
    },
    null,
    2,
  ),
);
session.dispose();
