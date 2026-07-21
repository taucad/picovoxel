// R9 — generates src/raw.generated.ts from src/abi.json: a typed cwrap table for
// every core export plus this repo's bulk TU additions.
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
  'PKHANDLE', 'PKINSTANCE', 'PKMESH', 'PKVOXELS', 'PKLATTICE', 'PKPOLYLINE',
  'PKSCALARFIELD', 'PKVECTORFIELD', 'PKVDBFILE', 'PKMETADATA',
]);

/** This repo's own TU exports (src/pico-bulk.cpp, src/pico-tape.cpp) — not in upstream's header. */
export const BULK_FUNCTIONS = [
  { name: 'Mesh_GetVertices', cwrapReturn: 'number', args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
    { name: 'pvecBuffer', type: 'PKVector3*', cwrap: 'number' },
    { name: 'nBufferCount', type: 'int32_t', cwrap: 'number' },
  ] },
  { name: 'Mesh_GetTriangles', cwrapReturn: 'number', args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
    { name: 'psBuffer', type: 'PKTriangle*', cwrap: 'number' },
    { name: 'nBufferCount', type: 'int32_t', cwrap: 'number' },
  ] },
  { name: 'Mesh_AddVertices', cwrapReturn: 'number', args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
    { name: 'pvecBuffer', type: 'PKVector3*', cwrap: 'number' },
    { name: 'nCount', type: 'int32_t', cwrap: 'number' },
  ] },
  { name: 'Mesh_AddTriangles', cwrapReturn: 'number', args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKMESH', cwrap: 'bigint' },
    { name: 'psBuffer', type: 'PKTriangle*', cwrap: 'number' },
    { name: 'nCount', type: 'int32_t', cwrap: 'number' },
  ] },
  // The tape TU's exports (src/pico-tape.cpp) — parallel implicit fill plus
  // the R9 compose-into-existing variants.
  { name: 'Voxels_RenderImplicitTape', cwrapReturn: null, args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
    { name: 'poBBox', type: 'PKBBox3*', cwrap: 'number' },
    { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
    { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
    { name: 'pfConstants', type: 'double*', cwrap: 'number' },
    { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
  ] },
  { name: 'Voxels_RenderImplicitTapeCompose', cwrapReturn: null, args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
    { name: 'poBBox', type: 'PKBBox3*', cwrap: 'number' },
    { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
    { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
    { name: 'pfConstants', type: 'double*', cwrap: 'number' },
    { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
  ] },
  { name: 'Voxels_IntersectImplicitTape', cwrapReturn: null, args: [
    { name: 'hLib', type: 'PKINSTANCE', cwrap: 'bigint' },
    { name: 'hThis', type: 'PKVOXELS', cwrap: 'bigint' },
    { name: 'pnInstructions', type: 'uint32_t*', cwrap: 'number' },
    { name: 'nInstructionCount', type: 'int32_t', cwrap: 'number' },
    { name: 'pfConstants', type: 'double*', cwrap: 'number' },
    { name: 'nConstantCount', type: 'int32_t', cwrap: 'number' },
  ] },
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
    throw new Error(`generate-raw: expected 140 core exports, abi.json has ${core.length} — re-run parse-abi and re-read upstream before regenerating`);
  }
  const all = [...core, ...BULK_FUNCTIONS];

  const interfaceLines = all.map((fn) => {
    const params = fn.args.map((a) => `${a.name}: ${tsType(a.cwrap, a.type)}`).join(', ');
    return `  ${fn.name}(${params}): ${tsType(fn.cwrapReturn, fn.returnType)};`;
  });

  const signatureLines = all.map((fn) => {
    const args = fn.args.map((a) => JSON.stringify(a.cwrap === null ? 'number' : a.cwrap)).join(', ');
    return `  ['${fn.name}', ${JSON.stringify(fn.cwrapReturn)}, [${args}]],`;
  });

  return `// GENERATED by scripts/generate-raw.mjs from src/abi.json — do not edit.
// ${core.length} core exports + ${BULK_FUNCTIONS.length} own-TU additions (src/pico-bulk.cpp, src/pico-tape.cpp).
// Known upstream header quirks are matched, not fixed: MetaData_RemoveValue (capital
// D), ScalarField_RemoveValue's handle typed PKVECTORFIELD (all handles are uint64_t,
// so it binds by name and works on a scalar field), name-keyed Metadata_*At.
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

const SIGNATURES: ReadonlyArray<readonly [string, string | null, readonly string[]]> = [
${signatureLines.join('\n')}
];

/** Binds every export as a cwrap on an instantiated module. */
export function bindPicoRaw(module: PicoWasmModule): PicoRaw {
  const table: Record<string, unknown> = {};
  for (const [name, returnType, argTypes] of SIGNATURES) {
    table[name] = module.cwrap(name, returnType, argTypes);
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
  process.stderr.write(`generate-raw: wrote src/raw.generated.ts (${source.length} bytes) from ${here}src/abi.json\n`);
}
