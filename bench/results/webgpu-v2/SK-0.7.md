# SK-0.7 — TBB/emscripten substrate edges: warmup poll, pause spin, steal budget, 1 MB worker stacks

**Date**: 2026-07-26 · **Branch**: `webgpu-sk07` (off `webgpu` @ `d8ccfb5`) · **Audit**: `docs/research/tbb-emscripten-substrate-audit.md` F2–F5

## Verdict

All four edges landed and each verified independently. Three are vendored oneTBB patches
(`patches/oneTBB/0001-wasm-substrate-edges.patch`, all upstreamable), one is picovoxel TS.

| # | Fix | Verification | Result |
| --- | --- | --- | --- |
| F5 | warmup: fixed 100 ms sleep → pool-readiness poll (`src/multi.ts`) | 10 cold `createPico` per variant, one per process | **201.5 → 105.8 ms** median (−96 ms). Instrumented poll exits in **2–4 ms** with 11/11 workers |
| F2 | `machine_pause` on wasm: JS-boundary `sched_yield` → in-register spin | probe A/B, `machine_pause(16)` on a worker | **65.8 → 2.1 ns/call** (31×), n=9/10. Contended `spin_mutex` shape: **no measurable change** |
| F3 | external-thread steal budget from the real stack, not the worker fallback | probe A/B, external thread's task share at 72 KB stack depth | deep/shallow share **0.71 → 0.98** (governor fix alone). `can_steal` at 72 KB: **NO → yes** |
| F4 | worker stacks 64 KB → 1 MB (CMake knob made overridable) | probe + dep build log + heap accounting | `worker_stack_size` **65536 → 1048576**; knob previously ignored |

Byte parity: **451/451 tests pass**, the six byte-locked fixtures in `test/fixtures/` are
untouched, and `src/pico-multi.mjs` is **byte-identical** to `d8ccfb5` — the whole delta is
inside compiled TBB code in `src/pico-multi.wasm`.

## Two audit claims that did NOT reproduce

**1. "~96 MB of worker stack reservation to reclaim" — false; 1 MB stacks *cost* ~10.3 MB.**
Emscripten's `pthread_create` mallocs one block per thread holding
`{pthread struct, TLS, TSD, stack}` and honours `attr._a_stacksize`
(`system/lib/pthread/pthread_create.c:140-215`); TBB always passes one
(`rml_thread_monitor.h:187-214`). Workers therefore never got the 8 MB
`-sSTACK_SIZE`/`DEFAULT_PTHREAD_STACK_SIZE` default, and 12 × 8 MB was never reserved.
Measured heap delta across pool launch (`mallinfo().uordblks`, 11 workers):

| worker stack | pool heap delta | per worker |
| --- | --- | --- |
| 64 KB (before) | 855,744 – 858,840 B (~0.82 MiB) | ~77.9 KB |
| 1 MB (after) | 11,669,928 – 11,672,888 B (~11.1 MiB) | ~1,061 KB |

So the real number is **+10.3 MiB**, of a 256 MB initial heap, bought deliberately: F4 is a
robustness fix (deep OpenVDB tree recursion on a 64 KB stack with no `-O3` overflow check =
silent heap corruption), not a memory win. The ~13.9 KB/worker of non-stack overhead is
visible in both rows and confirms the accounting.

**2. "participation below 12/12 on some parallel_for shapes" — participation was already
12/12.** Every configuration, every run, every shape: `participants=12/12`. The external
thread does not vanish when it cannot steal, because it still drains its own deque. What it
loses is *share*: at 72 KB of stack depth it executed **0.71×** the tasks it executed at
shallow depth, and the fix restores that to 0.98–1.02×. The exit assertion holds (12/12) but
the metric that actually moves is the task share, reported below.

## Machine state

| | |
| --- | --- |
| CPU / RAM | Apple M2 Pro, 12 cores, 32 GiB |
| OS / node | darwin 25.5.0 / v26.5.0 |
| Power | **AC**, `lowpowermode 0` |
| Load | 5.5–6.9 throughout — a **sibling spike (SK-0.2) shared the machine** |
| Known resident process | Codex (operator-required) |

Because of the shared load, every claim here is either an exact value (a flag, a symbol
count, a stack size), a behavioural count (participation, worker count), or a ratio whose
A/B ranges do not overlap (pause cost 31×, warmup 2×). The one wall-clock shape that came
out inside the noise — the contended `spin_mutex` microbench — is reported as a null result,
not as a win.

