#!/usr/bin/env node
// The packed file set equals PACKAGE_FILES exactly: missing and extra files
// both fail, so an unbuilt tree or a tarball without the CI-built wasm never
// passes. With no argument it checks `npm pack --dry-run`; given a tarball (the
// CI candidate) it checks that tarball's real entries.
//
// Usage: node scripts/validate-pack.mjs [<package.tgz>]

import { execFileSync } from 'node:child_process';

import { validatePackageFiles } from './package-files.mjs';

const tarball = process.argv[2];
let listed;
if (tarball) {
  listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry && !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//u, ''));
} else {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error('npm pack must describe exactly one tarball');
  listed = packed[0].files.map(({ path }) => path);
}

const files = validatePackageFiles(listed);
console.log(`${tarball ?? 'npm pack'} contains exactly the ${files.length} public package files`);
