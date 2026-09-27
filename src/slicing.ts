// picovoxel/slicing — manufacturing output (subpaths doc, Part 1).
//
// Ported from upstream Types/Slice.cs (marching squares + the partially-sorted
// greedy segment stitcher + winding detection, PolySlice.oFromSdf:293) and
// IO/Cli.cs (ASCII Common Layer Interface writer/parser, upstream is the
// compatibility oracle). Everything here is pure TypeScript driven by
// voxels.getSlice()/dimensions() — zero native touchpoints and zero dependencies.

import { PicoError } from './errors.ts';
import {
  EXACT_LANE_SET,
  findLaneToken,
  formatLaneToken,
  laneOf,
  unionLaneSets,
  type LaneSet,
} from './lanes.ts';
import type { Voxels } from './voxels.ts';

export type ContourWinding = 'ccw' | 'cw' | 'unknown';

export interface SliceContour {
  /** Flat [x0, y0, x1, y1, …] loop in mm; closed (last point equals the first). */
  points: Float64Array;
  /** Solid boundaries are CCW, holes CW (upstream contract). */
  winding: ContourWinding;
}

export interface Slice {
  /** Layer height position in mm (first layer at one layerHeight, as CLI wants). */
  z: number;
  contours: SliceContour[];
  /**
   * §14.1 value-class provenance of the sliced voxels (`'exact'` or absent = exact;
   * `sliceVoxels` and `slicesFromCli` always set it).
   * `sliceToSvg` stamps `'fast'` into the SVG's `<metadata>`.
   */
  lane?: 'exact' | 'fast';
}

export interface SliceStack {
  slices: Slice[];
  /** XY bounds over every contour + Z from first/last layer. */
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  /**
   * §14.1 value-class provenance (`'exact'` or absent = exact): `sliceVoxels` copies
   * `voxels.lane`, `slicesFromCli` restores it from the header stamp, and
   * `slicesToCli` stamps `'fast'` — manufacturing bytes are stamped, never
   * refused (LANES item 2).
   */
  lane?: 'exact' | 'fast';
}

export interface SliceVoxelsOptions {
  /** Layer height in mm; defaults to the session voxel size. */
  layerHeight?: number;
  /** Keep absolute XY coordinates instead of the bbox-relative default. */
  useAbsoluteXY?: boolean;
  /** Monotonic 0→1; final call is exactly 1. */
  onProgress?: (fraction: number) => void;
}

// ── Winding (PolyContour.eDetectWinding, Slice.cs:62-85) ────────────────────────

/** Signed-area winding detection over a flat point loop. */
export function detectWinding(points: ArrayLike<number>): ContourWinding {
  const count = points.length / 2;
  if (count < 3) return 'unknown';
  let area = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    area += (points[j * 2]! - points[i * 2]!) * (points[j * 2 + 1]! + points[i * 2 + 1]!);
  }
  if (area > 0) return 'cw';
  if (area < 0) return 'ccw';
  return 'unknown';
}

// ── Marching squares (PolySlice.oFromSdf, Slice.cs:293-490) ─────────────────────

// Edge LUT exactly as upstream: [edges crossed, seg1a, seg1b, seg2a, seg2b].
const EDGE_LUT: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, -1, -1, -1, -1],
  [9, 0, 3, -1, -1],
  [3, 1, 0, -1, -1],
  [10, 1, 3, -1, -1],
  [6, 2, 1, -1, -1],
  [15, 0, 1, 2, 3],
  [5, 2, 0, -1, -1],
  [12, 2, 3, -1, -1],
  [12, 3, 2, -1, -1],
  [5, 0, 2, -1, -1],
  [15, 3, 0, 1, 2],
  [6, 1, 2, -1, -1],
  [10, 3, 1, -1, -1],
  [3, 0, 1, -1, -1],
  [9, 3, 0, -1, -1],
  [0, -1, -1, -1, -1],
];

