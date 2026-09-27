import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

// Machine-specific paths (a home directory, an agent scratch directory, a macOS
// per-user temp directory) must never reach the public tree. Evidence logs keep
// their shape with `<home>`, `<repo>`, `<scratch>` and `<tmp>` placeholders.
const localPath = String.raw`/Users/[A-Za-z0-9_.-]+/|/home/[A-Za-z0-9_.-]+/|/private/tmp/claude|/var/folders/[a-z0-9_]+/`;

// The prose rules name the pattern they reject.
const allowed = new Set(['.vale/styles/Tau/InternalReferences.yml', 'tests/local-paths.test.mjs']);

describe('tracked files', () => {
  it('carry no machine-specific paths', () => {
    let output = '';
    try {
      output = execFileSync('git', ['grep', '-n', '-I', '-E', localPath, '--', '.'], { encoding: 'utf8' });
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if (error.status !== 1) throw error;
    }
    const hits = output
      .split('\n')
      .filter(Boolean)
      .filter((line) => !allowed.has(line.slice(0, line.indexOf(':'))));
    assert.deepEqual(hits, []);
  });
});
