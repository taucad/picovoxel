// Lattice wrapper. One addBeam signature (fixes upstream B3 — two C# overloads
// differing only in parameter order); roundCap defaults true (SG12).

import { adoptHandle, expectHandle, VEC3_BYTES, type SessionContext } from './context.ts';
import { assertLive, guard, PicoGkError } from './errors.ts';
import type { Vec3 } from './types.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

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
  /** Raw ABI handle — escape hatch (§10). */
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

  const lattice = {
    addSphere({ center, radius }: { center: Vec3; radius: number }) {
      if (!(radius > 0)) {
        throw new PicoGkError('PICOGK_INVALID_ARGUMENT', `addSphere needs a positive radius in millimetres, got ${radius}.`);
      }
      ctx.writeVec3(ctx.scratch, center);
      guard('Lattice_AddSphere', () => ctx.raw.Lattice_AddSphere(ctx.lib, live(), ctx.scratch, radius))();
    },
    addBeam({ start, end, radius, startRadius = radius, endRadius = radius, roundCap = true }: AddBeamOptions) {
      if (!(startRadius! > 0) || !(endRadius! > 0)) {
        throw new PicoGkError(
          'PICOGK_INVALID_ARGUMENT',
          'addBeam needs a positive radius (or startRadius/endRadius pair) in millimetres.',
        );
      }
      ctx.writeVec3(ctx.scratch, start);
      ctx.writeVec3(ctx.scratch + VEC3_BYTES, end);
      guard('Lattice_AddBeam', () =>
        ctx.raw.Lattice_AddBeam(ctx.lib, live(), ctx.scratch, ctx.scratch + VEC3_BYTES, startRadius!, endRadius!, roundCap),
      )();
    },
    toVoxels(): Voxels {
      const target = expectHandle('Voxels_hCreate', ctx.raw.Voxels_hCreate(ctx.lib));
      guard('Voxels_RenderLattice', () => ctx.raw.Voxels_RenderLattice(ctx.lib, target, live()))();
      return wrapVoxels(ctx, target);
    },
    get memUsage() {
      return Number(guard('Lattice_nMemUsage', () => ctx.raw.Lattice_nMemUsage(ctx.lib, live()))());
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.registry.unregister(lattice); // D2
      if (!ctx.dead.value) ctx.raw.Lattice_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, lattice, handle, ctx.raw.Lattice_Destroy);
  return lattice as Lattice; // adoptHandle added [Symbol.dispose] (D6)
}