function zeroCrossing(a: number, b: number): number {
  // Small epsilon avoids division by zero, exactly as upstream.
  return Math.abs(a) / (Math.abs(a) + Math.abs(b)) + 1e-6;
}

interface Segment {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  minY: number;
  maxY: number;
  used: boolean;
}

export interface SdfImage {
  width: number;
  height: number;
  /** Row-major samples, negative inside. */
  data: ArrayLike<number>;
}

/**
 * Vectorizes one signed-distance slice image into closed contours. `scale` maps
 * image cells to mm (the voxel size); `offset` shifts the result in mm.
 */
export function contoursFromSdf(image: SdfImage, scale = 1, offsetX = 0, offsetY = 0): SliceContour[] {
  const { width, height, data } = image;
  if (width < 2 || height < 2) return [];
  const value = (x: number, y: number) => data[y * width + x]!;

  const segments: Segment[] = [];
  const crossings = new Float64Array(8); // 4 edge points, xy pairs

  for (let nY = 0; nY < height - 1; nY++) {
    for (let nX = 0; nX < width - 1; nX++) {
      // Flip the Y axis, as upstream does (image rows grow downward).
      const y0 = height - 1 - nY;
      const y1 = y0 - 1;
      const corners = [value(nX, y0), value(nX + 1, y0), value(nX + 1, y1), value(nX, y1)] as const;

      let lutIndex = 0;
      if (corners[0] < 0) lutIndex |= 1;
      if (corners[1] < 0) lutIndex |= 2;
      if (corners[2] < 0) lutIndex |= 4;
      if (corners[3] < 0) lutIndex |= 8;

      const entry = EDGE_LUT[lutIndex]!;
      const edgesCrossed = entry[0];
      if (edgesCrossed === 0) continue;

      if (edgesCrossed & 1) {
        crossings[0] = nX + zeroCrossing(corners[0], corners[1]);
        crossings[1] = nY;
      }
      if (edgesCrossed & 2) {
        crossings[2] = nX + 1;
        crossings[3] = nY + zeroCrossing(corners[1], corners[2]);
      }
      if (edgesCrossed & 4) {
        crossings[4] = nX + zeroCrossing(corners[3], corners[2]);
        crossings[5] = nY + 1;
      }
      if (edgesCrossed & 8) {
        crossings[6] = nX;
        crossings[7] = nY + zeroCrossing(corners[0], corners[3]);
      }

      for (let s = 1; s < 5; s += 2) {
        const a = entry[s]!;
        if (a < 0) break;
        const b = entry[s + 1]!;
        const sx = offsetX + scale * crossings[a * 2]!;
        const sy = offsetY + scale * crossings[a * 2 + 1]!;
        const ex = offsetX + scale * crossings[b * 2]!;
        const ey = offsetY + scale * crossings[b * 2 + 1]!;
        segments.push({ sx, sy, ex, ey, minY: Math.min(sy, ey), maxY: Math.max(sy, ey), used: false });
      }
    }
  }

  // Stitch the (partially Y-sorted) segment soup into contours — the upstream
  // greedy stitcher with its windowed search, ported verbatim.
  const contours: SliceContour[] = [];
  let segmentsLeft = segments.length;
  let currStart = -1;
  let currEnd = -1;
  let unused = 0;
  let chain: number[] = []; // xy pairs; grows at both ends via unshift/push

  const sqr = (dx: number, dy: number) => dx * dx + dy * dy;

  const finishContour = () => {
    if (chain.length / 2 > 2) {
      const points = new Float64Array(chain);
      contours.push({ points, winding: detectWinding(points) });
    }
    chain = [];
    currStart = currEnd = -1;
  };

  while (segmentsLeft > 0) {
    if (currStart < 0) {
      currStart = -1;
      for (let n = unused; n < segments.length; n++) {
        if (!segments[n]!.used) {
          currStart = n;
          break;
        }
      }
      currEnd = currStart;
      unused = currStart + 1;
      const seed = segments[currStart]!;
      chain.push(seed.sx, seed.sy, seed.ex, seed.ey);
      seed.used = true;
      segmentsLeft--;
    }

    const start = segments[currStart]!;
    const end = segments[currEnd]!;
    let bestStart = -1;
    let bestEnd = -1;
    let bestSqrStart = 1;
    let bestSqrEnd = 1;

    if (currEnd !== currStart) {
      const closing = sqr(start.sx - end.ex, start.sy - end.ey);
      if (closing < 1) {
        bestSqrEnd = bestSqrStart = closing;
        bestStart = currEnd;
        bestEnd = currStart;
      }
    }

    const windowMin = Math.floor(Math.min(start.minY, end.minY)) - 1;
    const windowMax = Math.ceil(Math.max(start.maxY, end.maxY)) + 1;

    let searchFrom = Math.min(currStart, currEnd);
    while (searchFrom > 0 && segments[searchFrom - 1]!.maxY >= windowMin) searchFrom--;

    for (let n = searchFrom; n < segments.length; n++) {
      const candidate = segments[n]!;
      if (candidate.used) continue;
      if (candidate.minY > windowMax) break;

      const toStart = sqr(start.sx - candidate.ex, start.sy - candidate.ey);
      if (toStart < bestSqrStart) {
        bestSqrStart = toStart;
        bestStart = n;
      }
      const toEnd = sqr(end.ex - candidate.sx, end.ey - candidate.sy);
      if (toEnd < bestSqrEnd) {
        bestSqrEnd = toEnd;
        bestEnd = n;
      }
    }

    if (bestEnd < 0 && bestStart < 0) {
      // Nothing connects — an open fragment; upstream discards it.
      chain = [];
      currStart = currEnd = -1;
    } else if (bestStart === bestEnd || bestStart === currEnd || bestEnd === currStart) {
      /* v8 ignore next 4 -- the same-segment closure needs a two-segment loop,
         which marching squares cannot emit (minimum four segments per cell ring);
         kept because the upstream stitcher guards it for adversarial soups */
      if (bestStart === bestEnd) {
        segments[bestEnd]!.used = true;
        segmentsLeft--;
      }
      finishContour();
    } else {
      if (bestEnd >= 0) {
        const seg = segments[bestEnd]!;
        chain.push(seg.ex, seg.ey);
        seg.used = true;
        segmentsLeft--;
        currEnd = bestEnd;
      }
      if (bestStart >= 0) {
        const seg = segments[bestStart]!;
        chain.unshift(seg.sx, seg.sy);
        seg.used = true;
        segmentsLeft--;
        currStart = bestStart;
      }
    }
  }

  // Close every contour (Slice.cs Close(): last point equals first). Stitched
  // chains always stop one joint short of the seed — closure is DETECTED, never
  // appended — so the loop unconditionally needs its first point repeated.
  return contours.map(({ points, winding }) => {
    const closed = new Float64Array(points.length + 2);
    closed.set(points);
    closed[points.length] = points[0]!;
    closed[points.length + 1] = points[1]!;
    return { points: closed, winding };
  });
}

