// Identity tooling for binary STL streams, over the multiset hash in
// bench/stl-multiset.mjs: an identity table, the first divergent record between
// two streams, and a HelixHeatX run that records its identity.
//
// Usage
//   node bench/stl-identity.mjs hash <file.stl>...          # identity table
//   node bench/stl-identity.mjs diff <a.stl> <b.stl>         # first divergence
//   node bench/stl-identity.mjs run --build single|multi --size 0.5 \
//        [--label L] [--jsonl F] [--dump FILE]               # HeatX + identity

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORD, stlIdentity } from './stl-multiset.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GEOMETRY = 48; // normal + vertices — what `diff` compares byte-wise

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
      ? 'byte-identical'
      : same('multiset')
        ? 'identical triangle multiset, permuted bytes'
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
    console.log(`  A n=[${decode(viewA, t).slice(0, 3).join()}] v=[${decode(viewA, t).slice(3).join()}]`);
    console.log(`  B n=[${decode(viewB, t).slice(0, 3).join()}] v=[${decode(viewB, t).slice(3).join()}]`);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'run') await cmdRun(rest);
  else if (command === 'diff') cmdDiff(rest[0], rest[1]);
  else if (command === 'hash') cmdHash(rest);
  else {
    console.error(
      'usage: stl-identity.mjs hash <file>... | diff <a> <b> | run --build B --size S [--label L] [--jsonl F] [--dump FILE]',
    );
    process.exit(2);
  }
}
