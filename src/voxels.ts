// Voxels wrapper. PicoGK's booleans and offsets mutate the receiver in the ABI
// (SG11) — every derived op copies first via Voxels_hCreateCopy so the fluent form
// is pure and `a.subtract(b)` never silently destroys `a`.

import { adoptHandle, expectHandle, type SessionContext } from './context.ts';
import { assertLive, guard, PicoGkError } from './errors.ts';
import { wrapMesh, type Mesh } from './mesh.ts';

export interface Voxels {
  /** Pure union with `other`; both operands are unchanged. */
  add(other: Voxels): Voxels;
  /** Pure subtraction of `other`; both operands are unchanged. */
  subtract(other: Voxels): Voxels;
  /** Pure intersection with `other`; both operands are unchanged. */
  intersect(other: Voxels): Voxels;
  /** Pure surface offset: positive grows, negative shrinks. */
  offset(options: { distance: number }): Voxels;
  /** Volume in cubic millimetres. */
  readonly volume: number;
  toMesh(): Mesh;
  /** Raw ABI handle — escape hatch (§10). */
  readonly handle: bigint;
  /** Optional: GC reclaims un-disposed voxels. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function wrapVoxels(ctx: SessionContext, handle: bigint): Voxels {
  let disposed = false;
  const live = () => {
    assertLive(disposed, 'Voxels');
    return handle;
  };

  /** Copy-first derivation (SG11): clone, mutate the clone, wrap the clone. */
  const derive = (name: string, mutate: (copy: bigint) => void): Voxels => {
    const copy = expectHandle('Voxels_hCreateCopy', ctx.raw.Voxels_hCreateCopy(ctx.lib, live()));
    guard(name, mutate)(copy);
    return wrapVoxels(ctx, copy);
  };

  const voxels = {
    add: (other: Voxels) => derive('Voxels_BoolAdd', (copy) => ctx.raw.Voxels_BoolAdd(ctx.lib, copy, other.handle)),
    subtract: (other: Voxels) =>
      derive('Voxels_BoolSubtract', (copy) => ctx.raw.Voxels_BoolSubtract(ctx.lib, copy, other.handle)),
    intersect: (other: Voxels) =>
      derive('Voxels_BoolIntersect', (copy) => ctx.raw.Voxels_BoolIntersect(ctx.lib, copy, other.handle)),
    offset({ distance }: { distance: number }) {
      if (!Number.isFinite(distance)) {
        throw new PicoGkError(
          'PICOGK_INVALID_ARGUMENT',
          `offset({ distance }) needs a finite number of millimetres, got ${distance}. Negative shells inward.`,
        );
      }
      return derive('Voxels_Offset', (copy) => ctx.raw.Voxels_Offset(ctx.lib, copy, distance));
    },
    get volume() {
      return guard('Voxels_fCalculateVolume', () => ctx.raw.Voxels_fCalculateVolume(ctx.lib, live()))();
    },
    toMesh() {
      return wrapMesh(
        ctx,
        expectHandle('Mesh_hCreateFromVoxels', guard('Mesh_hCreateFromVoxels', () => ctx.raw.Mesh_hCreateFromVoxels(ctx.lib, live()))()),
      );
    },
    get handle() {
      return handle;
    },
    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.registry.unregister(voxels); // D2
      if (!ctx.dead.value) ctx.raw.Voxels_Destroy(ctx.lib, handle); // D4
    },
  };
  adoptHandle(ctx, voxels, handle, ctx.raw.Voxels_Destroy);
  return voxels as Voxels; // adoptHandle added [Symbol.dispose] (D6)
}
