// Lattice wrapper. One addBeam signature (fixes upstream B3 — two C# overloads
// differing only in parameter order); roundCap defaults true (SG12).
//
// SK-0.3 — authoring is BATCHED. addBeam/addSphere used to cross the ABI once per
// element: HelixHeatX made 1,197,460 Lattice_AddBeam calls across 37 lattices, and
// even at the post-SK-0.2 direct-export cost (56.4 ns raw, 131.6 ns through this
// facade) that is the single hottest ABI site in the port. Elements now accumulate
// in a flat Float32Array and cross in ONE call per lattice (src/pico-bulk.cpp).
//
// Layout is dictated by the GPU upload seam, not by this file: 8 floats per beam,
// (x, y, z, radius) per endpoint — two vec4 lanes, 32 B stride, no padding under
// std140 or std430 — so `beams.subarray(0, beamCount * 8)` can go straight into
// writeBuffer with no repacking (harmonic architecture S-A/S-C, and the slab-binned
// access SK-0.4's tube-complex lane wants). Round-cap flags ride in a parallel
// Uint32Array because WGSL has no u8.
//
// The public API is unchanged: batching is internal, and the flush points are the
// three places the batch becomes observable — toVoxels(), memUsage, and the `handle`
// escape hatch (which is how voxels.withLattice reaches the lattice, so every
// consumer path is covered). No explicit flush() is exported; there is nothing a
// caller could do with one that reading `handle` does not already do.

import { adoptHandle, checkedMalloc, expectHandle, RENDER_LATTICE_EXPORT, type SessionContext } from './context.ts';
import { assertLive, guard, PicoError } from './errors.ts';
import type { Vec3 } from './types.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

/** Floats per staged beam: (x0, y0, z0, r0, x1, y1, z1, r1). */
const BEAM_FLOATS = 8;
/** Floats per staged sphere: (x, y, z, r) — one beam-endpoint lane. */
const SPHERE_FLOATS = 4;
/** First allocation, in elements; growth doubles from there. 8 KB of beams. */
const INITIAL_ELEMENTS = 256;

export interface AddBeamOptions {
  start: Vec3;
  end: Vec3;
  /** Uniform radius; or use startRadius/endRadius for a tapered beam. */
  radius?: number;
  startRadius?: number;
  endRadius?: number;
  /** Hemispherical end caps (SG12 default). */
  roundCap?: boolean;
}

