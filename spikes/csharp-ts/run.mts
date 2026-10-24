// Runs the cs2ts output of Ex_ImplicitGyroidSphere.cs on picovoxel, in either lane, and
// prints the same lines as the C# hosts (volume bits, triangles, FNV mesh digest).
import { Library, shown, stats, type Mesh } from './runtime/picogk.ts';
import { ImplicitGyroidSphere } from './out/gyroid-sphere.ts';

const voxelSize = Number(process.argv[2] ?? 0.5);
const runs = Number(process.argv[3] ?? 3);
const lane = (process.argv[4] ?? 'exact') as 'exact' | 'fast';
const lib = await Library.Create(voxelSize, lane);

function digest(msh: Mesh): string {
  let h = 1469598103934665603n; // the C# hosts' offset basis, so digests compare
  const mix = (n: number) => { for (let b = 0; b < 4; b++) { h ^= BigInt((n >>> (8 * b)) & 0xff); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } };
  const bits = new Uint32Array(new Float32Array(1).buffer), fb = new Float32Array(bits.buffer);
  const u = (x: number) => { fb[0] = x; return bits[0]!; };
  for (let i = 0; i < msh.nVertexCount(); i++) { const v = msh.vecVertexAt(i); mix(u(v.X)); mix(u(v.Y)); mix(u(v.Z)); }
  for (let i = 0; i < msh.nTriangleCount(); i++) { const t = msh.oTriangleAt(i); mix(t.A >>> 0); mix(t.B >>> 0); mix(t.C >>> 0); }
  return h.toString(16).padStart(16, '0');
}
const bitsOf = (x: number) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x); return b.getUint32(0).toString(16).padStart(8, '0'); };

console.log(`cs2ts on picovoxel; voxel ${voxelSize} mm; lane ${lane}`);
for (let i = 0; i < runs; i++) {
  shown.length = 0;
  const calls0 = stats.callbackCalls;
  const t0 = performance.now();
  ImplicitGyroidSphere.Task();
  const task = performance.now() - t0;
  const t1 = performance.now();
  const lines = shown.map((s, g) => {
    const [vol] = s.vox.CalculateProperties();
    const msh = s.vox.mshAsMesh();
    return `group ${g}: volume ${vol.toFixed(3)} mm3 (bits ${bitsOf(vol)}), ${msh.nTriangleCount()} triangles, mesh digest ${digest(msh)}`;
  });
  console.log(`run ${i}: task ${task.toFixed(1)} ms (${stats.callbackCalls - calls0} SDF callbacks, tape renders so far ${stats.tapeRenders}); mesh+props ${(performance.now() - t1).toFixed(1)} ms`);
  if (i === 0) lines.forEach((l) => console.log('  ' + l));
}
