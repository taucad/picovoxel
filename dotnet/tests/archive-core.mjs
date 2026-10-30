/** Run the linked C++ archive witness (this does not run the threaded .NET host). */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length !== 3) throw new Error('Usage: archive-core.mjs <archive build directory>');
const root = resolve(process.argv[2]);
process.chdir(root);
const { default: create } = await import(pathToFileURL(resolve(root, 'link-check.mjs')));
await create({
  onExit: (code) => {
    process.exitCode = code;
  },
});
// The synchronous C++ main has returned; release idle Emscripten pool workers.
process.exit(process.exitCode ?? 0);
