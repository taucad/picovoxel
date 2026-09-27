import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const script = new URL('../scripts/make-core-tu.sh', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'make-core-tu-'));

/** A synthetic PicoGKLibrary.cpp: `core` core exports, then `viewer` Viewer_* exports. */
const split = (core, viewer = 2) => {
  const lines = ['#include "gl/glad.h"', '#include "PicoGK.h"'];
  for (let i = 0; i < core; i++) lines.push(`PICOGK_API void Core_${i}(PKINSTANCE hLib)`, '{', '}');
  for (let i = 0; i < viewer; i++) lines.push(`PICOGK_API void Viewer_${i}(PKVIEWER hThis)`, '{', '}');
  const source = join(directory, `library-${core}-${viewer}.cpp`);
  const out = join(directory, `core-${core}-${viewer}.cpp`);
  writeFileSync(source, lines.join('\n') + '\n');
  const result = spawnSync('bash', [script, source, out], { encoding: 'utf8' });
  return { ...result, out };
};

describe('make-core-tu.sh', () => {
  it('keeps exactly the 140 core exports and drops the viewer tail and its includes', () => {
    const { status, stdout, out } = split(140);
    assert.equal(status, 0);
    assert.match(stdout, /140 core exports kept, 2 Viewer_\* dropped/u);
    const core = readFileSync(out, 'utf8');
    assert.equal(core.match(/^PICOGK_API/gmu).length, 140);
    assert.ok(!core.includes('Viewer_'));
    assert.match(core, /^\/\/ \[picovoxel\] dropped: #include "gl\/glad.h"$/mu);
  });

  it('fails, rather than warns, when the core export count drifts', () => {
    for (const core of [139, 141]) {
      const { status, stderr } = split(core);
      assert.equal(status, 1, `${core} core exports must fail`);
      assert.match(stderr, new RegExp(`FAIL expected 140 core exports, got ${core}`, 'u'));
    }
  });

  it('fails when no Viewer_* boundary exists', () => {
    const { status, stderr } = split(140, 0);
    assert.equal(status, 1);
    assert.match(stderr, /no Viewer_\* export found/u);
  });
});
