// Binary STL, ported from upstream MeshIo.cs (45-301).
//
// Format: 80-byte header (PicoGK writes "PicoGK UNITS=xx" space-padded), uint32
// triangle count, then 50-byte records (normal + 3 vertices as float32, uint16
// attribute = 0). The UNITS= header convention makes round-trips unit-stable even
// though internal units are always mm. ASCII STLs are detected and rejected, as
// upstream does. Per-step float32 rounding (Math.fround) matches the C# math.

import { PicoError } from './errors.ts';
import {
  EXACT_LANE_SET,
  FAST_LANE_SET,
  findLaneToken,
  formatLaneToken,
  UNKNOWN_LANE_MEMBER,
  type LaneSet,
} from './lanes.ts';
import type { Vec3 } from './types.ts';

export type StlUnit = 'auto' | 'mm' | 'cm' | 'm' | 'ft' | 'in';

const UNIT_MULTIPLIER: Record<Exclude<StlUnit, 'auto'>, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  ft: 304.8,
  in: 25.4,
};

/** Header tokens exactly as upstream writes them (note ' m' for metres). */
const UNIT_HEADER: Record<Exclude<StlUnit, 'auto'>, string> = {
  mm: 'UNITS=mm',
  cm: 'UNITS=cm',
  m: 'UNITS= m',
  ft: 'UNITS=ft',
  in: 'UNITS=in',
};

export interface ToStlOptions {
  unit?: StlUnit;
  /** Scale applied while still in mm, after offset. */
  scale?: number;
  /** Offset in mm, applied first. */
  offset?: Vec3;
  /**
   * Acknowledges, for this one export, that the geometry has non-exact
   * provenance. Needed only where nothing else consented: in a session that
   * declared no lane (`'open'`) and in the session-less `meshToStlBytes`.
   * A `lane: 'fast'` (or `'auto'`) session already consented. Either way the
   * header records the lane set (`LANE=fast`).
   */
  acceptLane?: 'fast';
}

export interface FromStlOptions {
  /** 'auto' honours the UNITS= header, defaulting to mm. */
  unit?: StlUnit;
  /** Post-scale applied after unit conversion. */
  scale?: number;
  /** Post-offset in mm, applied last. */
  offset?: Vec3;
}

const fround = Math.fround;

/**
 * Serialises indexed geometry to binary STL bytes (deindexed, as the format is).
 *
 * This free function has no session, so no lane is declared for it — it keeps the `'open'`-session semantics. Passing
 * `lane: 'fast'` refuses with `PICO_LANE_EXPORT` unless `options.acceptLane`
 * is `'fast'`; an acknowledged export stamps `LANE=fast` into the 80-byte
 * header (read back by `meshFromStl`). `'exact'` or omitted writes the
 * historical header, byte for byte. The stamp is a best-effort audit, not a
 * security boundary: third-party tools rewrite STL headers.
 *
 * The bytes own a fresh, non-shared `ArrayBuffer`, so a caller can hand
 * them to a `Blob`, a transfer list or a file write without copying first.
 */
export function meshToStlBytes(
  vertices: Float32Array,
  triangles: Uint32Array,
  options: ToStlOptions = {},
  lane?: 'exact' | 'fast',
): Uint8Array<ArrayBuffer> {
  if (lane === 'fast' && options.acceptLane !== 'fast') {
    throw new PicoError(
      'PICO_LANE_EXPORT',
      "meshToStlBytes() with lane 'fast': the bytes may not match an exact build of the same model, and this " +
        'session-less call never consented to exporting them. Acknowledge with meshToStlBytes(vertices, triangles, ' +
        "{ acceptLane: 'fast' }, 'fast') " +
        "— the header records LANE=fast — or pass geometry replayed in a lane: 'exact' session.",
    );
  }
  return writeStlBytes(vertices, triangles, options, lane === 'fast' ? FAST_LANE_SET : EXACT_LANE_SET);
}

