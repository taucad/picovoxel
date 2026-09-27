// The three subpath barrels are pure re-exports, so coverage has nothing to
// count in them. This proves them instead: every value a barrel names is the
// very binding its source module exports, and the barrel exports nothing else.
// (The consumer job imports each subpath from the packed tarball.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** The value (non-type) names each `export { … } from '…'` clause re-exports, by source module. */
const reExports = (barrel: string): Map<string, string[]> => {
  const source = readFileSync(join(SRC, barrel), 'utf8');
  const clauses = new Map<string, string[]>();
  for (const [, typeOnly, list, from] of source.matchAll(/^export (type )?\{([^}]*)\} from '([^']+)';$/gmu)) {
    if (typeOnly) continue;
    const names = list!
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('type '));
    clauses.set(from!, [...(clauses.get(from!) ?? []), ...names]);
  }
  return clauses;
};

for (const barrel of ['latticelibrary.ts', 'numerics.ts', 'shapekernel.ts']) {
  test(`picovoxel/${barrel.replace('.ts', '')}: every export is its source module's binding`, async () => {
    const exported = (await import(join(SRC, barrel))) as Record<string, unknown>;
    const clauses = reExports(barrel);
    assert.ok(clauses.size > 0, `${barrel} names no re-exports`);

    const expected: string[] = [];
    for (const [from, names] of clauses) {
      const module = (await import(join(SRC, from))) as Record<string, unknown>;
      for (const name of names) {
        assert.ok(name in module, `${from} has no export ${name}`);
        assert.equal(exported[name], module[name], `${barrel} re-exports a different ${name}`);
        expected.push(name);
      }
    }
    assert.deepEqual(
      Object.keys(exported).sort(),
      expected.sort(),
      `${barrel} exports exactly what it names`,
    );
  });
}
