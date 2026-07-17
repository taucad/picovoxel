// Involute spur gear, ported from PicoGK's own models/02_Gears/InvoluteGear.cs so
// the wasm port is exercised through the same construction the C# example uses:
// profile in JS -> Mesh_hCreate / nAddVertex / nAddTriangle across the ABI.
//
// Note this model touches ZERO Voxels — that is exactly why it cannot be the
// acceptance gate for the port (conformance-suite Finding 1). It proves the ABI
// boundary, handle lifetime, and mesh transfer, and nothing about OpenVDB.

export const GEAR_DEFAULTS = {
  teeth: 18,
  module: 1.5,
  width: 10,
  pressureAngleDeg: 20,
  involuteSteps: 8,
  topArcSteps: 4,
  rootArcSteps: 4,
};

const toRad = (deg) => (deg * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;

// Unwind angle of the involute at `radius` off a base circle. Below the base
// circle the involute is undefined — clamp rather than produce NaN.
function involuteAngle(radius, baseRadius) {
  const ratio = radius / baseRadius;
  if (ratio <= 1) return 0;
  const t = Math.sqrt(ratio * ratio - 1);
  return t - Math.atan(t);
}

function addPolar(points, radius, angle) {
  const p = [radius * Math.cos(angle), radius * Math.sin(angle)];
  const last = points[points.length - 1];
  if (!last || (last[0] - p[0]) ** 2 + (last[1] - p[1]) ** 2 > 1e-6) points.push(p);
}

const signedArea = (pts) => {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
};

export function createGearOutline(opts = {}) {
  const o = { ...GEAR_DEFAULTS, ...opts };
  const pitchRadius = (o.module * o.teeth) / 2;
  const baseRadius = pitchRadius * Math.cos(toRad(o.pressureAngleDeg));
  const outerRadius = pitchRadius + o.module;
  const rootRadius = pitchRadius - 1.25 * o.module;
  const toothPitchAngle = (2 * Math.PI) / o.teeth;
  const halfToothAngle = Math.PI / (2 * o.teeth);
  const baseFlankAngle = halfToothAngle + involuteAngle(pitchRadius, baseRadius);
  const outerFlankAngle = baseFlankAngle - involuteAngle(outerRadius, baseRadius);
  const flankStartRadius = Math.max(rootRadius, baseRadius);

  const points = [];
  for (let tooth = 0; tooth < o.teeth; tooth++) {
    const centerAngle = tooth * toothPitchAngle;
    addPolar(points, rootRadius, centerAngle - baseFlankAngle);
    if (rootRadius < baseRadius) addPolar(points, baseRadius, centerAngle - baseFlankAngle);

    for (let step = 1; step <= o.involuteSteps; step++) {
      const radius = lerp(flankStartRadius, outerRadius, step / o.involuteSteps);
      addPolar(points, radius, centerAngle - (baseFlankAngle - involuteAngle(radius, baseRadius)));
    }
    for (let step = 1; step <= o.topArcSteps; step++) {
      addPolar(points, outerRadius,
        lerp(centerAngle - outerFlankAngle, centerAngle + outerFlankAngle, step / o.topArcSteps));
    }
    for (let step = o.involuteSteps - 1; step >= 0; step--) {
      const radius = lerp(flankStartRadius, outerRadius, step / o.involuteSteps);
      addPolar(points, radius, centerAngle + (baseFlankAngle - involuteAngle(radius, baseRadius)));
    }
    if (rootRadius < baseRadius) addPolar(points, rootRadius, centerAngle + baseFlankAngle);

    const rootArcStart = centerAngle + baseFlankAngle;
    const rootArcEnd = centerAngle + toothPitchAngle - baseFlankAngle;
    for (let step = 1; step <= o.rootArcSteps; step++) {
      addPolar(points, rootRadius, lerp(rootArcStart, rootArcEnd, step / o.rootArcSteps));
    }
  }

  const first = points[0];
  const last = points[points.length - 1];
  if ((first[0] - last[0]) ** 2 + (first[1] - last[1]) ** 2 < 1e-6) points.pop();
  if (signedArea(points) < 0) points.reverse();
  return points;
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function pointInTriangle(p, a, b, c) {
  const eps = -1e-6;
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < eps || d2 < eps || d3 < eps;
  const hasPos = d1 > -eps || d2 > -eps || d3 > -eps;
  return !(hasNeg && hasPos);
}

/** Ear clipping, same as the C# original — the outline is simple and CCW by here. */
export function triangulate(polygon) {
  const remaining = polygon.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (remaining.length > 3 && guard++ < polygon.length * polygon.length) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = polygon[ia], b = polygon[ib], c = polygon[ic];
      if (cross(a, b, c) <= 0) continue; // reflex
      let contains = false;
      for (const j of remaining) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTriangle(polygon[j], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) tris.push([remaining[0], remaining[1], remaining[2]]);
  return tris;
}

/** Builds the gear inside PicoGK via the C ABI and returns the mesh handle. */
export function buildGearMesh(pk, lib, opts = {}) {
  const o = { ...GEAR_DEFAULTS, ...opts };
  const outline = createGearOutline(o);
  const caps = triangulate(outline);
  const mesh = pk.meshCreate(lib);

  const zBottom = -o.width / 2;
  const zTop = o.width / 2;
  const bottom = [];
  const top = [];
  for (const [x, y] of outline) {
    bottom.push(pk.addVertex(lib, mesh, x, y, zBottom));
    top.push(pk.addVertex(lib, mesh, x, y, zTop));
  }
  for (const [a, b, c] of caps) {
    pk.addTriangle(lib, mesh, top[a], top[b], top[c]);
    pk.addTriangle(lib, mesh, bottom[c], bottom[b], bottom[a]); // reversed winding
  }
  for (let i = 0; i < outline.length; i++) {
    const next = (i + 1) % outline.length;
    pk.addTriangle(lib, mesh, bottom[i], bottom[next], top[next]); // AddQuad = 2 tris
    pk.addTriangle(lib, mesh, bottom[i], top[next], top[i]);
  }
  return { mesh, outlineCount: outline.length, capCount: caps.length };
}
