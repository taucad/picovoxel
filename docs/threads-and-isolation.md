# Threads and cross-origin isolation

picovoxel, an unofficial community TypeScript/WebAssembly binding of PicoGK, ships two builds of the same WebAssembly module behind two entry points. They export the same names, so switching between them is a one-specifier change.

| Entry             | Files                               | Threads                         | Allocator | Extra runtime requirement                               |
| ----------------- | ----------------------------------- | ------------------------------- | --------- | ------------------------------------------------------- |
| `picovoxel`       | `pico.mjs`, `pico.wasm`             | one                             | dlmalloc  | none                                                    |
| `picovoxel/multi` | `pico-multi.mjs`, `pico-multi.wasm` | a pthread pool driven by oneTBB | mimalloc  | `SharedArrayBuffer`: cross-origin isolation in browsers |

Both builds use wasm SIMD (`-msimd128`), start with 256 MB of linear memory and can grow to 4 GB (see [Memory and limits](memory-and-limits.md)).

## Which entry to choose

Choose `picovoxel` when:

- the page cannot be cross-origin isolated;
- you need byte-for-byte reproduction of reference results: the repository's pinned fixtures are locked on the serial build (see [Lanes](lanes.md));
- memory headroom matters more than speed: the pthreads build has measured higher peak memory on the same model (see [Memory and limits](memory-and-limits.md)).

Choose `picovoxel/multi` for large models in Node or on an isolated page. The parallel work happens inside PicoGK and OpenVDB (offsets, booleans, lattice rendering, mesh extraction), and in implicit fills given as a serializable `SdfExpression`, which are compiled to a tape and evaluated on every worker. An implicit given as a JavaScript function runs on the calling thread, one sample at a time, on either entry.

```js
import { createPico } from 'picovoxel/multi';

const pico = await createPico({ voxelSize: 0.5 });
```

All calls are synchronous: they block the thread that makes them, on either entry.

## Browser requirements

**Serial.** Serve `pico.wasm` next to `pico.mjs` with `Content-Type: application/wasm`. No isolation headers are needed.

**Multi.** The shared wasm memory needs `SharedArrayBuffer`, which browsers expose only to cross-origin isolated pages. Serve the document with both headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Cross-Origin-Embedder-Policy: credentialless` also isolates the page in browsers that support it. Under either value, cross-origin subresources must opt in through CORS or `Cross-Origin-Resource-Policy`. Check `globalThis.crossOriginIsolated` at run time.

`pico-multi.mjs` is also the module script of every pthread worker, so serve it and `pico-multi.wasm` from the page's own origin. A page that may or may not be isolated can pick the entry at load time:

```js
const { createPico } = globalThis.crossOriginIsolated
  ? await import('picovoxel/multi')
  : await import('picovoxel');
