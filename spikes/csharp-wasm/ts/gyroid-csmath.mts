// The TS port, with the gyroid evaluated exactly as the C# source does: float32 frequency
// scale, double sin/cos, result rounded to float32. Callback path, not the tape.
import { createPico } from '../../../src/index.ts';
import { ImplicitSphere } from '../../../src/shapekernel.ts';
const voxelSize = Number(process.argv[2] ?? 0.5);
const pk = await createPico({ voxelSize });
const f = Math.fround,
  s = f(f(2 * f(Math.PI)) / 3),
  t = f(0.5 * 1);
const sdf = (x: number, y: number, z: number) =>
  f(
    Math.abs(
      Math.sin(s * x) * Math.cos(s * y) +
        Math.sin(s * y) * Math.cos(s * z) +
        Math.sin(s * z) * Math.cos(s * x),
    ) - t,
  );
const sphere = pk.createVoxels({
  shape: 'implicit',
  boundsMin: [-12, -12, -12],
  boundsMax: [12, 12, 12],
  sdf: new ImplicitSphere([0, 0, 0], 10).expression,
});
const t0 = performance.now();
const g = sphere.maskedByImplicit({ sdf });
console.log(
  `C# math via JS callback: intersect ${(performance.now() - t0).toFixed(1)} ms; volume ${g.properties().volume.toFixed(3)} mm3, ${g.toMesh().triangleCount} triangles`,
);