## The four fixes

### F5 — warmup poll (`src/multi.ts`, picovoxel-only)

The yielding is load-bearing: TBB launches workers through a chain of `pthread_create` calls
that emscripten proxies *synchronously* to the main runtime thread, so the handshake only
completes while that thread is off the wasm stack. The *duration* was a guess. Replaced with
a poll of `module.PThread.runningWorkers` up to `hardwareConcurrency - 1`, keeping the old
100 ms constant as the deadline so no host is worse off than before.

10 cold samples per variant, one `createPico` per process (whole-call wall, i.e. module
instantiation + priming op + warmup):

| variant | median | range | workers at return |
| --- | --- | --- | --- |
| fixed 100 ms sleep | 201.5 ms | 195.1–206.3 (n=9) | 11/11 |
| readiness poll | 105.8 ms | 101.6–118.7 (n=10) | 11/11 |

Ranges are disjoint. Instrumenting the loop itself: **POLL 2–4 ms, workers=11** on five
consecutive runs — the pool is ready roughly 25× sooner than the sleep assumed (the audit
guessed ~11 ms), and the poll observes it rather than assuming it.

### F2 — `machine_pause` (vendored patch, `_machine.h`)

wasm fell to TBB's Generic branch: one `yield()` per pause, which under emscripten is
`sched_yield` → `_emscripten_yield(emscripten_get_now())`, a JS import call — and the branch
ignores `delay`, so `atomic_backoff`'s 1,2,4,…,16 shape flattened to one JS call per
iteration. Now: in-register spin (empty volatile asm as the compiler barrier), with the main
runtime thread still yielding because *its* yield is what drains the proxy queue that worker
launch (F5) depends on.

| | pristine | patched |
| --- | --- | --- |
| `machine_pause(16)` on a worker | **65.8 ns** (n=9, 60.1–69.0) | **2.1 ns** (n=10, 2.1–2.7) |
| contended `spin_mutex`, 200 k ops | 95.8 ms (n=9, 60.4–116) | 96.0 ms (n=10, 71.5–99.8) |

