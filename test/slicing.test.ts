// R23 — picovoxel/slicing: marching-squares oracles (analytic circle, hollow
// cylinder, corner-ambiguity stitching), sphere slicing through the facade, CLI
// round-trip within format precision, deterministic SVG, progress monotonicity.

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPico, PicoError, type Pico } from '../src/index.ts';
import {
  contoursFromSdf,
  detectWinding,
  sliceToSvg,
  sliceVoxels,
  slicesFromCli,
  slicesToCli,
  type SliceContour,
} from '../src/slicing.ts';

let pk: Pico;
beforeAll(async () => {
  pk = await createPico({ voxelSize: 0.5 });
});
afterAll(() => pk.dispose());

/** |shoelace|/2 over a flat closed loop. */
function contourArea(contour: SliceContour): number {
  const p = contour.points;
  let area = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    area += p[i]! * p[i + 3]! - p[i + 2]! * p[i + 1]!;
  }
  return Math.abs(area / 2);
}

function isClosed(contour: SliceContour): boolean {
  const p = contour.points;
  return p[0] === p[p.length - 2] && p[1] === p[p.length - 1];
}

/** Analytic SDF image on a grid. */
function sdfImage(width: number, height: number, sdf: (x: number, y: number) => number) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = sdf(x, y);
  }
  return { width, height, data };
}

test('analytic circle: one closed CCW contour hugging the radius', () => {
  const image = sdfImage(100, 100, (x, y) => Math.hypot(x - 50, y - 50) - 30);
  const contours = contoursFromSdf(image);
  assert.equal(contours.length, 1);
  const circle = contours[0]!;
  assert.equal(circle.winding, 'ccw', 'a solid boundary is CCW');
  assert.ok(isClosed(circle), 'contour must be closed');
  assert.ok(circle.points.length / 2 > 60, `point count ${circle.points.length / 2}`);

  // Max radial deviation from r=30 must stay within one cell.
  // (Y is flipped by the vectorizer: centre row 50 maps to height-1-50 = 49.)
  for (let i = 0; i < circle.points.length; i += 2) {
    const r = Math.hypot(circle.points[i]! - 50, circle.points[i + 1]! - 49);
    assert.ok(Math.abs(r - 30) <= 1, `radial deviation ${Math.abs(r - 30)} at point ${i / 2}`);
  }
  assert.ok(Math.abs(contourArea(circle) - Math.PI * 900) / (Math.PI * 900) < 0.02, `area ${contourArea(circle)}`);
});

test('hollow cylinder slice: outer CCW + inner CW (hole winding)', () => {
  const image = sdfImage(100, 100, (x, y) => {
    const r = Math.hypot(x - 50, y - 50);
    return Math.max(r - 30, 15 - r); // annulus 15..30
  });
  const contours = contoursFromSdf(image);
  assert.equal(contours.length, 2, 'exactly outer + inner');
  const bySize = [...contours].sort((a, b) => contourArea(b) - contourArea(a));
  assert.equal(bySize[0]!.winding, 'ccw', 'outer boundary CCW');
  assert.equal(bySize[1]!.winding, 'cw', 'hole CW');
  for (const contour of contours) assert.ok(isClosed(contour));
});

test('corner-ambiguity (saddle) images stitch into closed contours, no open chains', () => {
  // Alternating-sign checkerboard drives LUT cases 5/10 (two segments per cell).
  const image = sdfImage(12, 12, (x, y) => ((x + y) % 2 === 0 ? -1 : 1));
  const contours = contoursFromSdf(image);
  assert.ok(contours.length > 0, 'saddle field must produce contours');
  for (const contour of contours) {
    assert.ok(isClosed(contour), 'every stitched contour must close');
    assert.ok(contour.points.length / 2 >= 4);
  }
});

test('winding detection matches the upstream signed-area convention', () => {
  assert.equal(detectWinding([0, 0, 4, 0, 4, 4, 0, 4]), 'ccw');
  assert.equal(detectWinding([0, 0, 0, 4, 4, 4, 4, 0]), 'cw');
  assert.equal(detectWinding([0, 0, 1, 1]), 'unknown');
});

test('sphere through the facade: one contour per slice, area tracks the analytic disc', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 8 });
  const stack = sliceVoxels(sphere);
  assert.ok(stack.slices.length > 25 && stack.slices.length < 40, `${stack.slices.length} slices for r=8 @ 0.5`);

  // Anchor on the equator (max-area slice) — the driver relabels z after skipping
  // leading empty layers, so absolute indices don't map to voxel-space z directly.
  const layerHeight = 0.5;
  const areas = stack.slices.map((s) => (s.contours.length === 1 ? contourArea(s.contours[0]!) : -1));
  const equator = areas.indexOf(Math.max(...areas));
  assert.ok(Math.abs(areas[equator]! - Math.PI * 64) / (Math.PI * 64) < 0.04, `equator area ${areas[equator]}`);

  let checked = 0;
  for (let k = -14; k <= 14; k++) {
    const i = equator + k;
    if (i < 0 || i >= stack.slices.length) continue;
    const discSquared = 64 - (k * layerHeight) ** 2;
    if (discSquared < 16) continue; // pole slices are band-dominated
    assert.equal(stack.slices[i]!.contours.length, 1, `slice ${i} contour count`);
    const expected = Math.PI * discSquared;
    assert.ok(Math.abs(areas[i]! - expected) / expected < 0.06, `slice ${i}: area ${areas[i]} vs ${expected}`);
    checked++;
  }
  assert.ok(checked > 10, `checked ${checked} interior slices`);
});