/** The STL writer itself; callers have already settled the export boundary for `provenance`. */
export function writeStlBytes(
  vertices: Float32Array,
  triangles: Uint32Array,
  options: ToStlOptions,
  provenance: LaneSet,
): Uint8Array<ArrayBuffer> {
  const { unit = 'mm', scale = 1, offset = [0, 0, 0] } = options;
  if (unit === 'auto') {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      "toStl unit 'auto' only applies when reading — pick a concrete unit.",
    );
  }
  const divider = UNIT_MULTIPLIER[unit];
  const triangleCount = triangles.length / 3;

  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  // The lane stamp only ever appears on non-exact exports, so every
  // byte-locked exact fixture keeps its exact historical header.
  const units = `PicoGK ${UNIT_HEADER[unit]}`;
  let stamp = provenance.length === 0 ? '' : ` ${formatLaneToken(provenance)}`;
  // ponytail: 80 bytes leave ~59 for members; only foreign tags can grow a set
  // past that, and it then stamps the reserved `unknown` — still fast-like.
  if (units.length + stamp.length > 80) stamp = ` ${formatLaneToken([UNKNOWN_LANE_MEMBER])}`;
  const header = `${units}${stamp}`.padEnd(80, ' ');
  for (let i = 0; i < 80; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, triangleCount, true);

  // C# TransformToUnit: v += offset; v *= scale; v /= divider — float32 each step.
  const transform = (value: number, axis: number): number =>
    fround(fround(fround(value + offset[axis]!) * scale) / divider);

  let out = 84;
  const corner = new Float64Array(9);
  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = triangles[t * 3 + c]! * 3;
      for (let axis = 0; axis < 3; axis++) {
        corner[c * 3 + axis] = transform(vertices[v + axis]!, axis);
      }
    }
    // Facet normal = normalize(cross(v2-v1, v3-v1)), as upstream computes it.
    const ux = corner[3]! - corner[0]!,
      uy = corner[4]! - corner[1]!,
      uz = corner[5]! - corner[2]!;
    const vx = corner[6]! - corner[0]!,
      vy = corner[7]! - corner[1]!,
      vz = corner[8]! - corner[2]!;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    view.setFloat32(out, nx, true);
    view.setFloat32(out + 4, ny, true);
    view.setFloat32(out + 8, nz, true);
    for (let i = 0; i < 9; i++) view.setFloat32(out + 12 + i * 4, corner[i]!, true);
    view.setUint16(out + 48, 0, true);
    out += 50;
  }
  return bytes;
}

/**
 * Parses binary STL bytes into deindexed geometry (3 vertices per triangle — the
 * format carries no indexing and upstream does not weld either).
 */
export function meshFromStlBytes(
  bytes: Uint8Array,
  options: FromStlOptions = {},
): { vertices: Float32Array; triangles: Uint32Array; provenance: LaneSet } {
  const { unit = 'auto', scale = 1, offset = [0, 0, 0] } = options;
  if (bytes.length < 84) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `STL too short: ${bytes.length} bytes cannot hold the 80-byte header + count.`,
    );
  }
  // One char per byte (Latin-1), so string indices ARE byte offsets.
  let rawHeader = '';
  for (let i = 0; i < 80; i++) rawHeader += String.fromCharCode(bytes[i]!);
  const header = rawHeader.trim();

  // ASCII detection exactly as upstream: 'solid' start + 'vertex' in the first 1KB.
  if (header.startsWith('solid')) {
    let peek = '';
    for (let i = 80; i < Math.min(bytes.length, 80 + 1024); i++) peek += String.fromCharCode(bytes[i]!);
    if (peek.includes('vertex')) {
      throw new PicoError(
        'PICO_INVALID_ARGUMENT',
        'This is an ASCII STL — only binary STL is supported (as upstream Pico). Re-export as binary.',
      );
    }
  }

  let effectiveUnit: Exclude<StlUnit, 'auto'> = 'mm';
  if (unit === 'auto') {
    // Case-fold ASCII letters only: toUpperCase() maps 'ß' (0xDF) to 'SS', and
    // that length change would shift the index onto the wrong bytes. This fold is length-preserving, so `at` indexes the bytes.
    const at = rawHeader.replace(/[a-z]/g, (letter) => letter.toUpperCase()).indexOf('UNITS=');
    if (at !== -1) {
      const value = rawHeader.slice(at + 'UNITS='.length);
      // Order matters: ' m' (metres, leading space) before 'mm' would never match mm.
      if (value.startsWith(' m')) effectiveUnit = 'm';
      else if (value.startsWith('mm')) effectiveUnit = 'mm';
      else if (value.startsWith('cm')) effectiveUnit = 'cm';
      else if (value.startsWith('ft')) effectiveUnit = 'ft';
      else if (value.startsWith('in')) effectiveUnit = 'in';
    }
  } else {
    effectiveUnit = unit;
  }
  const multiplier = UNIT_MULTIPLIER[effectiveUnit];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  if (triangleCount === 0) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      'Imported STL mesh is empty (zero triangles), failed to load.',
    );
  }
  if (bytes.length < 84 + triangleCount * 50) {
    throw new PicoError(
      'PICO_INVALID_ARGUMENT',
      `STL truncated: header claims ${triangleCount} triangles (${84 + triangleCount * 50} bytes) but only ${bytes.length} present.`,
    );
  }

  // C# TransformFromUnit: v *= multiplier; v *= scale; v += offset — float32 each step.
  const transform = (value: number, axis: number): number =>
    fround(fround(fround(value * multiplier) * scale) + offset[axis]!);

  const vertices = new Float32Array(triangleCount * 9);
  const triangles = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const record = 84 + t * 50;
    for (let c = 0; c < 3; c++) {
      for (let axis = 0; axis < 3; axis++) {
        vertices[t * 9 + c * 3 + axis] = transform(
          view.getFloat32(record + 12 + (c * 3 + axis) * 4, true),
          axis,
        );
      }
      triangles[t * 3 + c] = t * 3 + c;
    }
  }
  // Restore the stamped provenance set (anchored, case-exact token).
  return { vertices, triangles, provenance: findLaneToken(rawHeader) };
}