The pause cost is 31× lower; the contended-mutex shape does **not** move — `spin_mutex`'s
backoff escalates to yielding/parking quickly enough that the pause cost is not its
bottleneck under this load. The value of F2 is the restored backoff *shape* on the stealing
loop (`prolonged_pause`'s 80-pause budget was collapsing to a single 55 ns yield), which is
what F3's measurement below actually exercises.

Artifact-level proof the patch is in what ships: `emscripten_is_main_runtime_thread` is a
symbol the patch alone introduces. `llvm-nm` on the linked archives —

| archive | references |
| --- | --- |
| pristine `libtbb.a` | 0 |
| `build/wasm-prefix-mt/lib/libtbb.a` (shipped multi) | 23 |
| `build/wasm-prefix/lib/libtbb.a` (shipped serial) | 23 |

### F3 — external-thread steal budget (vendored patch, `governor.cpp`)

`get_stack_attributes` filled `stack_base` on emscripten but left `stack_size` at the
caller's fallback — the *worker* stack size — even though its only caller is
`init_external_thread()`, and the external thread runs on `-sSTACK_SIZE`. The stealing
threshold `base - stack_size/2` was therefore 32 KB below base on an 8 MB stack.

Probe, external thread 72,496 B deep (8 × 8 KB frames + probe frames), 2048 tasks:

| config | `can_steal` at that depth | shallow slot-0 tasks | deep slot-0 tasks | deep/shallow |
| --- | --- | --- | --- | --- |
| pristine | **NO** (`sp` below `base - 65536/2`) | 181 (n=9) | 128 (n=9) | **0.71** |
| patched, 64 KB worker stacks | yes (real size used) | 177 (n=9) | 173 (n=9) | **0.98** |
| patched, 1 MB worker stacks | yes | 174 (n=10) | 178 (n=10) | **1.02** |

The middle row isolates the governor patch from F4: same 64 KB worker stacks, deficit gone.
Fair share is 2048/12 ≈ 171. Participation was 12/12 in all 28 runs.

### F4 — worker stack size (vendored patch, `Clang.cmake` + build script)

`set(TBB_EMSCRIPTEN_STACK_SIZE 65536)` was a plain `set()`, so
`-DTBB_EMSCRIPTEN_STACK_SIZE=…` on the cmake line was silently ignored — the probe reported
`worker_stack_size=65536` while being built with `-DTBB_EMSCRIPTEN_STACK_SIZE=1048576`.
Guarded with `if (NOT DEFINED …)`; `scripts/build-deps-wasm.sh` now passes 1048576
(`TBB_STACK_SIZE=` overrides).

- Dep build log carries `-D__TBB_EMSCRIPTEN_STACK_SIZE=1048576` for both prefixes.
- Probe reports `worker_stack_size=1048576`.
- Heap accounting: see the non-reproduction section above (+10.3 MiB).

Deepest-recursion fixture: **`test/examples-helixheatx.test.ts`** (HeatX — the deepest
OpenVDB tree work in the suite: lattice creation, level-set offsets and `volumeToMesh` over
the largest grids we build, byte-locked against `test/fixtures/helixheatx.json`) passes
unchanged, as does the whole 451-test suite.

## Suite and byte parity

```
Test Files  49 passed (49)
Tests       451 passed (451)
```

(451, not 453: the two extra tests in the operator's working tree are uncommitted
`examples/pico/modular-gyroid-puzzle.ts` work not present at `d8ccfb5`.)

`git status` after the rebuild shows no change to `test/fixtures/`; fixture sha256:

| fixture | sha256 |
| --- | --- |
| helixheatx.json | 56298c702d37ed991180117019e16edf584d2f01291b34e327053ec1d74c2eec |
| latticelibrary-examples.json | 9e360d57ee590b2d3bc0ea26620eaad182ec7e0e5477904586e9d09705af6c0a |
| quasicrystals.json | b120759423e59d2319626719cf1222adf003a2f0a2213ec96a2978913ec9f1c0 |
| roverwheel.json | 5a5ee9da71e7f6920e9cc6db0f85eae0e263a350a0af8cd054729d291f718749 |
| shapekernel-examples.json | 52e2702d51b41b2b2dc18a67de1b15628ff536f78f929d25266d4ce94504218f |
| simulation.json | 08c9a479c2e225cbcc35699422865a93998956c4e2be8e0c1c76805d6fe926b6 |

## Artifacts

| file | sha256 |
| --- | --- |
| `src/pico-multi.wasm` (new) | 1b5930bab561b37d6641e664991504304d280526ce8a96591d50c512adbdd068 |
| `src/pico-multi.wasm` (`d8ccfb5`) | fc9cf68f31a521b08ae5d56e6b5d3bdd3c4dda099b79278574d828f08a54777c |
| `src/pico-multi.mjs` (unchanged) | a22d816296dc0cd370eeeaa3e5f0d249638937f19608ae08f9fd613239c00684 |
| `patches/oneTBB/0001-wasm-substrate-edges.patch` | 92dd876dfd000e164e20574bca950322e8266dcebabfb2c5fc0a2afbce4792f0 |
| `bench/tbb-substrate-probe.cpp` | 4733df09b115511a9d85b935e73ddffe5408ed9599222c0a7a873139dcb4bdb4 |

Raw probe output: `sk-0.7-probe-{pristine,patched65k,patched}.txt` (5 runs each; the pooled
statistics above also include 6 earlier runs per config from the same binaries).

## Reproducing

```bash
bash scripts/fetch-deps.sh                       # extracts + applies patches/oneTBB
THREADS=1 bash scripts/build-deps-wasm.sh && THREADS=0 bash scripts/build-deps-wasm.sh
THREADS=1 bash scripts/build-pico-module.sh && THREADS=0 bash scripts/build-pico-module.sh
npm run build && npx vitest run

# probe (build twice: pristine tarball vs vendor/oneTBB), see the header of the .cpp
em++ -std=c++20 -O3 -msimd128 -pthread -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1 \
  bench/tbb-substrate-probe.cpp <prefix>/lib/libtbb.a -I<prefix>/include -o probe.cjs \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=16 -sSTACK_SIZE=8388608 \
  -sINITIAL_MEMORY=256MB -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1
```

## Known flake (pre-existing, not introduced here)

The probe binary exits with SIGILL (no message, no output past the current line) on roughly
1 run in 6, in **every** configuration including pristine oneTBB. Adding
`tbb::finalize(handle)` reduced but did not eliminate it. It is an emscripten-pthreads/node
teardown artifact of the probe harness — the 451-test suite and the module itself show no
such behaviour — but anyone re-running the probe should expect to discard a run.
