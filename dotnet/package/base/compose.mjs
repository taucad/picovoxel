/**
 * Compose the managed base library into a fresh tree.
 *
 * The patch order is the caller's, because a consumer's own patches interleave with this
 * package's: Tau applies its hosted patch before `browser-handles.patch` and its browser patch
 * after. Omitting this package's patch is refused, so the order is a choice and never an omission.
 *
 * Usage: node compose.mjs <fresh output> --patch <file> [--patch <file>]...
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const [destination, ...rest] = process.argv.slice(2);
const patches = [];
for (let index = 0; index < rest.length; index += 2) {
  if (rest[index] !== '--patch' || !rest[index + 1])
    throw new Error('Usage: compose.mjs <fresh output> --patch <file>...');
  patches.push(resolve(rest[index + 1]));
}
if (!destination || !patches.length) throw new Error('Usage: compose.mjs <fresh output> --patch <file>...');
const out = resolve(destination);
if (existsSync(out)) throw new Error('Composition output must be fresh; a reused tree hides a stale patch.');

const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8'));
const own = join(here, 'patches/browser-handles.patch');
const ownDigest = digest(readFileSync(own));
if (!patches.some((path) => digest(readFileSync(path)) === ownDigest))
  throw new Error(`The composition must include this package's own ${relative(here, own)}.`);

const source = join(here, 'source');
const staged = join(out, 'source');
const files = [];
const walk = (current, name) => {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`Base source symlink is not admitted: ${name}`);
  if (stat.isDirectory()) {
    for (const child of readdirSync(current).sort())
      walk(join(current, child), name ? `${name}/${child}` : child);
    return;
  }
  const expected = manifest.payload[`base/source/${name}`];
  const bytes = readFileSync(current);
  if (digest(bytes) !== expected) throw new Error(`Base source byte changed against the manifest: ${name}`);
  mkdirSync(dirname(join(staged, name)), { recursive: true });
  copyFileSync(current, join(staged, name));
  files.push(name);
};
mkdirSync(staged, { recursive: true });
walk(source, '');

const applied = [];
for (const path of patches) {
  // No fuzz and no backups: the composed tree holds the patched source and nothing beside it.
  execFileSync('patch', ['-p1', '--fuzz=0', '--no-backup-if-mismatch', '-i', path], {
    cwd: staged,
    stdio: 'inherit',
  });
  applied.push({ name: path.split('/').at(-1), sha256: digest(readFileSync(path)) });
}
// Beside the library's own interop sources, which is where the qualified reconstruction holds them.
for (const name of ['BrowserCallbacks.cs', 'SdfTape.cs']) {
  copyFileSync(join(here, 'managed', name), join(staged, 'Library', name));
}
copyFileSync(join(here, 'PicoGK.csproj'), join(out, 'PicoGK.csproj'));
const composed = {};
const record = (current, name) => {
  if (lstatSync(current).isDirectory()) {
    for (const child of readdirSync(current).sort())
      record(join(current, child), name ? `${name}/${child}` : child);
    return;
  }
  composed[name] = digest(readFileSync(current));
};
record(out, '');
writeFileSync(
  join(out, 'composition.json'),
  `${JSON.stringify({ package: manifest.version, base: manifest.base.commit, patches: applied, files: composed }, null, 2)}\n`,
);
console.log(`Composed the managed base: ${join(out, 'PicoGK.csproj')}`);
