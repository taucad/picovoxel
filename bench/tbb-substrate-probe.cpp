// SK-0.7 — evidence probe for the three vendored oneTBB substrate fixes
// (patches/oneTBB/0001-wasm-substrate-edges.patch). Build it against a pristine
// prefix and a patched one and diff the output; every number below is either
// deterministic arithmetic or a behavioural count, not a wall-clock claim
// (the pause microbench is the one timing, and its A/B ratio is ~50×).
//
//   emcc ... -pthread -sPROXY_TO_PTHREAD -sSTACK_SIZE=8388608 \
//     -I<prefix>/include bench/tbb-substrate-probe.cpp <prefix>/lib/libtbb.a
//
// PROXY_TO_PTHREAD is load-bearing: TBB launches its workers through a chain of
// pthread_create calls that emscripten proxies *synchronously* to the main
// runtime thread, so a main() that calls parallel_for without ever returning to
// the event loop can never get a pool (that is Finding 5 / the multi.ts warmup).
// Under PROXY_TO_PTHREAD main() runs on a pthread with the full -sSTACK_SIZE
// stack, which is the same shape as picovoxel's external thread.
#include <atomic>
#include <cstdint>
#include <cstdio>

#include <malloc.h>

#include <emscripten/stack.h>
#include <emscripten/threading.h>

#include <oneapi/tbb/blocked_range.h>
#include <oneapi/tbb/detail/_machine.h>
#include <oneapi/tbb/parallel_for.h>
#include <oneapi/tbb/global_control.h>
#include <oneapi/tbb/spin_mutex.h>
#include <oneapi/tbb/task_arena.h>

namespace {

constexpr int kSlots = 64;
std::atomic<long> g_bodies[kSlots];
std::atomic<long> g_tasks[kSlots];

void spin_work(int iters) {
    volatile double x = 1.0;
    for (int i = 0; i < iters; ++i) x = x * 1.0000001 + 1e-9;
}

// One parallel_for with one task per index (simple_partitioner + grainsize 1),
// so which slot runs how much is decided purely by the scheduler.
void run_parallel(long n, int work) {
    for (int i = 0; i < kSlots; ++i) { g_bodies[i].store(0); g_tasks[i].store(0); }
    tbb::parallel_for(tbb::blocked_range<long>(0, n, 1), [work](const tbb::blocked_range<long>& r) {
        int idx = tbb::this_task_arena::current_thread_index();
        if (idx >= 0 && idx < kSlots) {
            g_tasks[idx].fetch_add(1, std::memory_order_relaxed);
            g_bodies[idx].fetch_add(static_cast<long>(r.size()), std::memory_order_relaxed);
        }
        for (long i = r.begin(); i < r.end(); ++i) spin_work(work);
    }, tbb::simple_partitioner{});
}

void report_participation(const char* label) {
    int participants = 0;
    long total = 0;
    for (int i = 0; i < kSlots; ++i) {
        long t = g_tasks[i].load();
        if (t > 0) ++participants;
        total += t;
    }
    printf("%s participants=%d/%d slot0_tasks=%ld total_tasks=%ld\n",
           label, participants, tbb::this_task_arena::max_concurrency(),
           g_tasks[0].load(), total);
    printf("%s per-slot:", label);
    for (int i = 0; i < kSlots; ++i) {
        long t = g_tasks[i].load();
        if (t > 0) printf(" %d:%ld", i, t);
    }
    printf("\n");
}

// Recurse to burn a known amount of the caller's C stack before entering the
// parallel region. Every frame keeps a volatile array so the bytes are really
// on the linear-memory stack (wasm only spills address-taken/oversized locals).
long __attribute__((noinline)) deep(int depth, long n, int work) {
    volatile char pad[8192];
    pad[0] = static_cast<char>(depth);
    pad[8191] = static_cast<char>(depth);
    if (depth > 0) return deep(depth - 1, n, work) + pad[0];

    std::uintptr_t base = reinterpret_cast<std::uintptr_t>(emscripten_stack_get_base());
    std::uintptr_t end = reinterpret_cast<std::uintptr_t>(emscripten_stack_get_end());
    std::uintptr_t sp = reinterpret_cast<std::uintptr_t>(&pad[0]);
    std::size_t worker_stack =
        tbb::global_control::active_value(tbb::global_control::thread_stack_size);
    // What governor.cpp computes for the external thread: base - stack_size/2,
    // where stack_size is the fallback (worker stack) before the patch and the
    // thread's real size after it. can_steal() is SP > threshold.
    std::uintptr_t threshold_fallback = base - worker_stack / 2;
    std::uintptr_t threshold_real = base - (base - end) / 2;
    printf("deep-stack: base=0x%zx end=0x%zx real_size=%zu sp=0x%zx depth_used=%zu\n",
           (size_t)base, (size_t)end, (size_t)(base - end), (size_t)sp, (size_t)(base - sp));
    printf("thresholds: worker_stack=%zu fallback_threshold=0x%zx (steal=%s) "
           "real_threshold=0x%zx (steal=%s)\n",
           worker_stack, (size_t)threshold_fallback, sp > threshold_fallback ? "yes" : "NO",
           (size_t)threshold_real, sp > threshold_real ? "yes" : "NO");

    run_parallel(n, work);
    report_participation("deep");
    return pad[8191];
}

// machine_pause() is what atomic_backoff and prolonged_pause() spend their
// budget on. Time it on a worker thread — the main runtime thread deliberately
// keeps yielding even after the patch (proxy-queue drain).
void pause_cost() {
    std::atomic<double> ns{-1.0};
    tbb::parallel_for(0, 1, [&](int) {
        if (emscripten_is_main_runtime_thread()) return;  // want a worker
        constexpr int kReps = 200000;
        double t0 = emscripten_get_now();
        for (int i = 0; i < kReps; ++i) tbb::detail::d0::machine_pause(16);
        double t1 = emscripten_get_now();
        double v = (t1 - t0) * 1e6 / kReps;
        double expect = -1.0;
        ns.compare_exchange_strong(expect, v);
    });
    printf("machine_pause(16): %.1f ns/call (worker thread)\n", ns.load());
}

// Contended spin_mutex: every acquisition failure spins through machine_pause.
void contended_mutex(long ops) {
    tbb::spin_mutex mtx;
    volatile long counter = 0;
    double t0 = emscripten_get_now();
    tbb::parallel_for(tbb::blocked_range<long>(0, ops, 64), [&](const tbb::blocked_range<long>& r) {
        for (long i = r.begin(); i < r.end(); ++i) {
            tbb::spin_mutex::scoped_lock lock(mtx);
            counter = counter + 1;
        }
    }, tbb::simple_partitioner{});
    double t1 = emscripten_get_now();
    printf("contended spin_mutex: %ld ops in %.1f ms (%.1f ns/op) counter=%ld\n",
           ops, t1 - t0, (t1 - t0) * 1e6 / ops, (long)counter);
}

}  // namespace

