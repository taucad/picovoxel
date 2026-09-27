// R9 — generates src/raw.generated.ts from src/abi.json: a typed table of DIRECT
// wasm exports for every core export plus this repo's bulk TU additions.
//
// SK-0.2: the table used to be cwraps. emscripten's cwrap only hands back the raw
// export when every argType is 'number'/'boolean'; one 'bigint' — i.e. any PicoGK
// handle — demotes the binding to ccall, and 143 of the 147 exports take a handle.
//
// Generating (instead of hand-maintaining) matters for the same reason abi.json is
// generated: a new upstream export appears as a missing binding in the tier-2 gate,
// a renamed one fails to bind, and the known header typos (MetaData_RemoveValue's
// capital D, ScalarField_RemoveValue typed PKVECTORFIELD) are matched, never "fixed".
// Output is deterministic — regenerating over an unchanged abi.json is byte-stable.
//
// Usage: node scripts/generate-raw.mjs  (writes src/raw.generated.ts)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Handle-typed C types (all uint64_t). Everything else bigint-ish is a count. */
export const HANDLE_TYPES = new Set([
  'PKHANDLE',
  'PKINSTANCE',
  'PKMESH',
  'PKVOXELS',
  'PKLATTICE',
  'PKPOLYLINE',
  'PKSCALARFIELD',
  'PKVECTORFIELD',
  'PKVDBFILE',
  'PKMETADATA',
]);

