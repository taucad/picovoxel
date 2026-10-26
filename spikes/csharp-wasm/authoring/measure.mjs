// Usage: node authoring/measure.mjs <wwwroot>. Measure only boot-manifest assets,
// excluding stale publish files and optional satellite cultures.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const root = process.argv[2];
const framework = join(root, '_framework');
const loader = await readFile(join(framework, 'dotnet.js'), 'utf8');
const config = JSON.parse(loader.split('/*json-start*/')[1].split('/*json-end*/')[0]);
const names = new Set(['dotnet.js']);
for (const [kind, assets] of Object.entries(config.resources)) {
  if (kind === 'satelliteResources' || !Array.isArray(assets)) continue;
  for (const asset of assets) names.add(asset.name);
}
const files = [];
for (const name of names) {
  const bytes = await readFile(join(framework, name));
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  files.push({ name, raw: bytes.length, brotli11: compressed.length });
}
const references = [];
if (existsSync(join(root, 'authoring.json'))) {
  const manifest = JSON.parse(await readFile(join(root, 'authoring.json'), 'utf8'));
  for (const reference of manifest.references) {
    const bytes = await readFile(join(root, reference.url));
    references.push({ name: reference.url, raw: bytes.length, brotli11: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length });
  }
}
console.log(JSON.stringify({
  basis: 'Boot manifest assets, no satellite cultures; independent brotli quality 11 per file',
  raw: files.reduce((sum, file) => sum + file.raw, 0),
  brotli11: files.reduce((sum, file) => sum + file.brotli11, 0),
  referencesRaw: references.reduce((sum, file) => sum + file.raw, 0),
  referencesBrotli11: references.reduce((sum, file) => sum + file.brotli11, 0),
  files,
  references,
}, null, 2));
