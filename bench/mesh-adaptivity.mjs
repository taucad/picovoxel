// Spike S1 — OpenVDB mesh adaptivity (patches/PicoGKRuntime/0006) on three
// fixtures at 0.5 mm voxels, measured against gate SG1:
//   box    100 × 60 × 20 mm (flat faces: adaptivity's best case);
//   geode  gyroid-filled sphere r 22 mm (gyroid cell 8 mm, wall 1.5 mm);
//   lamp   gyroid sheet (cell 8 mm, wall 1.5 mm) in a 60 mm spherical shell
//          (outer r 30 mm, inner r 26 mm).
// For each adaptivity in ADAPTIVITIES it records triangles, the meshing time
// (median of REPEATS toMesh() calls), closedness and non-manifold edges by
// index topology, the maximum distance of each adaptive vertex from the
// adaptivity-0 mesh (nearest triangle, mm and voxels), and whether REPEATS
// runs return the same bytes. Grid construction is not timed.
//
// Usage: node bench/mesh-adaptivity.mjs <out.json> [serial|multi]
//   BENCH_ADAPTIVITY_REPEATS=N   timed repeats per point (default 3)
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

const [outFile, variant = 'serial'] = process.argv.slice(2);
if (!outFile || !['serial', 'multi'].includes(variant)) {
  console.error('usage: node bench/mesh-adaptivity.mjs <out.json> [serial|multi]');
  process.exit(1);
}
const REPEATS = Number(process.env.BENCH_ADAPTIVITY_REPEATS ?? 3);
const ADAPTIVITIES = [0, 0.25, 0.5, 0.75, 1];
const VOXEL_SIZE = 0.5;

const { createPico } = await (variant === 'multi' ? import('../src/multi.ts') : import('../src/index.ts'));

// ── Fixtures (signed distance, negative inside) ──
const box = (hx, hy, hz) => (x, y, z) => {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
};
const K = (2 * Math.PI) / 8; // gyroid cell 8 mm
// |∇g| averages about 1.3 k on the surface, so |g| / (1.3 k) approximates distance.
const gyroidSheet = (wall) => (x, y, z) => {
  const g =
    Math.sin(K * x) * Math.cos(K * y) + Math.sin(K * y) * Math.cos(K * z) + Math.sin(K * z) * Math.cos(K * x);
  return Math.abs(g) / (1.3 * K) - wall / 2;
};
const sphere = (r) => (x, y, z) => Math.hypot(x, y, z) - r;
const sheet = gyroidSheet(1.5);
const FIXTURES = {
  box: { bounds: [-52, -32, -12, 52, 32, 12], sdf: box(50, 30, 10) },
  geode: {
    bounds: [-24, -24, -24, 24, 24, 24],
    // Sphere r 22 filled with the gyroid sheet, inside a 1.5 mm skin.
    sdf: (x, y, z) => {
      const outer = sphere(22)(x, y, z);
      const skin = Math.max(outer, -sphere(20.5)(x, y, z));
      return Math.max(outer, Math.min(skin, sheet(x, y, z)));
    },
  },
  lamp: {
    bounds: [-32, -32, -32, 32, 32, 32],
    sdf: (x, y, z) => Math.max(sphere(30)(x, y, z), -sphere(26)(x, y, z), sheet(x, y, z)),
  },
};

// ── Topology ──
function topology(triangles) {
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    if (a === b || b === c || c === a) degenerate++;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = u < v ? u * 0x1_0000_0000 + v : v * 0x1_0000_0000 + u;
      const entry = edges.get(key) ?? [0, 0];
      entry[u < v ? 0 : 1]++;
      edges.set(key, entry);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let misoriented = 0;
  for (const [forward, backward] of edges.values()) {
    const n = forward + backward;
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
    else if (forward !== 1) misoriented++;
  }
  return { edges: edges.size, boundary, nonManifold, misoriented, degenerate };
}

// ── Nearest-triangle distance (Ericson, Real-Time Collision Detection 5.1.5) ──
function pointSegmentDistanceSq(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t =
    len > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len),
        )
      : 0;
  const dx = p[0] - (a[0] + t * ab[0]);
  const dy = p[1] - (a[1] + t * ab[1]);
  const dz = p[2] - (a[2] + t * ab[2]);
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance; a zero-area triangle (OpenVDB emits some) is measured as its three edges. */
function pointTriangleDistanceSq(p, a, b, c) {
  const d = triangleDistanceSq(p, a, b, c);
  if (Number.isFinite(d)) return d;
  return Math.min(
    pointSegmentDistanceSq(p, a, b),
    pointSegmentDistanceSq(p, b, c),
    pointSegmentDistanceSq(p, c, a),
  );
}

function triangleDistanceSq(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        q = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
      } else {
        const cp = sub(p, c);
        const d5 = dot(ab, cp);
        const d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            q = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
            }
          }
        }
      }
    }
  }
  const d = sub(p, q);
  return dot(d, d);
}

