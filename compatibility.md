# Compatibility

Every check mark names the job in `.github/workflows/ci.yml` that proves it on each pull request. A row
without a check mark is supported by design but not gated by CI; its note says what that rests on.

## Hosts

| Host                  | `picovoxel` (serial) | `picovoxel/multi` (pthreads) | CI evidence                                                      |
| --------------------- | -------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Node 22.14.0          | ✅                   | ✅                           | `test-unit (node 22.14.0)`, `consumer (node 22.14.0)`            |
| Node 26               | ✅                   | ✅                           | `test-unit (node 26)`, `consumer (node 26)`, `test-subjects (*)` |
| Chromium (Playwright) | ✅                   | Not gated                    | `browser (chromium)`                                             |
| Firefox (Playwright)  | ✅                   | Not gated                    | `browser (firefox)`                                              |
| WebKit (Playwright)   | ✅                   | Not gated                    | `browser (webkit)`                                               |

- The browser jobs load the serial entry from the packed candidate and compare pure-wasm results with Node
  records, hex-float exact. The multithreaded entry runs in browsers only on a cross-origin isolated page
  ([threads](docs/threads-and-isolation.md)); no CI job serves such a page.
- Browser floor by design: wasm SIMD and wasm exception handling set the floor at Safari 16.4, Chrome 95
  and Firefox 100. The `Symbol.dispose` shim in `src/dispose.ts` defines the symbol where the host lacks it, which
  includes every released Safari (MDN compatibility data, September 2026). Only the current Playwright engines are tested.
- Node floor: `engines` is `>=22.14.0`. Building the package from source needs Node `^22.18.0 || >=24.11.0`,
  the range its build tools declare; CI builds on Node 26.
- TypeScript: consumers need TypeScript 5.7 or later, because the declarations use typed-array generics
  such as `Uint8Array<ArrayBuffer>`. They also use `Symbol.dispose`, so a consumer's `lib` needs
  `esnext.disposable` (or `esnext`). The repository compiles with TypeScript 6.0.3.
- The package is ESM-only. `require('picovoxel')` throws an ESM-only error, and its types are `never`.

## Known issues

- **Dispose pthreads sessions before a Node process exits.** `pico.dispose()` stops the thread pool. Pool
  workers left running while the process tears down shared memory were seen to abort the process with
  "Illegal instruction"; one such abort at 0.6 mm voxels (one of two runs, July 2026) has no confirmed
  cause and did not recur in five later runs. See [memory and limits](docs/memory-and-limits.md#known-limits).
- **Closed internal cavities in `properties()`.** The volume and area come from a mesh round trip, which
  PicoGK users report can fill a closed internal cavity (PicoGK Discussion #118); picovoxel has not
  reproduced it. Check the results for parts with closed internal voids another way before relying on them.
- **Deep implicit expressions.** The implicit tape evaluator recurses once per nesting level, so a very deep
  expression overflows the JavaScript stack (about 6,900 levels on Node 24, fewer on other engines); see [memory and limits](docs/memory-and-limits.md#known-limits).
- **4 GiB memory.** Both builds are wasm32 with a 4 GiB maximum heap, and memory grows quickly as the voxel
  size shrinks; `createPico({ memoryWarningBytes })` warns before the ceiling.
- **The memory warning is per session.** Sessions on one `createPicoRuntime()` share a heap, but each
  session's warning counts only its own objects, so none of them sees the shared total; see
  [sessions sharing a runtime](docs/memory-and-limits.md#sessions-sharing-a-runtime).
- **GLB has no lane record.** A GLB cannot carry the `fast` lane stamp that STL and `.vdb` carry, so
  `toGlb()` refuses fast-lane geometry unless you pass `{ acceptLane: 'fast' }` ([lanes](docs/lanes.md)).
