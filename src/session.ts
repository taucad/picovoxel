// createPicoGK — the session factory (library-api-policy):
//   §1 factories over classes; §3 flat options; §4 one options object per method;
//   §9 lazy init (wasm instantiates on the awaited factory call); §10 escape hatches.
//
// Handles stay BigInt internally and never require consumer management: wrappers are
// GC-reclaimed via the FinalizationRegistry; dispose() is the optional escape hatch;
// session.dispose() is the deterministic full teardown.

import { bindRaw } from './bindings.ts';
import {
  adoptHandle,
  BBOX_BYTES,
  createMemoryWarning,
  expectHandle,
  INFO_STRING_BYTES,
  VEC3_BYTES,
  withSdfPointer,
  type SessionContext,
} from './context.ts';
import { PicoGkError, assertLive, guard } from './errors.ts';
import { wrapMesh, type Mesh } from './mesh.ts';
import createPicoGKModuleUntyped from './picogk.mjs';
import { createHandleRegistry, type HandleRegistry } from './registry.ts';
import type { PicoGkWasmModule, SdfFunction, Vec3 } from './types.ts';
import { wrapVoxels, type Voxels } from './voxels.ts';

const createPicoGKModule = createPicoGKModuleUntyped as (overrides?: object) => Promise<PicoGkWasmModule>;

const COUNTERS = ['Voxels', 'Meshes', 'Lattices', 'PolyLines', 'ScalarFields', 'VectorFields', 'VdbFiles', 'VdbMetas'] as const;
type CounterName = (typeof COUNTERS)[number];

export type CreateVoxelsOptions =
  | { shape: 'sphere'; center?: Vec3; radius: number }
  | { shape: 'capsule'; start: Vec3; end: Vec3; radius: number }
  | { shape: 'implicit'; boundsMin: Vec3; boundsMax: Vec3; sdf: SdfFunction };

export interface CreatePicoGkOptions {
  /** Voxel edge length in millimetres. Cost scales cubically as it shrinks. */
  voxelSize?: number;
  /** Emscripten Module overrides (e.g. locateFile) forwarded to instantiation. */
  wasm?: object;
  /** Native-memory warning threshold in bytes (default 1 GiB); 0 disables. */
  memoryWarningBytes?: number;
  /** @internal test seam — fake disposal registry. */
  registry?: HandleRegistry;
  /** @internal test seam — clock for the warning throttle. */
  now?: () => number;
}

