#!/usr/bin/env node
// Package-shape lint for the built tree: publint (strict) and
// arethetypeswrong (ESM-only profile). Run after `validate-pack`, which owns
// the exact file set. Two findings are excluded, each for a stated reason:
//
// - publint FILE_INVALID_EXPLICIT_FORMAT on `./multi/worker`: publint guesses a file's
//   format by regex, and the minified pthread glue writes `}export default`
//   and `,import.meta` with no whitespace before the keyword, so only its
//   guarded `require(` calls match. The file is an ES module; the consumer
//   smoke imports it and spawns the pool from it.
// - attw FalseESM: under the esm-only profile the CommonJS resolutions are
//   out of scope, but attw still counts that rule toward the exit code. A
//   CommonJS TypeScript consumer seeing ESM types is the intended diagnostic
//   (TS1479, use a dynamic import), and at run time the `require` condition
//   throws the ESM-only error.
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
    '--ignore-rules',
    'false-esm',
    '--exclude-entrypoints',
    './wasm',
    './glue',
    './multi/wasm',
    './multi/worker',
    './package.json',
  ],
  { stdio: 'inherit' },
);