/** Uniform-grid index over the reference triangles; returns maxDistance(points). */
function deviationFrom(reference, cell = 1) {
  const { vertices: rv, triangles: rt } = reference;
  const corner = (i) => [rv[3 * i], rv[3 * i + 1], rv[3 * i + 2]];
  const key = (i, j, k) => `${i},${j},${k}`;
  const grid = new Map();
  for (let t = 0; t < rt.length; t += 3) {
    const a = corner(rt[t]);
    const b = corner(rt[t + 1]);
    const c = corner(rt[t + 2]);
    const lo = [0, 1, 2].map((d) => Math.floor(Math.min(a[d], b[d], c[d]) / cell));
    const hi = [0, 1, 2].map((d) => Math.floor(Math.max(a[d], b[d], c[d]) / cell));
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++) {
          const list = grid.get(key(i, j, k));
          if (list) list.push(t);
          else grid.set(key(i, j, k), [t]);
        }
  }
  const nearest = (p) => {
    const ci = p.map((v) => Math.floor(v / cell));
    let best = Infinity;
    for (let ring = 0; ring < 64; ring++) {
      const seen = new Set();
      for (let i = -ring; i <= ring; i++)
        for (let j = -ring; j <= ring; j++)
          for (let k = -ring; k <= ring; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== ring) continue;
            for (const t of grid.get(key(ci[0] + i, ci[1] + j, ci[2] + k)) ?? []) {
              if (seen.has(t)) continue;
              seen.add(t);
              best = Math.min(
                best,
                pointTriangleDistanceSq(p, corner(rt[t]), corner(rt[t + 1]), corner(rt[t + 2])),
              );
            }
          }
      // Every triangle within ring·cell of p has been seen.
      if (best !== Infinity && Math.sqrt(best) <= ring * cell) break;
    }
    return Math.sqrt(best);
  };
  return (vertices) => {
    let max = 0;
    let sum = 0;
    const n = vertices.length / 3;
    for (let v = 0; v < n; v++) {
      const d = nearest([vertices[3 * v], vertices[3 * v + 1], vertices[3 * v + 2]]);
      sum += d;
      if (d > max) max = d;
    }
    return { max, mean: sum / n };
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const digest = (mesh) =>
  createHash('sha256')
    .update(new Uint8Array(mesh.vertices.buffer))
    .update(new Uint8Array(mesh.triangles.buffer))
    .digest('hex')
    .slice(0, 16);

const session = await createPico({ voxelSize: VOXEL_SIZE, lane: 'fast' });
const threads = (session.module.PThread?.runningWorkers.length ?? 0) + 1;
const out = {
  spike: 'S1',
  variant,
  threads,
  voxelSizeMm: VOXEL_SIZE,
  repeats: REPEATS,
  node: process.version,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  load: loadavg(),
  fixtures: {},
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  const [x0, y0, z0, x1, y1, z1] = fixture.bounds;
  const voxels = session.createVoxels({
    shape: 'implicit',
    boundsMin: [x0, y0, z0],
    boundsMax: [x1, y1, z1],
    sdf: fixture.sdf,
  });
  voxels.toMesh().dispose(); // warm-up
  const rows = [];
  let measureDeviation = null;
  for (const adaptivity of ADAPTIVITIES) {
    const samples = [];
    const digests = [];
    let mesh = null;
    for (let i = 0; i < REPEATS; i++) {
      const t = performance.now();
      const m = voxels.toMesh({ adaptivity });
      samples.push(performance.now() - t);
      digests.push(digest(m));
      if (mesh) m.dispose();
      else mesh = m;
    }
    const data = { vertices: mesh.vertices, triangles: mesh.triangles };
    if (adaptivity === 0) measureDeviation = deviationFrom(data);
    const deviation = measureDeviation(data.vertices);
    const topo = topology(data.triangles);
    const row = {
      adaptivity,
      triangles: mesh.triangleCount,
      vertices: mesh.vertexCount,
      meshMsMedian: median(samples),
      meshMs: samples,
      watertight: topo.boundary === 0 && topo.nonManifold === 0 && topo.misoriented === 0,
      ...topo,
      maxDeviationMm: deviation.max,
      maxDeviationVoxels: deviation.max / VOXEL_SIZE,
      meanDeviationMm: deviation.mean,
      volumeMm3: mesh.measure().volume,
      digests,
      byteIdentical: digests.every((d) => d === digests[0]),
    };
    rows.push(row);
    console.log(name, JSON.stringify({ ...row, meshMs: undefined, digests: undefined }));
    mesh.dispose();
  }
  const base = rows[0];
  for (const row of rows) {
    row.reduction = base.triangles / row.triangles;
    row.timeRatio = row.meshMsMedian / base.meshMsMedian;
  }
  out.fixtures[name] = rows;
  voxels.dispose();
}
session.dispose();
writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${outFile}`);