export interface Lattice {
  addSphere(options: { center: Vec3; radius: number }): void;
  addBeam(options: AddBeamOptions): void;
  /** Renders the lattice into a fresh voxel field. */
  toVoxels(): Voxels;
  readonly memUsage: number;
  /** Raw ABI handle — escape hatch (§10). Flushes pending authoring first. */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed lattices. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function wrapLattice(ctx: SessionContext, handle: bigint): Lattice {
  let disposed = false;
  const live = () => {
    assertLive(disposed, 'Lattice');
    return handle;
  };

  // Beams and spheres are never staged at the same time: adding one kind flushes
  // the other first (below), so replay order into PicoGK is exactly call order.
  // That matters — a round-capped zero-length beam is turned into a SPHERE by
  // Lattice::AddBeam (PicoGKLattice.h:213-218), and src/shapekernel/latticePipe.ts
  // relies on it, so beams and spheres are not two independent streams.
  let beams = new Float32Array(0);
  let caps = new Uint32Array(0);
  let beamCount = 0;
  let spheres = new Float32Array(0);
  let sphereCount = 0;

  /** Reserves one element, doubling on demand. Returns its float offset. */
  const stageBeam = (): number => {
    const at = beamCount * BEAM_FLOATS;
    if (at === beams.length) {
      const grown = new Float32Array(Math.max(beams.length * 2, INITIAL_ELEMENTS * BEAM_FLOATS));
      grown.set(beams);
      beams = grown;
      const grownCaps = new Uint32Array(grown.length / BEAM_FLOATS);
      grownCaps.set(caps);
      caps = grownCaps;
    }
    beamCount += 1;
    return at;
  };

  const stageSphere = (): number => {
    const at = sphereCount * SPHERE_FLOATS;
    if (at === spheres.length) {
      const grown = new Float32Array(Math.max(spheres.length * 2, INITIAL_ELEMENTS * SPHERE_FLOATS));
      grown.set(spheres);
      spheres = grown;
    }
    sphereCount += 1;
    return at;
  };

  /**
   * Copies the staged block into wasm memory and crosses ONCE. The count is
   * cleared before the call so a throw cannot leave a batch that a later flush
   * would append a second time.
   */
  const flushBeams = () => {
    if (beamCount === 0) return;
    const floats = beamCount * BEAM_FLOATS;
    const count = beamCount;
    beamCount = 0;
    // One allocation: the 32 B-stride beam block, then the flag block after it.
    const pointer = checkedMalloc(ctx.module, floats * 4 + count * 4, 'the lattice beam batch');
    try {
      ctx.module.HEAPF32.set(beams.subarray(0, floats), pointer >>> 2);
      ctx.module.HEAPU32.set(caps.subarray(0, count), (pointer >>> 2) + floats);
      guard('Lattice_AddBeams', () => ctx.raw.Lattice_AddBeams(ctx.lib, handle, pointer, pointer + floats * 4, count))();
    } finally {
      ctx.module._free(pointer);
    }
  };

  const flushSpheres = () => {
    if (sphereCount === 0) return;
    const floats = sphereCount * SPHERE_FLOATS;
    const count = sphereCount;
    sphereCount = 0;
    const pointer = checkedMalloc(ctx.module, floats * 4, 'the lattice sphere batch');
    try {
      ctx.module.HEAPF32.set(spheres.subarray(0, floats), pointer >>> 2);
      guard('Lattice_AddSpheres', () => ctx.raw.Lattice_AddSpheres(ctx.lib, handle, pointer, count))();
    } finally {
      ctx.module._free(pointer);
    }
  };

  const flush = () => {
    flushSpheres();
    flushBeams();
  };

  const lattice = {
    addSphere({ center, radius }: { center: Vec3; radius: number }) {
      if (!(radius > 0)) {
        throw new PicoError('PICO_INVALID_ARGUMENT', `addSphere needs a positive radius in millimetres, got ${radius}.`);
      }
      live();
      flushBeams();
      const at = stageSphere();
      spheres[at] = center[0];
      spheres[at + 1] = center[1];
      spheres[at + 2] = center[2];
      spheres[at + 3] = radius;
    },
    addBeam({ start, end, radius, startRadius = radius, endRadius = radius, roundCap = true }: AddBeamOptions) {
      if (!(startRadius! > 0) || !(endRadius! > 0)) {
        throw new PicoError(
          'PICO_INVALID_ARGUMENT',
          'addBeam needs a positive radius (or startRadius/endRadius pair) in millimetres.',
        );
      }
      live();
      flushSpheres();
      const at = stageBeam();
      beams[at] = start[0];
      beams[at + 1] = start[1];
      beams[at + 2] = start[2];
      beams[at + 3] = startRadius!;
      beams[at + 4] = end[0];
      beams[at + 5] = end[1];
      beams[at + 6] = end[2];
      beams[at + 7] = endRadius!;
      caps[beamCount - 1] = roundCap ? 1 : 0;
    },
    toVoxels(): Voxels {
      live();
      flush();
      const target = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
      guard(RENDER_LATTICE_EXPORT, () => ctx.raw[RENDER_LATTICE_EXPORT](ctx.lib, target, handle))();
      return wrapVoxels(ctx, target);
    },
    get memUsage() {
      live();
      flush();
      return Number(guard('Lattice_nMemUsage', () => ctx.raw.Lattice_nMemUsage(ctx.lib, handle))());
    },
    get handle() {
      flush(); // dispose() empties the batch, so a disposed lattice flushes nothing
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      beamCount = 0;
      sphereCount = 0;
      ctx.registry.unregister(lattice); // D2
      if (!ctx.dead.value) ctx.raw.Lattice_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, lattice, handle, ctx.raw.Lattice_Destroy);
  return lattice as Lattice; // adoptHandle added [Symbol.dispose] (D6)
}