// ── The driver (Voxels.oVectorize, Cli.cs:787-868) ──────────────────────────────

/** Vectorizes a voxel field slice-by-slice via interpolated Z slices. */
export function sliceVoxels(voxels: Voxels, options: SliceVoxelsOptions = {}): SliceStack {
  const { onProgress } = options;
  const dims = voxels.dimensions();
  const [nx, ny, nz] = dims.size;
  const origin = voxels.sliceOrigin(0);
  const voxelSize = nz > 0 ? voxelSizeOf(voxels) : 1;

  const layerHeight = options.layerHeight ?? voxelSize;
  if (!(layerHeight > 0)) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `layerHeight must be positive millimetres, got ${layerHeight}.`,
    );
  }
  const zStep = layerHeight / voxelSize;

  const offsetX = options.useAbsoluteXY ? dims.origin[0] * voxelSize : 0;
  const offsetY = options.useAbsoluteXY ? dims.origin[1] * voxelSize : 0;
  void origin;

  const slices: Slice[] = [];
  const lastLayer = nz - 1;
  let fZ = 0;
  let layerZ = layerHeight;

  while (fZ <= lastLayer) {
    onProgress?.(fZ / nz);
    const image = voxels.getSlice({ z: fZ, interpolated: true });
    fZ += zStep;

    const contours = contoursFromSdf(
      { width: nx, height: ny, data: image.data },
      voxelSize,
      offsetX,
      offsetY,
    );
    if (slices.length === 0 && contours.length === 0) {
      continue; // skip empty layers until the first filled one (layerZ stays put)
    }
    slices.push({ z: layerZ, contours, lane: voxels.lane });
    layerZ += layerHeight;
  }

  if (slices.length === 0) {
    throw new PicoError('PICO_INVALID_ARGUMENT', 'Voxel field is empty — nothing to slice.');
  }
  while (slices.length > 0 && slices[slices.length - 1]!.contours.length === 0) slices.pop();
  onProgress?.(1);

  return { slices, bounds: stackBounds(slices), lane: voxels.lane };
}

