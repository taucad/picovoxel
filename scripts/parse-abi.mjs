// Parses API/PicoGK.h into the ABI manifest that drives both the export list and the
// Tier-2 coverage report.
//
// Generating this instead of hand-listing matters: coverage is then measured against
// what upstream ACTUALLY exports, so a new export shows up as an uncovered function
// rather than silently escaping the suite. Upstream drift becomes a failing test.
//
// Usage: node scripts/parse-abi.mjs [path/to/PicoGK.h] > src/abi.json

import { readFile } from 'node:fs/promises';

const DEFAULT_HEADER = '/Users/rifont/git/tau/repos/PicoGKRuntime/API/PicoGK.h';

// Every PK* handle is uint64_t (PicoGK.h:73-88) except PKVIEWER/PKGUI/PKGPUTEX, which
// are viewer-side pointers and excluded with the rest of the viewer surface.
const HANDLE_TYPES = new Set([
  'PKHANDLE', 'PKINSTANCE', 'PKMESH', 'PKVOXELS', 'PKLATTICE', 'PKPOLYLINE',
  'PKSCALARFIELD', 'PKVECTORFIELD', 'PKVDBFILE', 'PKMETADATA',
]);

/**
 * Maps a C type to how the value crosses the boundary. Pointers and enums cross as i32.
 * The `cwrap`/`cwrapReturn` field names are historical — the bindings stopped being cwraps
 * in SK-0.2 — and are kept so the 4,000-line `src/abi.json` does not churn for a rename.
 */
function cwrapType(cType) {
  const t = cType.replace(/\bconst\b/g, '').replace(/\s+/g, ' ').trim();
  if (t === 'void') return null;
  if (t.includes('*') || t.includes('[')) return 'number'; // pointer
  if (HANDLE_TYPES.has(t)) return 'bigint';
  if (t === 'bool') return 'boolean';
  if (t === 'float' || t === 'double' || t === 'int32_t') return 'number';
  if (t === 'int64_t' || t === 'uint64_t') return 'bigint';
  return 'number';
}

export async function parseAbi(headerPath = DEFAULT_HEADER) {
  const source = await readFile(headerPath, 'utf8');

  // Exports may span lines; join each PICOGK_API declaration up to its terminating ');'
  const declarations = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('PICOGK_API')) continue;
    let decl = lines[i];
    while (!decl.includes(');') && i + 1 < lines.length) decl += ' ' + lines[++i].trim();
    declarations.push(decl.replace(/\s+/g, ' ').trim());
  }

  const functions = [];
  for (const decl of declarations) {
    const m = /^PICOGK_API\s+([A-Za-z0-9_]+(?:\s*\*)?)\s+([A-Za-z0-9_]+)\s*\((.*)\)\s*;/.exec(decl);
    if (!m) {
      throw new Error(`parse-abi: could not parse declaration: ${decl.slice(0, 90)}`);
    }
    const [, returnType, name, argText] = m;

    const args = argText.trim() === '' || argText.trim() === 'void'
      ? []
      : argText.split(',').map((a) => {
          const arg = a.trim();
          // "const PKVector3* pvecCoord" / "char psz[255]" / "PKPFnfSdf pfnSDF"
          // Array params decay to pointers; the * can land on either side of the name.
          const parts = arg.replace(/\[[^\]]*\]/, '*').split(/\s+/);
          const argName = parts.pop();
          let type = parts.join(' ');
          if (argName.startsWith('*') || argName.endsWith('*')) type += '*';
          return { type: type.trim(), name: argName.replace(/^\*+|\*+$/g, '') };
        });

    functions.push({
      name,
      viewer: name.startsWith('Viewer_') || name.startsWith('Gui_'),
      returnType: returnType.trim(),
      cwrapReturn: cwrapType(returnType),
      args: args.map((a) => ({ ...a, cwrap: cwrapType(a.type) })),
      // A JS callback arg means addFunction, not a plain cwrap call.
      takesCallback: args.some((a) => /PKPF|PKFInfo/.test(a.type)),
    });
  }

  const core = functions.filter((f) => !f.viewer);
  return {
    header: headerPath,
    total: functions.length,
    viewer: functions.length - core.length,
    core: core.length,
    functions,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const abi = await parseAbi(process.argv[2]);
  process.stderr.write(`parse-abi: ${abi.total} exports = ${abi.core} core + ${abi.viewer} viewer\n`);
  process.stdout.write(JSON.stringify(abi, null, 1) + '\n');
}
