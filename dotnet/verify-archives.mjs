/** Compare the actual declared archive outputs from two independent clean builds. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactIdentity, inventory } from './validate-inputs.mjs';

export function verifyArchives(first, second) {
  const expectedNames = [
    'float-trig.o',
    'libblosc.a',
    'libopenvdb.a',
    'libtbb.a',
    'libz.a',
    'picogk.26.2.a',
  ].sort();
  for (const root of [first, second]) {
    const names = readdirSync(join(root, 'native')).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames))
      throw new Error('Archive output set mismatch');
    const actual = inventory(join(root, 'native'));
    const declared = JSON.parse(readFileSync(join(root, 'outputs.json')));
    if (JSON.stringify(actual) !== JSON.stringify(declared))
      throw new Error('Archive bytes changed after build');
    const inputs = join(root, 'inputs.json');
    const receipt = JSON.parse(readFileSync(inputs));
    for (const name of names) {
      artifactIdentity(
        { path: join(root, 'native', name), metadata: join(root, `${name}.metadata.json`), inputs },
        receipt.execution,
        receipt.sources,
        receipt.files,
        receipt.flags,
      );
    }
  }
  for (const name of ['outputs.json', 'inputs.json', 'staged-source.json']) {
    if (!readFileSync(join(first, name)).equals(readFileSync(join(second, name))))
      throw new Error(`Clean builds differ: ${name}`);
  }
  return JSON.parse(readFileSync(join(first, 'outputs.json')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [first, second, ...extra] = process.argv.slice(2);
  if (!second || extra.length) throw new Error('Usage: verify-archives.mjs <first build> <second build>');
  console.log(JSON.stringify({ passed: true, outputs: verifyArchives(first, second) }, null, 2));
}