```

The repository's browser gate runs the serial entry in Chromium, WebKit and Firefox. The pthreads entry is tested in Node; it is not exercised by the browser gate.

## The worker pool

A build flag sets the pool size to `navigator.hardwareConcurrency`; `createPico` has no option for it.

1. When the module instantiates, the glue creates `navigator.hardwareConcurrency` workers and loads the module into each before instantiation resolves. The pool is created up front because a main thread blocked inside a parallel loop cannot spawn new workers.
2. `createPico` then runs a small warm-up (a sphere and an offset) and yields to the event loop, polling until at least `navigator.hardwareConcurrency - 1` workers are running or 100 ms have passed. oneTBB starts its workers on the first parallel region, and that handshake completes only while the main thread is off the wasm stack. Without the warm-up, back-to-back synchronous calls could stay single-threaded.

Every `createPico` call instantiates its own module, with its own linear memory and its own pool. `session.dispose()` terminates that session's workers. Reuse one session rather than holding many at once.

## Node

Both entries work in Node 22.14.0 or later with no configuration. The multi entry spawns its pool with `worker_threads`. Pool workers are unreferenced, so idle workers never keep the process alive.

Call `session.dispose()` before the process exits. It joins the session's pool; a pthread worker still executing while the process tears down wasm memory has been observed to crash the process.

## Determinism across the two builds

Every parallel operation writes each voxel from exactly one thread, as a pure function of its coordinate and its frozen inputs, so results do not depend on scheduling. The test suite checks this by running each model once on each entry, at the test machine's thread count:

| Test                               | Model                                                           | Compared                                |
| ---------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `test/multi.test.ts`               | sphere minus a beam at 0.5 mm                                   | volume, triangle and vertex counts      |
| `test/multi.test.ts`               | gyroid `SdfExpression` fill, `withImplicit`, `maskedByImplicit` | volume and STL bytes                    |
| `test/multi.test.ts`               | offset family in a `fastRenorm` session at 0.4 mm               | full grid hash record, level-set health |
| `test/examples-helixheatx.test.ts` | the HelixHeatX example at 1.0 mm                                | volume and STL bytes                    |
| `test/examples-helixheatx.test.ts` | the HelixHeatX example at 0.7 mm, pthreads build                | pinned volume and triangle count        |

The tests do not sweep thread counts. As a separate measurement, on 2026-07-27 on a 12-core Apple M2 Pro, five pthreads runs each at 0.5, 0.6 and 0.7 mm of the HelixHeatX example gave one STL byte stream per voxel size, identical to the serial build.

## Asset subpaths

| Subpath                  | File                   | Loaded by                                  |
| ------------------------ | ---------------------- | ------------------------------------------ |
| `picovoxel/wasm`         | `dist/pico.wasm`       | the serial glue                            |
| `picovoxel/glue`         | `dist/pico.mjs`        | `picovoxel` (static import)                |
| `picovoxel/multi/wasm`   | `dist/pico-multi.wasm` | the pthreads glue                          |
| `picovoxel/multi/worker` | `dist/pico-multi.mjs`  | `picovoxel/multi` and every pthread worker |

By default each glue finds its files with `new URL('<file>', import.meta.url)`, relative to the glue itself. That works in Node and in unbundled ES modules, where the files stay siblings. A bundler has to either rewrite that pattern and emit the files next to the glue, or you pass the locations yourself through `createPico({ wasm })`:

- `locateFile(file)` receives `pico.wasm` or `pico-multi.wasm` and returns its URL (a path also works in Node). It is not consulted when `instantiateWasm` is given.
- `mainScriptUrlOrBlob` is the pthread worker script, passed to `new Worker(..., { type: 'module' })` for each worker. In Node it must be a filesystem path, because `worker_threads` treats a string as a path.
- `instantiateWasm(imports, receive)` lets the host supply a compiled `WebAssembly.Module`. Pass the module as the second argument to `receive`: the pthread workers then receive it from the main thread and never fetch the wasm themselves.

### With a bundler

Use the bundler's own asset-URL import. With Vite, the `?url` suffix is its documented explicit URL import:

```js
import { createPico } from 'picovoxel';
import wasmUrl from 'picovoxel/wasm?url';

const pico = await createPico({ wasm: { locateFile: () => wasmUrl } });
```

```js
import { createPico } from 'picovoxel/multi';
import wasmUrl from 'picovoxel/multi/wasm?url';
import workerUrl from 'picovoxel/multi/worker?url';

const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
const pico = await createPico({
  wasm: {
    mainScriptUrlOrBlob: workerUrl,
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
      return {};
    },
  },
});
```

These Vite snippets are not exercised by this repository's CI. For other bundlers, check how they turn a package file into a URL. Write `new URL('picovoxel/wasm', import.meta.url)` only if your bundler documents resolving package specifiers in that pattern: plain JavaScript resolves the string relative to the current module, not as a package.

### In Node

`import.meta.resolve` returns a `file:` URL in Node. Convert it with `fileURLToPath` wherever a path is required:

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPico } from 'picovoxel/multi';

const resolvePath = (specifier) => fileURLToPath(import.meta.resolve(specifier));
const module = await WebAssembly.compile(await readFile(resolvePath('picovoxel/multi/wasm')));
const pico = await createPico({
  wasm: {
    mainScriptUrlOrBlob: resolvePath('picovoxel/multi/worker'),
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
      return {};
    },
  },
});
```

The package test runs this form, and `locateFile` on the serial entry, against the packed tarball. Compiling once and reusing the module saves the compile cost for every later session.

## See also

- [Lanes](lanes.md)
- [Memory and limits](memory-and-limits.md)
- [README](../README.md)