test('CLI round-trip: layer counts, contour counts, windings, coordinates within precision', () => {
  const body = pk.createVoxels({ shape: 'sphere', radius: 6 }).shell({ offset: -1.5 });
  const stack = sliceVoxels(body);
  const bytes = slicesToCli(stack, { date: '2026-07-18' });
  const back = slicesFromCli(bytes);

  assert.equal(back.unitsHeader, 1);
  assert.equal(back.date, '2026-07-18');
  assert.equal(back.slices.length, stack.slices.length, 'layer count');
  assert.equal(back.headerLayerCount, stack.slices.length);
  assert.deepEqual(back.warnings, [], `parser warnings: ${back.warnings.join('; ')}`);

  for (let i = 0; i < stack.slices.length; i++) {
    const source = stack.slices[i]!;
    const parsed = back.slices[i]!;
    assert.ok(Math.abs(parsed.z - source.z) < 1e-5, `layer ${i} z`);
    assert.equal(parsed.contours.length, source.contours.length, `layer ${i} contour count`);
    // The writer reorders (outer, inner, unknown) — compare as winding-keyed multisets.
    const sortKey = (c: SliceContour) => `${c.winding}:${c.points.length}:${c.points[0]!.toFixed(4)}`;
    const sortedSource = [...source.contours].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const sortedParsed = [...parsed.contours].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (let c = 0; c < sortedSource.length; c++) {
      const a = sortedSource[c]!;
      const b = sortedParsed[c]!;
      assert.equal(b.winding, a.winding, `layer ${i} contour ${c} winding`);
      assert.equal(b.points.length, a.points.length, `layer ${i} contour ${c} point count`);
      for (let p = 0; p < a.points.length; p++) {
        assert.ok(Math.abs(a.points[p]! - b.points[p]!) < 1e-5 + 1e-9, `layer ${i} contour ${c} point ${p}`);
      }
    }
  }
});

test('CLI units scaling writes divided coordinates and parses them back', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  const stack = sliceVoxels(sphere);
  const bytes = slicesToCli(stack, { units: 1000, date: '2026-07-18' }); // metres
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /\$\$UNITS\/1000/);
  const back = slicesFromCli(bytes);
  assert.equal(back.slices.length, stack.slices.length);
  const a = stack.slices[0]!.contours[0]!.points;
  const b = back.slices[0]!.contours[0]!.points;
  // 5-decimal CLI precision at units=1000 → 0.01mm resolution.
  for (let p = 0; p < a.length; p++) assert.ok(Math.abs(a[p]! - b[p]!) < 0.011, `point ${p}`);
});

test('empty-first-layer option adds the zero layer and bumps the header count', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  const stack = sliceVoxels(sphere);
  const bytes = slicesToCli(stack, { emptyFirstLayer: true, date: '2026-07-18' });
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /\$\$LAYER\/0\.0\n/);
  const back = slicesFromCli(bytes);
  assert.equal(back.headerLayerCount, stack.slices.length + 1, 'header counts the empty layer');
  assert.equal(back.slices.length, stack.slices.length, 'the z=0 layer parses away');
});

test('SVG: deterministic bytes, viewBox from bounds, one polyline per contour', () => {
  const body = pk.createVoxels({ shape: 'sphere', radius: 5 }).shell({ offset: -1.5 });
  const stack = sliceVoxels(body);
  const mid = stack.slices[Math.floor(stack.slices.length / 2)]!;

  const svg = sliceToSvg(mid);
  assert.equal(sliceToSvg(mid), svg, 'byte-identical across runs (locale-free numerics)');
  assert.match(svg, /^<\?xml version="1.0"/);
  assert.match(svg, /viewBox='/);
  const polylines = svg.match(/<polyline /g) ?? [];
  assert.equal(polylines.length, mid.contours.length);
  assert.match(svg, /stroke='black'/, 'outer contour styling');
  assert.match(svg, /stroke='blue'/, 'hole styling');

  const solid = sliceToSvg(mid, { solid: true });
  assert.match(solid, /<path d=' M/);
  assert.match(solid, /fill='black'/);
});

test('progress: monotonic 0→1, final call exactly 1 (slicing and CLI both)', () => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 4 });
  const fractions: number[] = [];
  const stack = sliceVoxels(sphere, { onProgress: (f) => fractions.push(f) });
  assert.ok(fractions.length > 3);
  for (let i = 1; i < fractions.length; i++) {
    assert.ok(fractions[i]! >= fractions[i - 1]!, `progress regressed at ${i}`);
  }
  assert.equal(fractions[fractions.length - 1], 1);
  assert.ok(fractions[0]! >= 0);

  const cliFractions: number[] = [];
  slicesToCli(stack, { date: '2026-07-18', onProgress: (f) => cliFractions.push(f) });
  assert.equal(cliFractions[cliFractions.length - 1], 1);
});

test('failure modes: empty voxels, empty stack, garbage bytes, binary flag', () => {
  const empty = pk.createVoxels({ shape: 'empty' });
  assert.throws(() => sliceVoxels(empty), /empty/);
  assert.throws(() => slicesToCli({ slices: [], bounds: { min: [0, 0, 0], max: [0, 0, 0] } }), PicoError);
  assert.throws(() => slicesFromCli(new TextEncoder().encode('not a cli file')), /valid header/);
  assert.throws(
    () => slicesFromCli(new TextEncoder().encode('$$HEADERSTART\n$$BINARY\n$$HEADEREND\n')),
    /Binary CLI/,
  );
});