int main() {
    // Enough work per region that every worker has time to engage; at ~40 us a
    // task the whole region is ~80 ms, ~7 ms per thread. With a tiny body the
    // participation count just samples pool wake-up latency and means nothing.
    constexpr long kN = 2048;
    constexpr int kWork = 20000;
    // Join the workers before the runtime tears down: emscripten's exit with
    // live pthreads traps intermittently (~20% of runs, SIGILL, no message).
    tbb::task_scheduler_handle handle{tbb::attach{}};

    printf("hw_concurrency=%d max_concurrency=%d is_main_runtime_thread=%d\n",
           tbb::info::default_concurrency(), tbb::this_task_arena::max_concurrency(),
           emscripten_is_main_runtime_thread());
    printf("worker_stack_size=%zu\n",
           (size_t)tbb::global_control::active_value(tbb::global_control::thread_stack_size));

    // Worker stacks live in the heap: emscripten's pthread_create mallocs one
    // block per thread holding {pthread struct, TLS, TSD, stack} and honours
    // attr._a_stacksize, which is what TBB sets from worker_stack_size. So the
    // heap delta across pool launch *is* the pool's stack reservation.
    size_t heap_before = mallinfo().uordblks;

    // Warm the pool, then measure at steady state. `shallow` is the control for
    // `deep`: same region, same work, only the caller's stack depth differs.
    run_parallel(kN, kWork);
    report_participation("warm");
    printf("pool heap delta: %zu bytes for %d workers (%zu bytes/worker)\n",
           (size_t)(mallinfo().uordblks - heap_before),
           tbb::this_task_arena::max_concurrency() - 1,
           (size_t)((mallinfo().uordblks - heap_before) /
                    (tbb::this_task_arena::max_concurrency() - 1)));
    run_parallel(kN, kWork);
    report_participation("shallow");

    pause_cost();
    contended_mutex(200000);

    // ~64 KB of external-thread stack burned before the region: past
    // base - 65536/2, the pre-patch stealing threshold.
    deep(8, kN, kWork);
    // Control again, to show the deep number is depth and not drift.
    run_parallel(kN, kWork);
    report_participation("shallow2");
    printf("done\n");
    tbb::finalize(handle);
    return 0;
}
