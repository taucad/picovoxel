#!/usr/bin/env node
// Package-shape lint for the built tree: publint (strict) and
// arethetypeswrong (ESM-only profile, no ignored rules). Run after
// `validate-pack`, which owns the exact file set. One finding is excused:
//
// - publint FILE_INVALID_EXPLICIT_FORMAT on `./multi/worker`: publint guesses
//   a file's format by regex. In the minified pthread glue its ESM pattern
//   misses `}export default` and every `import.meta` (each follows `,`, `(` or
//   `=`), and its CommonJS pattern matches `;global.Worker=` in the Node
//   branch, so it reports CommonJS. The file is an ES module; the consumer
//   smoke imports it and spawns the pool from it. The serial glue matches
//   neither pattern and passes as unknown, so if a future emcc adds such a
//   token there, this gate fails rather than hiding it.
//
// Usage: node scripts/pkgcheck.mjs

import { execFileSync } from 'node:child_process';

import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

const excused = (message) =>
  message.code === 'FILE_INVALID_EXPLICIT_FORMAT' && message.path.join('/') === 'exports/./multi/worker';

const { messages, pkg } = await publint({ pkgDir: '.', strict: true });
let failed = false;
for (const message of messages) {
  const text = formatMessage(message, pkg, { color: false });
  if (excused(message)) {
    console.log(`publint (excused, see scripts/pkgcheck.mjs): ${text}`);
  } else {
    console.log(`publint ${message.type}: ${text}`);
    failed ||= message.type === 'error';
  }
}
if (failed) process.exit(1);
console.log(`publint: ${messages.length} message(s), none failing`);

// The four asset subpaths are wasm and Emscripten glue, not typed modules;
// the consumer smoke resolves and loads each of them.
execFileSync(
  'attw',
  [
    '--pack',
    '.',
    '--profile',
    'esm-only',
    '--exclude-entrypoints',
    './wasm',
    './glue',
    './multi/wasm',
    './multi/worker',
    './package.json',
  ],
  { stdio: 'inherit' },
);
