# Memory and limits

picovoxel, an unofficial community TypeScript/WebAssembly binding of PicoGK, keeps every voxel grid, mesh and field in WebAssembly linear memory. The JavaScript garbage collector cannot see that memory: a wrapper of a few bytes can hold a grid of hundreds of megabytes. This page covers the ceiling, how memory is released, how exhaustion is reported, and the known limits.

## The 4 GiB ceiling

Both builds (`picovoxel` and `picovoxel/multi`) are 32-bit WebAssembly linked with the same memory flags: 256 MB initial memory, growth allowed, and a 4 GB maximum. That maximum is the most a 32-bit module can address.

- **Per module.** Every `createPico` call instantiates its own module, so each session has its own linear memory and its own 4 GiB ceiling. Sessions opened on one runtime (`createPicoRuntime`) share a single module, memory and ceiling; see [Sessions sharing a runtime](#sessions-sharing-a-runtime).
- **It only grows.** WebAssembly memory cannot shrink. A session's heap stays at the size of its largest peak for the session's life, even after the objects are freed. `session.dispose()` frees every object inside that heap; the heap itself goes away when the module is garbage collected. After a fine-voxel peak in a long-lived process, dispose that session and create a new one.
- **It can fail earlier.** A browser can refuse to grow memory below 4 GiB on memory-constrained devices or under per-tab limits. Treat an out-of-memory error as an expected outcome.

## Releasing memory

Ordinary use needs no cleanup calls:

- **Garbage collection.** Every wrapper is registered with a `FinalizationRegistry`. When the wrapper is collected, its native handle is freed. Fluent chains such as `a.union(b).subtract(c)` drop their intermediates as soon as the chain ends, but the collector decides when they are freed.
- **`session.dispose()`** frees every object the session owns in one call. It is idempotent. On the multi entry it also terminates the session's worker pool. Session methods throw `PICO_DISPOSED` afterwards; do not use wrappers from a disposed session (their own `dispose()` is a safe no-op).
- **`dispose()` on any object** frees it now. It is optional and idempotent; using the object afterwards throws `PICO_DISPOSED`. Use it in tight loops that create large intermediates faster than the collector reclaims them.
- **`using`.** Sessions and wrappers implement `[Symbol.dispose]`, so `using pico = await createPico()` disposes at the end of the block.

### The `Symbol.dispose` shim

Importing any picovoxel entry runs `Symbol.dispose ??= Symbol.for('Symbol.dispose')`. The check is a feature test: on an engine with a native `Symbol.dispose` nothing changes, and on one without it the symbol is defined before your code runs, so `using` in your transpiled code finds it. The shim only defines the symbol. The `using` syntax itself needs an engine that parses it, or a compiler such as TypeScript or esbuild that rewrites it.

According to MDN's browser compatibility data (read on 2026-09-28), native `Symbol.dispose` ships in Chrome 125, Firefox 141 and Node 24; in Safari it exists only in Technology Preview. picovoxel's Safari floor is 16.4, set by wasm SIMD, so every released Safari from 16.4 on uses the shim. The repository's browser gate checks in WebKit, Chromium and Firefox that `Symbol.dispose` is defined after import.

## The memory warning

`createPico({ memoryWarningBytes })` sets a one-time warning threshold. The default is 1 GiB (2^30 bytes) and `0` disables it.

- It measures PicoGK's own count of bytes held by live objects (`session.memory.total`), not the size of linear memory.
- It is sampled when a session factory runs (`createVoxels`, `createMesh`, `createLattice`, `createPolyLine`, `createScalarField`, `createVectorField`, `voxelsFromVdb`, `meshFromStl`), at most once per second. Derived operations such as booleans and offsets do not sample it.
- It fires once per session through `console.warn`. Each session has its own threshold.

### Sessions sharing a runtime

`createPicoRuntime()` instantiates one module and opens any number of sessions on it with `runtime.createPico()`. Each session is its own PicoGK Library instance, so the memory warning counts only that session's objects, while every session on the runtime shares one heap and its 4 GiB ceiling. Two sessions can each stay under their thresholds while the heap they share fills up.

To watch the whole runtime, sample `session.module.HEAPU8.buffer.byteLength` from any of its sessions: they all report the same memory. `session.dispose()` frees that session's objects; `runtime.dispose()` disposes every open session and stops the thread pool.

To watch memory yourself, read `session.memory` (bytes per object type), `session.allocated` (live object counts), `voxels.memUsage`, and `session.module.HEAPU8.buffer.byteLength`, the size of linear memory and therefore the session's peak so far.

## Out-of-memory errors

| Code                 | Raised when                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PICO_OUT_OF_MEMORY` | picovoxel's own wasm allocation fails (mesh staging, strings, SDF tapes, metadata buffers), or a guarded native call aborts with a `WebAssembly.RuntimeError`, whose usual cause is exhausted memory |
| `PICO_ALLOC_FAILED`  | a native call that creates an object returns a null handle                                                                                                                                           |

Not every exhaustion path is typed. An allocation failure deep inside native code can surface with another code or as an untyped error. After any of these errors, treat the session as unusable: dispose it, then retry with a coarser `voxelSize`, smaller bounds, or intermediates disposed sooner.

```js
import { createPico, PicoError } from 'picovoxel';

async function build(voxelSize) {
  const pico = await createPico({ voxelSize });
  try {
    return pico.createVoxels({ shape: 'sphere', radius: 40 }).offset({ distance: 2 }).toMesh().toStl();
  } finally {
    pico.dispose();
  }
}

let stl;
try {
  stl = await build(0.2);
} catch (error) {
  if (!(error instanceof PicoError && ['PICO_OUT_OF_MEMORY', 'PICO_ALLOC_FAILED'].includes(error.code)))
    throw error;
  stl = await build(0.4);
}
```

## Voxel size and memory

`voxelSize` is the edge length of one voxel in millimetres; the default is 0.5. Halving it roughly quadruples the narrow band around every surface and multiplies volume-filling intermediates by eight, so peak memory rises steeply as voxels shrink. Peaks also depend on how many grids a model holds at once and on the allocator.

Measured on 2026-07-27 on a 12-core Apple M2 Pro, running the repository's HelixHeatX example (`examples/helixheatx`), one run per cell; the peak is the final linear-memory size:

| Voxel size | Serial build peak | Pthreads build peak |
| ---------: | ----------------: | ------------------: |
|     1.0 mm |          0.86 GiB |            1.57 GiB |
|     0.5 mm |          2.16 GiB |            2.56 GiB |
|     0.4 mm |      not measured |            3.76 GiB |

At 0.4 mm the pthreads build left 0.24 GiB below the ceiling. The first failing voxel size for this model was not located. `node bench/heatx-sweep.mjs --sizes 1.0,0.5 --builds single,multi` repeats the measurement on your machine. For a model of your own, start coarse and step down while watching the linear-memory size.

## Known limits

- **The 4 GiB ceiling.** Per module, as above: per session with `createPico`, shared by every session on a runtime. Models that need more than that at the chosen voxel size fail with an out-of-memory error; a 64-bit build is not provided.
- **GLB has no provenance slot.** picovoxel's GLB writer cannot record a lane, so `toGlb()` refuses fast-provenance geometry in every session unless the export passes `acceptLane: 'fast'`, and the acknowledged bytes record nothing. STL and `.vdb` exports carry the record. See [Lanes](lanes.md).
- **`properties()` on closed internal cavities.** `properties()` follows PicoGK's `CalculateProperties`: it meshes the grid, rebuilds a fresh grid from the mesh, and measures that. [PicoGK Discussion #118](https://github.com/leap71/PicoGK/discussions/118) reports that this round-trip returns the outer volume of a closed hollow body. That mechanism is not reproduced here, but a related misreport was measured on 2026-07-31: on the HelixHeatX example at 0.7 mm, `properties().volume` was 1.93 times the grid's own volume. Cross-check `properties().volume` against `voxels.volume` on parts with enclosed voids.
- **Nesting depth of an `SdfExpression`.** The expression compiler recurses once per nesting level, so a very deep expression overflows the JavaScript call stack and throws a plain `RangeError`, not a `PicoError`. On 2026-09-28, on Node 24.10.0 with the default stack, the limit was about 6,900 levels for a chain of binary operations and about 7,400 for a chain of unary ones; other engines and deeper call sites allow fewer, and an earlier measurement on pairwise-composed expressions found about 3,900 (engine not recorded).

  Operators that take many operands (`+`, `*`, `min`, `max`) add one level for all of them, so prefer `['min', a, b, c, …]` over nested pairs. Independently, a compiled expression is limited to 65,536 operations (`PICO_INVALID_ARGUMENT`).

- **One unreproduced trap on the pthreads build.** On 2026-07-27, one of two runs of the HelixHeatX example at 0.6 mm on the pthreads build aborted with `Illegal instruction`. Five later runs of the same configuration after an unrelated fix completed with the expected bytes, and no cause was found. If you hit a wasm trap at fine voxel sizes, report it with the crash output.
- **`Symbol.dispose` shim range.** The shim runs on every engine without a native `Symbol.dispose`, which includes every released Safari (see above). It defines the symbol only; `using` syntax still needs engine or compiler support.

## See also

- [Lanes](lanes.md)
- [Threads and isolation](threads-and-isolation.md)
- [README](../README.md)