/** This repo's own TU exports (src/pico-bulk.cpp, src/pico-tape.cpp, src/pico-props.cpp, src/pico-offset.cpp) — not in upstream's header. */
export const BULK_FUNCTIONS = [
  {
    name: 'Mesh_GetVertices',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
      { name: 'pvecBuffer', type: 'PKVector3*', cwrap: 'number' },
      { name: 'nBufferCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  {
    name: 'Mesh_GetTriangles',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
      { name: 'psBuffer', type: 'PKTriangle*', cwrap: 'number' },
      { name: 'nBufferCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  {
    name: 'Mesh_AddVertices',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
      { name: 'pvecBuffer', type: 'PKVector3*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  {
    name: 'Mesh_AddTriangles',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
      { name: 'psBuffer', type: 'PKTriangle*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  // The tape TU's exports (src/pico-tape.cpp) — parallel implicit fill plus
  // the R9 compose-into-existing variants.
  {
    name: 'Voxels_RenderImplicitTape',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'poBBox', type: 'PKBBox3*', cwrap: 'number' },
      { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
      { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pfConstants', type: 'double*', cwrap: 'number' },
      { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  {
    name: 'Voxels_RenderImplicitTapeCompose',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'poBBox', type: 'PKBBox3*', cwrap: 'number' },
      { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
      { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pfConstants', type: 'double*', cwrap: 'number' },
      { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  // SK-0.3 bulk lattice authoring: one crossing per lattice instead of one per beam.
  {
    name: 'Lattice_AddBeams',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKLATTICE', cwrap: 'bigint' },
      { name: 'pfBeams', type: 'float*', cwrap: 'number' },
      { name: 'pnRoundCap', type: 'uint32_t*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  {
    name: 'Lattice_AddSpheres',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKLATTICE', cwrap: 'bigint' },
      { name: 'pfSpheres', type: 'float*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  // The properties TU (src/pico-props.cpp) — volume/area/bounds in one crossing.
  {
    name: 'Voxels_GetProperties',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pfVolume', type: 'float*', cwrap: 'number' },
      { name: 'pfArea', type: 'float*', cwrap: 'number' },
      { name: 'poBBox', type: 'PKBBox3*', cwrap: 'number' },
    ],
  },
  // The hash TU (src/pico-hash.cpp) — the G0 canonical grid hash + its self-test
  // densifier (NON-DETERMINISM.md §14.5).
  {
    name: 'Voxels_GetGridHash',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pnHash16', type: 'uint8_t*', cwrap: 'number' },
      { name: 'pnActiveVoxels', type: 'uint64_t*', cwrap: 'number' },
      { name: 'pnInsideTiles', type: 'uint64_t*', cwrap: 'number' },
      { name: 'pnInsideOffVoxels', type: 'uint64_t*', cwrap: 'number' },
    ],
  },
  {
    name: 'Voxels_DensifyInterior',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
    ],
  },
  // The boolean TU (src/pico-boolean.cpp) — shared-nothing csg*Copy composition
  // (SKv2-0 V0.7): const inputs, one fresh output grid, no receiver/operand copies.
  {
    name: 'Voxels_hBoolAddCopy',
    cwrapReturn: 'bigint',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hA', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'hB', type: 'PKVOXELS', cwrap: 'bigint' },
    ],
  },
  {
    name: 'Voxels_hBoolSubtractCopy',
    cwrapReturn: 'bigint',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hA', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'hB', type: 'PKVOXELS', cwrap: 'bigint' },
    ],
  },
  {
    name: 'Voxels_hBoolIntersectCopy',
    cwrapReturn: 'bigint',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hA', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'hB', type: 'PKVOXELS', cwrap: 'bigint' },
    ],
  },
  // T11 (SKv2-0 V0.8): sign-classification equality in O(stored) — upstream-
  // verdict-identical replacement for the dense O(bbox³) Voxels_bIsEqual scan.
  {
    name: 'Voxels_bIsEqualFast',
    cwrapReturn: 'boolean',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hA', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'hB', type: 'PKVOXELS', cwrap: 'bigint' },
    ],
  },
  // T5×F15 + U2 (SKv2-0 V0.9): column-culled ProjectZSlice with the
  // voxel-unit seal count; the dense mutating export stays as the oracle.
  {
    name: 'Voxels_ProjectZSliceFast',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'fZStart', type: 'float', cwrap: 'number' },
      { name: 'fZEnd', type: 'float', cwrap: 'number' },
    ],
  },
  // F17 + U1 (SKv2-0 V0.10): support-restricted IntersectImplicit with the
  // voxel-unit narrow band; the truncated-band originals stay as oracles.
  {
    name: 'Voxels_IntersectImplicitFast',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pfnSdf', type: 'PKPFnfSdf', cwrap: 'number' },
    ],
  },
  {
    name: 'Voxels_IntersectImplicitTapeFast',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pnInstructions', type: 'const uint32_t*', cwrap: 'number' },
      { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pfConstants', type: 'const double*', cwrap: 'number' },
      { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  // P8 (SKv2-0 V0.11): batched queries — one intersector / one index build
  // per batch instead of per ABI call.
  {
    name: 'Voxels_RayCastBatch',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pvecOrigins', type: 'const PKVector3*', cwrap: 'number' },
      { name: 'pvecDirections', type: 'const PKVector3*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pvecHits', type: 'PKVector3*', cwrap: 'number' },
      { name: 'pbHit', type: 'uint8_t*', cwrap: 'number' },
    ],
  },
  {
    name: 'Voxels_ClosestPointBatch',
    cwrapReturn: 'number',
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pvecQueries', type: 'const PKVector3*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pvecPoints', type: 'PKVector3*', cwrap: 'number' },
      { name: 'pbFound', type: 'uint8_t*', cwrap: 'number' },
    ],
  },
  // The offset TU (src/pico-offset.cpp) — the offset family's renormalization knobs.
  {
    name: 'Voxels_OffsetTuned',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pfDistancesMM', type: 'const float*', cwrap: 'number' },
      { name: 'nCount', type: 'int32_t', cwrap: 'number' },
      { name: 'nSpatialScheme', type: 'int32_t', cwrap: 'number' },
      { name: 'nNormCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
  // The lattice TU (src/pico-lattice.cpp) — the parallel tube-complex lattice lane.
  // Same three handles as Voxels_RenderLattice, which stays bound as the serial arm.
  {
    name: 'Voxels_RenderLatticeTubes',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'hLattice', type: 'PKLATTICE', cwrap: 'bigint' },
    ],
  },
  {
    name: 'Voxels_IntersectImplicitTape',
    cwrapReturn: null,
    args: [
      { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
      { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
      { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
      { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
      { name: 'pfConstants', type: 'double*', cwrap: 'number' },
      { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
    ],
  },
];

function tsType(cwrapType, cType) {
  if (cwrapType === null) return 'void';
  if (cwrapType === 'bigint') {
    return HANDLE_TYPES.has((cType ?? '').replace(/\bconst\b/g, '').trim()) ? 'PicoHandle' : 'bigint';
  }
  if (cwrapType === 'boolean') return 'boolean';
  return 'number'; // numbers, pointers, enums, callback fn-table indices
}

/** Renders the complete raw.generated.ts source from a parsed abi.json object. */
export function generateRawSource(abi) {
  const core = abi.functions.filter((f) => !f.viewer);
  if (core.length !== 140) {
    throw new Error(
      `generate-raw: expected 140 core exports, abi.json has ${core.length} — re-run parse-abi and re-read upstream before regenerating`,
    );
  }
  const all = [...core, ...BULK_FUNCTIONS];

  const interfaceLines = all.map((fn) => {
    const params = fn.args.map((a) => `${a.name}: ${tsType(a.cwrap, a.type)}`).join(', ');
    return `  ${fn.name}(${params}): ${tsType(fn.cwrapReturn, fn.returnType)};`;
  });

  const exportLines = all.map((fn) => `  '${fn.name}',`);

  // The only conversion a direct export cannot do for itself: wasm returns i32,
  // the API promises boolean. Arity-matched so no rest array is allocated per call.
  const booleanLines = all
    .filter((fn) => fn.cwrapReturn === 'boolean')
    .map((fn) => {
      const params = fn.args.map((_, i) => `a${i}`).join(', ');
      return `  ${fn.name}: (fn) => (${params}) => !!fn(${params}),`;
    });

  return `// GENERATED by scripts/generate-raw.mjs from src/abi.json — do not edit.
// ${core.length} core exports + ${BULK_FUNCTIONS.length} own-TU additions (src/pico-bulk.cpp, src/pico-tape.cpp, src/pico-props.cpp, src/pico-offset.cpp).
// Known upstream header quirks are matched, not fixed: MetaData_RemoveValue (capital
// D), ScalarField_RemoveValue's handle typed PKVECTORFIELD (all handles are uint64_t,
// so it binds by name and works on a scalar field), name-keyed Metadata_*At.
//
// SK-0.2 — every binding is a DIRECT wasm export (\`module._Name\`); no ccall, no
// cwrap. cwrap only returns the raw export when every argType is 'number'/'boolean',
// and one 'bigint' (any PicoGK handle) demotes it to ccall, which re-resolves the
// export by string key, walks a converter array and saves/restores the stack on
// every call. No marshalling is actually needed: handles are already BigInt,
// pointers/enums/floats/ints are already numbers, and booleans coerce on the way in.
//
// Deliberately glue-free: this module must not import pico.mjs, or the serial
// glue would ride into the picovoxel/multi graph through session.ts. The
// instantiate-and-bind convenience lives in raw.ts (single) beside the entries.

import type { PicoWasmModule } from './types.ts';

/** A PicoGK object handle (uint64_t across the ABI). Never a plain count. */
export type PicoHandle = bigint & { readonly __picoHandle?: never };

export interface PicoRaw {
${interfaceLines.join('\n')}
}

/** Everything crossing this ABI: a number (pointer/enum/float/int), a uint64 handle, or a bool. */
type AbiValue = number | bigint | boolean;
type WasmExport = (...args: AbiValue[]) => unknown;

const EXPORTS: readonly string[] = [
${exportLines.join('\n')}
];

/** i32 -> boolean at the boundary — the one thing the raw export cannot do itself. */
const BOOLEAN_RETURNS: Readonly<Record<string, (fn: WasmExport) => WasmExport>> = {
${booleanLines.join('\n')}
};

/** Binds every export as a direct wasm call on an instantiated module. */
export function bindPicoRaw(module: PicoWasmModule): PicoRaw {
  const exports = module as unknown as Record<string, WasmExport | undefined>;
  const table: Record<string, WasmExport> = {};
  for (const name of EXPORTS) {
    const fn = exports[\`_\${name}\`];
    if (typeof fn !== 'function') {
      throw new Error(
        \`picovoxel: the wasm module exports no _\${name}. Rebuild with scripts/build-pico-module.sh — \` +
          'src/pico-exports.txt is the EXPORTED_FUNCTIONS list this binding table expects.',
      );
    }
    const toBoolean = BOOLEAN_RETURNS[name];
    table[name] = toBoolean ? toBoolean(fn) : fn;
  }
  return table as unknown as PicoRaw;
}
`;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const here = fileURLToPath(new URL('..', import.meta.url));
  const abi = JSON.parse(await readFile(new URL('../src/abi.json', import.meta.url), 'utf8'));
  const source = generateRawSource(abi);
  await writeFile(new URL('../src/raw.generated.ts', import.meta.url), source);
  process.stderr.write(
    `generate-raw: wrote src/raw.generated.ts (${source.length} bytes) from ${here}src/abi.json\n`,
  );
}