export interface PicoGK {
  readonly voxelSize: number;
  readonly name: string;
  readonly version: string;
  readonly buildInfo: string;
  createVoxels(options: CreateVoxelsOptions): Voxels;
  /** Builds a mesh directly from vertex/triangle data — no voxels involved. */
  createMesh(options: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): Mesh;
  /** PicoGK's own per-type allocation counters — the leak oracle. */
  readonly allocated: Record<CounterName, number>;
  /** §10 escape hatch: the raw Emscripten module. */
  readonly module: PicoGkWasmModule;
  /** §10 escape hatch: the raw Library handle. */
  readonly handle: bigint;
  /** Deterministic teardown: frees every object this session owns. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Creates a PicoGK session. Resolves once the wasm module is instantiated. */
export async function createPicoGK(options: CreatePicoGkOptions = {}): Promise<PicoGK> {
  const { voxelSize = 0.5, wasm, memoryWarningBytes = 2 ** 30, registry, now } = options;

  if (!(voxelSize > 0) || !Number.isFinite(voxelSize)) {
    throw new PicoGkError(
      'PICOGK_INVALID_ARGUMENT',
      `voxelSize must be a positive number of millimetres, got ${voxelSize}. ` +
        'Cost scales cubically as it shrinks — 0.5 is a reasonable default.',
    );
  }

  let module: PicoGkWasmModule;
  try {
    module = await createPicoGKModule(typeof wasm === 'object' && wasm !== null ? wasm : {});
  } catch (cause) {
    throw new PicoGkError(
      'PICOGK_WASM_INIT_FAILED',
      'PicoGK WebAssembly failed to instantiate. Check that picogk.wasm is served next to picogk.mjs ' +
        'and that it is returned with Content-Type: application/wasm.',
      { cause },
    );
  }

  const raw = bindRaw(module);
  const lib = expectHandle('Library_hCreateInstance', raw.Library_hCreateInstance(voxelSize));

  const scratch = module._malloc(Math.max(BBOX_BYTES, INFO_STRING_BYTES));
  const ctx: SessionContext = {
    module,
    lib,
    voxelSize,
    raw,
    registry: registry ?? createHandleRegistry(),
    dead: { value: false },
    scratch,
    writeVec3(pointer, [x, y, z]) {
      module.HEAPF32[(pointer >> 2) + 0] = x;
      module.HEAPF32[(pointer >> 2) + 1] = y;
      module.HEAPF32[(pointer >> 2) + 2] = z;
    },
    readVec3(pointer) {
      return [module.HEAPF32[pointer >> 2]!, module.HEAPF32[(pointer >> 2) + 1]!, module.HEAPF32[(pointer >> 2) + 2]!];
    },
    maybeWarnMemory: createMemoryWarning({
      memoryWarningBytes,
      now: now ?? (() => Date.now()),
      totalMemUsage: () => raw.Library_nTotalMemUsage(lib),
    }),
  };

  const rawAllocated = Object.fromEntries(
    COUNTERS.map((c) => [c, module.cwrap(`Library_n${c}Allocated`, 'bigint', ['bigint']) as unknown as (lib: bigint) => bigint]),
  ) as Record<CounterName, (lib: bigint) => bigint>;

  const readInfo = (fn: string): string => {
    module.ccall(fn, null, ['number'], [scratch]);
    return module.UTF8ToString(scratch);
  };

  let disposed = false;
  const liveSession = () => assertLive(disposed, 'PicoGK session');

  const session = {
    get voxelSize() {
      return voxelSize;
    },
    get name() {
      return readInfo('Library_GetName');
    },
    get version() {
      return readInfo('Library_GetVersion');
    },
    get buildInfo() {
      return readInfo('Library_GetBuildInfo');
    },

    createVoxels(options: CreateVoxelsOptions): Voxels {
      liveSession();
      ctx.maybeWarnMemory();
      switch (options.shape) {
        case 'sphere': {
          const { center = [0, 0, 0], radius } = options;
          requirePositive(radius, 'radius', 'createVoxels({ shape: "sphere" })');
          ctx.writeVec3(scratch, center);
          return wrapVoxels(
            ctx,
            expectHandle('Voxels_hCreateSphere', guard('Voxels_hCreateSphere', () => raw.Voxels_hCreateSphere(lib, scratch, radius))()),
          );
        }
        case 'capsule': {
          const { start, end, radius } = options;
          requirePositive(radius, 'radius', 'createVoxels({ shape: "capsule" })');
          if (!start || !end) {
            throw new PicoGkError(
              'PICOGK_INVALID_ARGUMENT',
              'createVoxels({ shape: "capsule" }) needs start and end as [x, y, z] in millimetres.',
            );
          }
          ctx.writeVec3(scratch, start);
          ctx.writeVec3(scratch + VEC3_BYTES, end);
          return wrapVoxels(
            ctx,
            expectHandle(
              'Voxels_hCreateCapsule',
              guard('Voxels_hCreateCapsule', () => raw.Voxels_hCreateCapsule(lib, scratch, scratch + VEC3_BYTES, radius, radius))(),
            ),
          );
        }
        case 'implicit': {
          const { boundsMin, boundsMax, sdf } = options;
          if (!boundsMin || !boundsMax) {
            throw new PicoGkError(
              'PICOGK_INVALID_ARGUMENT',
              'createVoxels({ shape: "implicit" }) needs boundsMin and boundsMax as [x, y, z] in millimetres. ' +
                'The SDF is only sampled inside that box, so it must enclose the shape.',
            );
          }
          const target = expectHandle('Voxels_hCreate', raw.Voxels_hCreate(lib));
          // RenderImplicit is a SERIAL triple-nested loop (PicoGKVdbVoxels.h:370-381),
          // so a JS callback is correct under pthreads — and gains zero from them.
          try {
            withSdfPointer(ctx, sdf, (sdfPointer) => {
              ctx.writeVec3(scratch, boundsMin);
              ctx.writeVec3(scratch + VEC3_BYTES, boundsMax);
              guard('Voxels_RenderImplicit', () => raw.Voxels_RenderImplicit(lib, target, scratch, sdfPointer))();
            });
          } catch (error) {
            raw.Voxels_Destroy(lib, target); // don't leak the target on a throwing SDF
            throw error;
          }
          return wrapVoxels(ctx, target);
        }
        default:
          throw new PicoGkError(
            'PICOGK_INVALID_ARGUMENT',
            `Unknown shape "${(options as { shape: string }).shape}". Supported: "sphere", "capsule", "implicit".`,
          );
      }
    },

    createMesh({ vertices, triangles }: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): Mesh {
      liveSession();
      ctx.maybeWarnMemory();
      const mesh = expectHandle('Mesh_hCreate', raw.Mesh_hCreate(lib));
      for (let i = 0; i < vertices.length; i += 3) {
        ctx.writeVec3(scratch, [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!]);
        raw.Mesh_nAddVertex(lib, mesh, scratch);
      }
      for (let i = 0; i < triangles.length; i += 3) {
        module.HEAP32[(scratch >> 2) + 0] = triangles[i]!;
        module.HEAP32[(scratch >> 2) + 1] = triangles[i + 1]!;
        module.HEAP32[(scratch >> 2) + 2] = triangles[i + 2]!;
        raw.Mesh_nAddTriangle(lib, mesh, scratch);
      }
      return wrapMesh(ctx, mesh);
    },

    get allocated(): Record<CounterName, number> {
      return Object.fromEntries(COUNTERS.map((c) => [c, Number(rawAllocated[c](lib))])) as Record<CounterName, number>;
    },

    get module() {
      return module;
    },
    get handle() {
      return lib;
    },

    dispose() {
      if (disposed) return; // D3
      disposed = true;
      ctx.dead.value = true; // D4: teardown wins — wrappers stop freeing individually
      ctx.registry.unregister(session); // D2
      module._free(scratch);
      raw.Library_DestroyInstance(lib);
    },
  };
  adoptHandle(ctx, session, lib, raw.Library_DestroyInstance);
  return session as PicoGK; // adoptHandle added [Symbol.dispose] (D6)
}

function requirePositive(value: number, field: string, where: string): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new PicoGkError('PICOGK_INVALID_ARGUMENT', `${where} needs a positive ${field} in millimetres, got ${value}.`);
  }
}
