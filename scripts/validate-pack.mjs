#!/usr/bin/env node
// The packed file set equals PACKAGE_FILES exactly: missing and extra files
// both fail, so an unbuilt tree or a tarball without the CI-built wasm never
// passes. With no argument it checks `npm pack --dry-run`; given a tarball (the
// CI candidate) it checks that tarball's real entries. Either way the entries
// that must load the Symbol.dispose shim first are read and checked.
//
// Usage: node scripts/validate-pack.mjs [<package.tgz>]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { DISPOSE_FIRST_ENTRIES, assertDisposeFirst, validatePackageFiles } from './package-files.mjs';

const tarball = process.argv[2];
let listed;
if (tarball) {
  listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry && !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//u, ''));
} else {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
  );
  if (!Array.isArray(packed) || packed.length !== 1)
    throw new Error('npm pack must describe exactly one tarball');
  listed = packed[0].files.map(({ path }) => path);
}

const files = validatePackageFiles(listed);
for (const entry of DISPOSE_FIRST_ENTRIES) {
  const source = tarball
    ? execFileSync('tar', ['-xOzf', tarball, `package/${entry}`], { encoding: 'utf8' })
    : readFileSync(entry, 'utf8');
  assertDisposeFirst(entry, source);
}
console.log(`${tarball ?? 'npm pack'} contains exactly the ${files.length} public package files`);
