// The coverage-ignore audit (scripts/ignore-audit.mjs). The directives are built
// by concatenation so this file never carries one the audit, or the coverage
// converter, would read.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { unjustifiedIgnores } from '../scripts/ignore-audit.mjs';

const v8 = (rest) => `v8 ignore ${rest}`;

test('each directive form without a reason fails the audit', () => {
  for (const line of [`/** ${v8('next')} */`, `/** ${v8('start')} */`, `// keep: ${v8('start')}`]) {
    assert.deepEqual(unjustifiedIgnores(`const a = 1;\n${line}\nconst b = 2;\n`), [line], line);
  }
});

test('every prefix and keyword the converter honours is audited', () => {
  for (const prefix of ['v8', 'c8', 'istanbul', 'node:coverage']) {
    for (const keyword of ['if', 'else', 'next 3', 'file', 'start']) {
      const line = `/* ${prefix}  ignore ${keyword} */`;
      assert.deepEqual(unjustifiedIgnores(line), [line]);
    }
  }
});

test('a reason after the directive satisfies the audit, and a stop needs none', () => {
  const source = [
    `/** ${v8('next')} -- reachable only via the foreign-grid arm */`,
    `// keep: ${v8('start')} -- the CLI entry`,
    `/* ${v8('stop')} */`,
    '// prose that names an ignore directive without being one',
  ].join('\r\n');
  assert.deepEqual(unjustifiedIgnores(source), []);
});

test('a dash pair before the directive, or an empty reason, is not a reason', () => {
  assert.deepEqual(unjustifiedIgnores(`// a -- b ${v8('next')}`), [`// a -- b ${v8('next')}`]);
  assert.deepEqual(unjustifiedIgnores(`/* ${v8('next')} -- */`), [`/* ${v8('next')} -- */`]);
});