/**
 * Session voxel size recovered from slice-origin spacing (avoids a facade
 * dependency). Callers guard nz > 0, and adjacent slice origins always differ
 * by exactly one voxel, so the spacing is never zero.
 */
function voxelSizeOf(voxels: Voxels): number {
  const a = voxels.sliceOrigin(0);
  const b = voxels.sliceOrigin(1);
  return Math.abs(b[2] - a[2]);
}

function stackBounds(slices: Slice[]): SliceStack['bounds'] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const slice of slices) {
    for (const contour of slice.contours) {
      const points = contour.points;
      for (let i = 0; i < points.length; i += 2) {
        const x = points[i]!;
        const y = points[i + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const zMin = 0;
  const zMax = slices.length > 0 ? slices[slices.length - 1]!.z : 0;
  return { min: [minX, minY, zMin], max: [maxX, maxY, zMax] };
}

// ── SVG (PolySlice.SaveToSvgFile / AsSvgPath, Slice.cs:144-291) ─────────────────

export interface ToSvgOptions {
  /** Filled single-path rendering (holes via winding) instead of stroked outlines. */
  solid?: boolean;
  strokeWidth?: number;
  /** Override the viewBox [minX, minY, width, height]; defaults to slice bounds. */
  viewBox?: readonly [number, number, number, number];
}

/**
 * Renders one slice as a standalone SVG document string. Deterministic output.
 * A `'fast'` slice carries `<metadata>PicoVoxel LANE=fast</metadata>` (the
 * `slicesToCli` token grammar); exact slices render the historical bytes.
 */
export function sliceToSvg(slice: Slice, options: ToSvgOptions = {}): string {
  const { solid = false, strokeWidth = 0.1 } = options;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const contour of slice.contours) {
    for (let i = 0; i < contour.points.length; i += 2) {
      minX = Math.min(minX, contour.points[i]!);
      maxX = Math.max(maxX, contour.points[i]!);
      minY = Math.min(minY, contour.points[i + 1]!);
      maxY = Math.max(maxY, contour.points[i + 1]!);
    }
  }
  const [vx, vy, vw, vh] = options.viewBox ?? [minX, minY, maxX - minX, maxY - minY];

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" ?>');
  lines.push(
    `<svg xmlns='http://www.w3.org/2000/svg' version='1.1' viewBox='${vx} ${vy} ${vw} ${vh}' width='${vw}mm' height='${vh}mm'>`,
  );
  if (slice.lane === 'fast') lines.push(`<metadata>${LANE_STAMP}</metadata>`);
  lines.push('<g>');
  if (solid) {
    let path = "<path d='";
    for (let pass = 0; pass < 2; pass++) {
      for (const contour of slice.contours) {
        if (pass === 0 ? contour.winding !== 'ccw' : contour.winding === 'ccw') continue;
        let d = '';
        for (let i = 0; i < contour.points.length; i += 2) {
          d += `${i === 0 ? ' M' : ' L'}${contour.points[i]},${contour.points[i + 1]}`;
        }
        path += `${d} Z`;
      }
    }
    lines.push(`${path}' fill='black'/>`);
  } else {
    for (const contour of slice.contours) {
      let points = '';
      for (let i = 0; i < contour.points.length; i += 2) {
        points += ` ${contour.points[i]},${contour.points[i + 1]}`;
      }
      const stroke = contour.winding === 'cw' ? 'blue' : contour.winding === 'ccw' ? 'black' : 'red';
      lines.push(
        `<polyline points='${points}' stroke='${stroke}' fill='none' stroke-width='${strokeWidth}' />`,
      );
    }
  }
  lines.push('</g>');
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

// ── CLI writer (CliIo.WriteSlicesToCliFile, Cli.cs:129-249) ─────────────────────

export interface ToCliOptions {
  /** Units in mm per CLI unit (1 = mm, upstream default). */
  units?: number;
  /** Emit an intentionally-empty first layer so readers can infer layer height. */
  emptyFirstLayer?: boolean;
  /** Header date string; defaults to today (pass a fixed one for reproducible bytes). */
  date?: string;
  onProgress?: (fraction: number) => void;
}

const WINDING_TO_CLI: Record<ContourWinding, number> = { cw: 0, ccw: 1, unknown: 2 };

/**
 * LANES item 2 — the provenance stamp for slice artifacts: the STL header's
 * `LANE=<set>` token (`./lanes.ts`) after a `PicoVoxel` marker. In CLI it
 * rides a `// … //` remark line inside `$$HEADERSTART … $$HEADEREND` — CLI
 * v2.0 §3.1.1 defines `// text //` as a comment and its own §4 example puts
 * remark lines in the header — so readers that follow the spec (upstream
 * PicoGK's included) skip it and no command changes. Exact stacks carry no
 * remark, so exact CLI bytes are unchanged.
 */
const LANE_STAMP = `PicoVoxel ${formatLaneToken(['fast'])}`;

function formatDimension(value: number): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  const [integer, fraction] = magnitude.toFixed(5).split('.') as [string, string];
  return `${sign}${integer.padStart(8, '0')}.${fraction}`;
}

/** Serialises a slice stack to ASCII CLI bytes. */
export function slicesToCli(stack: SliceStack, options: ToCliOptions = {}): Uint8Array {
  const { units = 1, emptyFirstLayer = false, onProgress } = options;
  if (stack.slices.length < 1) {
    throw new PicoError('PICO_INVALID_ARGUMENT', 'No valid slices detected (empty stack).');
  }
  if (!(units > 0)) {
    throw new PicoError('PICO_INVALID_ARGUMENT', `units must be positive mm per CLI unit, got ${units}.`);
  }
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push('$$HEADERSTART');
  lines.push('$$ASCII');
  lines.push(`$$UNITS/${units}`);
  lines.push('$$VERSION/200');
  lines.push('$$LABEL/1,default');
  lines.push(`$$DATE/${date}`);
  lines.push(
    `$$DIMENSION/${formatDimension(stack.bounds.min[0])},${formatDimension(stack.bounds.min[1])},${formatDimension(0)},` +
      `${formatDimension(stack.bounds.max[0])},${formatDimension(stack.bounds.max[1])},${formatDimension(stack.slices[stack.slices.length - 1]!.z)}`,
  );
  lines.push(`$$LAYERS/${String(stack.slices.length + (emptyFirstLayer ? 1 : 0)).padStart(5, '0')}`);
  // LUB: a hand-assembled stack is fast if its stack claim or any slice is.
  if (stack.lane === 'fast' || stack.slices.some((slice) => slice.lane === 'fast'))
    lines.push(`// ${LANE_STAMP} //`);
  lines.push('$$HEADEREND');
  lines.push('$$GEOMETRYSTART');
  if (emptyFirstLayer) lines.push('$$LAYER/0.0');

  stack.slices.forEach((slice, index) => {
    onProgress?.(index / stack.slices.length);
    lines.push(`$$LAYER/${(slice.z / units).toFixed(5)}`);
    // Outer (ccw) first, inner (cw) second, unknown last — upstream pass order.
    for (const want of ['ccw', 'cw', 'unknown'] as const) {
      for (const contour of slice.contours) {
        if (contour.winding !== want) continue;
        const count = contour.points.length / 2;
        let line = `$$POLYLINE/1,${WINDING_TO_CLI[contour.winding]},${count}`;
        for (let i = 0; i < contour.points.length; i += 2) {
          line += `,${(contour.points[i]! / units).toFixed(5)},${(contour.points[i + 1]! / units).toFixed(5)}`;
        }
        lines.push(line);
      }
    }
  });
  lines.push('$$GEOMETRYEND');
  onProgress?.(1);

  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// ── CLI parser (CliIo.oSlicesFromCliFile, Cli.cs:258-745) ───────────────────────

export interface FromCliResult extends SliceStack {
  unitsHeader: number;
  date: string;
  headerLayerCount: number;
  warnings: string[];
}

/** Parses ASCII CLI bytes back into a slice stack. Tolerant of header variants. */
export function slicesFromCli(
  bytes: Uint8Array,
  options: { onProgress?: (fraction: number) => void } = {},
): FromCliResult {
  const text = new TextDecoder().decode(bytes);
  const warnings: string[] = [];
  let units = 0;
  let date = '';
  let headerLayerCount = 0;
  let label = -1;
  let provenance: LaneSet = EXACT_LANE_SET;

  const fail = (message: string): never => {
    throw new PicoError('PICO_INVALID_ARGUMENT', `CLI parse: ${message}`);
  };

  // Parameter extraction exactly as upstream bExtractParameter (Cli.cs:747-768).
  const extract = (state: { line: string }): string | null => {
    if (state.line.startsWith('/') || state.line.startsWith(',')) {
      state.line = state.line.slice(1);
    } else {
      return null;
    }
    const end = state.line.search(/[$/,]/);
    const param = end === -1 ? state.line : state.line.slice(0, end);
    state.line = state.line.slice(param.length);
    return param;
  };
  const extractFloat = (state: { line: string }, what: string): number => {
    const param = extract(state) ?? fail(`Missing parameter after ${what}`);
    const value = Number.parseFloat(param);
    if (!Number.isFinite(value)) fail(`Invalid parameter for ${what}: ${param}`);
    return value;
  };

  const rawLines = text.split(/\r?\n/);
  let lineIndex = 0;

  // ── Header ──
  let headerStarted = false;
  let headerEnded = false;
  for (; lineIndex < rawLines.length && !headerEnded; lineIndex++) {
    let line = rawLines[lineIndex]!.trim();
    if (line.startsWith('//')) {
      // A remark line; inside the header it may carry the provenance stamp.
      if (headerStarted)
        provenance = unionLaneSets(provenance, findLaneToken(line.slice(2).replace(/\/\/$/, '')));
      continue;
    }
    if (!headerStarted) {
      const at = line.indexOf('$$HEADERSTART');
      if (at === -1) continue;
      headerStarted = true;
      line = line.slice(at + '$$HEADERSTART'.length).trim();
      if (line === '') continue;
    }
    if (!line.startsWith('$$')) continue;
    if (line.startsWith('$$BINARY')) fail('Binary CLI files are not supported');
    if (line.startsWith('$$UNITS')) {
      const state = { line: line.slice('$$UNITS'.length) };
      units = extractFloat(state, '$$UNITS');
      if (units <= 0) fail(`Invalid parameter for $$UNITS: ${units}`);
    } else if (line.startsWith('$$LABEL')) {
      const state = { line: line.slice('$$LABEL'.length) };
      if (label !== -1) fail('Multiple labels/objects in one CLI file are not supported');
      label = extractFloat(state, '$$LABEL');
    } else if (line.startsWith('$$DATE')) {
      const state = { line: line.slice('$$DATE'.length) };
      date = (extract(state) ?? '').trim();
    } else if (line.startsWith('$$LAYERS')) {
      const state = { line: line.slice('$$LAYERS'.length) };
      headerLayerCount = extractFloat(state, '$$LAYERS');
    } else if (line.startsWith('$$DIMENSION')) {
      const state = { line: line.slice('$$DIMENSION'.length) };
      for (let i = 0; i < 6; i++) extractFloat(state, '$$DIMENSION');
    } else if (line.startsWith('$$HEADEREND')) {
      headerEnded = true;
    }
    // $$ASCII, $$VERSION, $$ALIGN and unknown header commands are tolerated.
  }
  if (!headerEnded) fail('End of file while searching for a valid header');
  if (units <= 0) fail('Header carries no usable $$UNITS');

  // ── Geometry ──
  const slices: Slice[] = [];
  let current: Slice | null = null;
  let geometryStarted = false;
  let previousZ = Number.NEGATIVE_INFINITY;

  for (; lineIndex < rawLines.length; lineIndex++) {
    options.onProgress?.(lineIndex / rawLines.length);
    const line = rawLines[lineIndex]!.trim();
    if (line === '' || line.startsWith('//')) continue;
    if (!geometryStarted) {
      if (line.includes('$$GEOMETRYSTART')) geometryStarted = true;
      continue;
    }
    if (line.startsWith('$$LAYER/')) {
      const state = { line: line.slice('$$LAYER'.length) };
      const z = extractFloat(state, '$$LAYER') * units;
      if (previousZ !== Number.NEGATIVE_INFINITY && z < previousZ) {
        fail(`Z position ${z} is smaller than the previous layer's ${previousZ}`);
      }
      previousZ = Math.max(previousZ, z);
      if (z > 0) {
        if (current) slices.push(current);
        current = { z, contours: [] };
      }
    } else if (line.startsWith('$$POLYLINE')) {
      if (!current) fail('There should not be contours at z position 0');
      const state = { line: line.slice('$$POLYLINE'.length) };
      const id = extractFloat(state, '$$POLYLINE id');
      if (label === -1) label = id;
      if (id !== label) fail('CLI labels / multiple models are not supported');
      const windingCode = extractFloat(state, '$$POLYLINE direction');
      const declared: ContourWinding = windingCode === 0 ? 'cw' : windingCode === 1 ? 'ccw' : 'unknown';
      if (windingCode !== 0 && windingCode !== 1 && windingCode !== 2) {
        fail(`Invalid $$POLYLINE direction: ${windingCode}`);
      }
      const count = extractFloat(state, '$$POLYLINE count');
      const points = new Float64Array(count * 2);
      for (let i = 0; i < count; i++) {
        points[i * 2] = extractFloat(state, '$$POLYLINE vertex X') * units;
        points[i * 2 + 1] = extractFloat(state, '$$POLYLINE vertex Y') * units;
      }
      if (count < 3) {
        warnings.push(`Line ${lineIndex + 1}: discarding degenerate POLYLINE with ${count} vertices`);
        continue;
      }
      const actual = detectWinding(points);
      if (actual === 'unknown') {
        warnings.push(`Line ${lineIndex + 1}: discarding POLYLINE with area 0 (degenerate)`);
        continue;
      }
      if (actual !== declared) {
        warnings.push(`Line ${lineIndex + 1}: POLYLINE declared ${declared} but is ${actual} (using actual)`);
      }
      current!.contours.push({ points, winding: actual });
    } else if (line.startsWith('$$GEOMETRYEND')) {
      break;
    } else if (line.startsWith('$$')) {
      warnings.push(`Line ${lineIndex + 1}: unsupported command ${line.slice(0, 20)}`);
    }
  }
  if (current) slices.push(current);
  options.onProgress?.(1);

  const lane = laneOf(provenance);
  for (const slice of slices) slice.lane = lane;
  return { slices, bounds: stackBounds(slices), lane, unitsHeader: units, date, headerLayerCount, warnings };
}
