// picovoxel's TypeScript port of Ex_ImplicitGyroidSphere, timed the same way as the C# host.
import { createPico } from '../../../src/index.ts';
import { ImplicitGyroid, ImplicitSphere } from '../../../src/shapekernel.ts';

const voxelSize = Number(process.argv[2] ?? 0.5);
const runs = Number(process.argv[3] ?? 1);
const t0 = performance.now();
const pk = await createPico({ voxelSize });
console.log(`picovoxel init ${(performance.now() - t0).toFixed(1)} ms; voxel ${voxelSize}`);
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  const radius = 10;
  const sdfSphere = new ImplicitSphere([0, 0, 0], radius);
  const sdfPattern = new ImplicitGyroid(3, 1);
  const bound = 1.2 * radius;
  const voxSphere = pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-bound, -bound, -bound],
    boundsMax: [bound, bound, bound],
    sdf: sdfSphere.expression,
  });
  const voxGyroidSphere = voxSphere.maskedByImplicit({ sdf: sdfPattern.expression });
  const taskMs = performance.now() - t;
  const t2 = performance.now();
  const stats = [voxGyroidSphere, voxSphere].map(
    (v) =>
      `volume ${v.properties().volume.toFixed(3)} mm3, ${v.toMesh().triangleCount} triangles, lane ${v.lane}`,
  );
  console.log(`run ${i}: task ${taskMs.toFixed(1)} ms; mesh+props ${(performance.now() - t2).toFixed(1)} ms`);
  if (i === 0) stats.forEach((s) => console.log('  ' + s));
}
pk.dispose();
