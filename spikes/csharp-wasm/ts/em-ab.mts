// The same PicoGK runtime sources built with two Emscripten versions, driven by picovoxel's
// TypeScript HeatX port. Usage: [MULTI=1] node em-ab.mts <src dir> <voxel> <runs>, where <src dir> is a
// copy of src/ holding the pico{,-multi}.{mjs,wasm} pair under test and its regenerated *.exports.ts.
const [srcDir, voxelArg = '1.0', runsArg = '1'] = process.argv.slice(2);
const { createPico } = await import(`${srcDir}/${process.env.MULTI ? 'multi' : 'index'}.ts`);
const { task } = await import(new URL('../../../examples/helixheatx/run.ts', import.meta.url).href);
const fnv = (b: Uint8Array) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
const hex = (v: number) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return d.getBigUint64(0).toString(16); };
for (let r = 0; r < Number(runsArg); r++) {
  const pk = await createPico({ voxelSize: Number(voxelArg) });
  const t0 = performance.now();
  const { voxels, authorMs, kernelTimings } = task(pk);
  const taskMs = performance.now() - t0;
  const t1 = performance.now(); const mesh = voxels.toMesh(); const meshMs = performance.now() - t1;
  const t2 = performance.now(); const stl = mesh.toStl(); const stlMs = performance.now() - t2;
  const kernelMs = kernelTimings.reduce((a: number, t: { ms: number }) => a + t.ms, 0);
  console.log(`run ${r}: task ${(taskMs / 1000).toFixed(2)} s (kernel ${(kernelMs / 1000).toFixed(2)}, author ${(authorMs / 1000).toFixed(2)}); mesh ${(meshMs / 1000).toFixed(2)} s; stl ${(stlMs / 1000).toFixed(2)} s; volume ${hex(voxels.volume)}; stl ${stl.length} bytes fnv ${fnv(stl)}`);
  if (r === 0) {
    const byStage = new Map<string, number>();
    for (const t of kernelTimings) byStage.set(t.stage ?? t.name ?? '?', (byStage.get(t.stage ?? t.name ?? '?') ?? 0) + t.ms);
    console.log('  stages: ' + [...byStage].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', '));
  }
  pk.dispose();
}
