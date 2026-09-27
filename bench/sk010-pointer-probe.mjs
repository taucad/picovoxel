// SK-0.10 sentinel probe: is the defect allocator-specific, or is the allocator
// only deciding *where* the staging buffer lands?
//
// Runs the real facade readback (src/mesh.ts), then materialises the SAME wasm
// staging buffer a second time with the pre-fix signed shift (`>> 2`) and counts
// out-of-range indices in each view. `_free` is deferred so the buffer is still
// intact for the second read. `--ballast N` pre-allocates N bytes that are never
// freed, so a build whose staging pointer would otherwise sit below 2 GiB can be
// pushed above it on demand — which is how "dlmalloc is clean" gets tested as a
// claim about addresses rather than about allocators. Temporary spike instrument.
import { loadavg } from 'node:os';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const build = arg('--build', 'multi');
const voxelSize = Number(arg('--size', '0.7'));
const ballastBytes = Number(arg('--ballast', '0'));

const { createPico } = await import(build === 'multi' ? '../src/multi.ts' : '../src/index.ts');
const { task } = await import('../examples/helixheatx/run.ts');

const session = await createPico({ voxelSize });
const { module } = session;

const ballast = ballastBytes > 0 ? module._malloc(ballastBytes) : 0;
if (ballastBytes > 0 && ballast === 0) throw new Error('ballast allocation failed');

const { voxels } = task(session);
const mesh = voxels.toMesh();
const { vertexCount, triangleCount } = mesh;

// Watch the facade's own staging allocation, and hold the frees back so the
// buffer survives long enough to be read twice.
const stagingBytes = triangleCount * 12;
let stagingPointer = 0;
const held = [];
{
  const malloc = module._malloc.bind(module);
  const free = module._free.bind(module);
  module._malloc = (bytes) => {
    const p = malloc(bytes);
    if (bytes === stagingBytes) stagingPointer = p;
    return p;
  };
  module._free = (p) => held.push(p);
  void mesh.triangles; // the fixed facade path
  module._free = free;
}

const oob = (indices) => {
  let n = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vertexCount) n++;
  return n;
};
const unsignedView = module.HEAPU32.subarray(
  stagingPointer >>> 2,
  (stagingPointer >>> 2) + triangleCount * 3,
);
const signedView = module.HEAPU32.subarray(stagingPointer >> 2, (stagingPointer >> 2) + triangleCount * 3);
const result = {
  build,
  voxelSize,
  ballastBytes,
  ballastPointer: ballast,
  stagingPointer,
  stagingAbove2GiB: stagingPointer >= 2 ** 31,
  heapBytes: module.HEAPU32.buffer.byteLength,
  vertexCount,
  triangleCount,
  oobUnsignedShift: oob(unsignedView),
  oobSignedShift: oob(signedView),
  load: loadavg()[0],
};
for (const p of held) module._free(p);
console.log(JSON.stringify(result, null, 2));
session.dispose();
