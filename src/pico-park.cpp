// Grid park and restore: one grid streamed as compressed frames to a host sink
// outside the wasm heap, and rebuilt from a host source (src/pager.ts drives it).
//
// Image = frames of {u32 kind, u32 raw, u32 comp, u32 check} + comp bytes; `check` is
// XXH32 of the comp bytes, verified before anything is decoded:
//   kind 2  header (stored): magic, transform, codec, level, block leaves, background, leaf count
//   kind 0  topology bytes (meta + transform + Tree::writeTopology) in 1 MiB chunks through the codec
//   kind 1  leaf block: `raw` leaves in tree order through k7codec
// Frames are emitted in tree order, so every mode writes the same bytes.
//
// Encode arena (D13): K7_nArena takes the codec slots once, while the heap has room, plus a
// reserve that every park releases first and K7_nRearm re-takes after the parked grid is
// destroyed. A park allocates nothing else before its first leaf is freed, so a park that
// runs out of memory leaves the grid intact.
//
// Modes (D14), one ring of slots for all three:
//   0 serial     each slot is coded on the calling thread as it is launched
//   1 pooled     slots are coded in waves with tbb::parallel_for (K15)
//   2 pipelined  slots are enqueued on a oneTBB arena while the calling thread walks topology,
//                stores frames and frees leaves (park) or pulls frames and allocates leaves
//                (restore); it runs a queued slot itself rather than wait (K17)
// Mode 2 needs a pool and two slots; without them it runs as mode 1, which on one thread is serial.
//
// Results: K7_nPark returns the image bytes; -1 or -2 when it failed with the grid intact
// (-2: out of memory); -3 when it failed after leaves were freed, so the grid is damaged and
// must be destroyed. K7_hRestore returns 0 on failure. K7_nLastError() says why: 1 out of
// memory (the heap, or the host store reporting itself full), 2 anything else (corrupt image,
// unsupported codec, host I/O).

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/io/io.h>

#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>
#include <tbb/task_arena.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <istream>
#include <new>
#include <ostream>
#include <streambuf>
#include <thread>
#include <vector>

#define XXH_INLINE_ALL
#include "xxhash.h"

#include "k7codec.h"

extern "C" {
/// Host sink: 0 ok, 1 the store is full, 2 any other failure.
typedef int32_t (*PKParkSink)(const char* pBytes, int32_t nBytes);
/// Host source: bytes filled, 0 at the end, negative on failure.
typedef int32_t (*PKParkSource)(char* pBytes, int32_t nCapacity);
}

namespace {

using LeafT = openvdb::FloatTree::LeafNodeType;

struct Frame { uint32_t nKind, nRaw, nComp, nCheck; };
struct Header { uint32_t nMagic; int32_t nTransform, nCodec, nLevel, nBlockLeaves; float fBackground; uint64_t nLeaves; };
constexpr uint32_t nMagic       = 0x374b5650u; // "PVK7"
constexpr size_t   nTopoChunk   = size_t(1) << 20;
constexpr size_t   nFrameAt     = sizeof(Frame); // a slot's payload starts after room for its frame header
constexpr int32_t  nMaxLeaves   = (int32_t) K7_MAX_LEAVES; // the largest block a park, restore or arena takes
constexpr int32_t  nMaxSlots    = 64;                      // the pager's arena.slots bound
constexpr int32_t  nErrMemory   = 1;
constexpr int32_t  nErrOther    = 2;

int32_t g_nLastError = 0;

inline uint32_t nCheck(const uint8_t* p, size_t n) { return XXH32(p, n, nMagic); }

inline void MaskWords(const LeafT& oLeaf, uint64_t* pWords)
{
    const auto& oMask = oLeaf.getValueMask();
    for (uint32_t n = 0; n < 8; ++n)
        pWords[n] = oMask.template getWord<uint64_t>(n);
}

// One slot = one codec context and one buffer for one frame:
// [frame header room][compressed payload ...][raw topology chunk (nTopoChunk)].
struct Slot
{
    K7Ctx*   pCtx     = nullptr;
    uint8_t* pBuf     = nullptr;
    size_t   nCap     = 0;
    LeafT**  apLeaves = nullptr;
    uint32_t nKind    = 0;  // 0 topology chunk, 1 leaf block encode, 4 leaf block decode
    uint32_t nRaw     = 0;  // topology bytes in the raw area
    uint32_t nCount   = 0;  // leaves in the block
    size_t   nComp    = 0;
    int32_t  nError   = 0;
    uint8_t* pRaw() const { return pBuf + nCap - nTopoChunk; }
    uint8_t* pOut() const { return pBuf + nFrameAt; }
    size_t   nOutCap() const { return nCap - nTopoChunk - nFrameAt; }
};

struct SlotSet
{
    std::vector<Slot>             oSlots;
    std::vector<std::atomic<int>> oState; // 0 idle, 1 queued, 3 running, 2 done
    uint32_t                      nBlockLeaves = 0;
    int64_t                       nBytes       = 0;

    void Clear()
    {
        for (auto& o : oSlots)
        {
            k7_destroy(o.pCtx);
            std::free(o.pBuf);
            std::free(o.apLeaves);
        }
        oSlots.clear();
        oState = std::vector<std::atomic<int>>();
        nBlockLeaves = 0;
        nBytes = 0;
    }

    /// false = out of memory (the set is left empty). nLeaves is at most nMaxLeaves, so no size wraps.
    bool bMake(size_t nSlots, uint32_t nLeaves)
    {
        Clear();
        try
        {
            // Both vectors are sized before any slot buffer exists, so the push_back below never
            // reallocates: it cannot throw with a slot's buffers held by nothing.
            oSlots.reserve(nSlots);
            oState = std::vector<std::atomic<int>>(nSlots);
        }
        catch (const std::bad_alloc&)
        {
            Clear();
            return false;
        }
        const size_t nPayload = 8 + (size_t) nLeaves * (LeafT::SIZE * 4 + 1 + LeafT::SIZE * 4) + 64;
        const size_t nOut = std::max(nPayload, nTopoChunk);
        const size_t nCap = nFrameAt + nOut + nOut / 64 + 4096 + nTopoChunk;
        for (size_t n = 0; n < nSlots; ++n)
        {
            Slot o;
            o.pCtx = k7_create(nLeaves);
            o.pBuf = (uint8_t*) std::malloc(nCap);
            o.nCap = nCap;
            o.apLeaves = (LeafT**) std::malloc(sizeof(LeafT*) * nLeaves);
            if (!o.pCtx || !o.pBuf || !o.apLeaves)
            {
                k7_destroy(o.pCtx);
                std::free(o.pBuf);
                std::free(o.apLeaves);
                Clear();
                return false;
            }
            oSlots.push_back(o);
            nBytes += (int64_t) (nCap + 2 * nPayload + sizeof(LeafT*) * nLeaves);
        }
        nBlockLeaves = nLeaves;
        return true;
    }

    /// Configures every slot; false for an unsupported transform or codec, or a buffer below the codec's bound.
    bool bConfig(int32_t nTransform, int32_t nCodec, int32_t nLevel, float fBg)
    {
        for (auto& o : oSlots)
        {
            if (k7_config(o.pCtx, nTransform, nCodec, nLevel, fBg) != 0 ||
                k7_bound(o.pCtx, nBlockLeaves) > o.nOutCap() || k7_bytes_bound(o.pCtx, nTopoChunk) > o.nOutCap())
                return false;
        }
        return true;
    }

    ~SlotSet() { Clear(); }
};

SlotSet g_oArena;
void*   g_pReserve = nullptr;
size_t  g_nReserve = 0;
int32_t g_nMode    = 0;

void ReleaseReserve()
{
    std::free(g_pReserve);
    g_pReserve = nullptr;
}

bool bRearm()
{
    if (!g_pReserve && g_nReserve)
        g_pReserve = std::malloc(g_nReserve);
    return g_pReserve || !g_nReserve;
}

/// The slots for one park or restore: the arena, or one temporary slot when it does not match.
SlotSet* poSlotsFor(SlotSet& oLocal, uint32_t nLeaves)
{
    if (!g_oArena.oSlots.empty() && g_oArena.nBlockLeaves == nLeaves)
        return &g_oArena;
    return oLocal.bMake(1, nLeaves) ? &oLocal : nullptr;
}

#ifdef __EMSCRIPTEN_PTHREADS__
tbb::task_arena& oTaskArena()
{
    static tbb::task_arena oArena; // default concurrency: follows the instance's pool
    return oArena;
}

/// Mode-2 callbacks enqueued and not yet finished. Every Pipe waits for zero before it ends, so
/// no callback still holds a slot or its state when K7_nArena frees or rebuilds the set.
std::atomic<int> g_nTasks{0};
#endif

/// Waits while a pool task codes the slot (state 3). Never allocates and never throws.
void WaitRunning(const std::atomic<int>& a) noexcept
{
#ifdef __EMSCRIPTEN_PTHREADS__
    while (a.load(std::memory_order_acquire) == 3)
        std::this_thread::yield();
#else
    (void) a; // no pool: nothing else codes a slot
#endif
}

/// The mode a park or restore on these slots really runs in. Mode 2 needs a pool, so the
/// serial build (no pthreads) always runs it as mode 1.
int32_t nModeFor(const SlotSet& oSlots)
{
#ifdef __EMSCRIPTEN_PTHREADS__
    if (g_nMode == 2 && (tbb::this_task_arena::max_concurrency() < 2 || oSlots.oSlots.size() < 2))
        return 1;
    return g_nMode;
#else
    (void) oSlots;
    return std::min(g_nMode, 1);
#endif
}

/// Decodes one leaf block into leaves whose values the calling thread already allocated.
void DecodeSlot(Slot& o) noexcept
{
    if (k7_decode_begin(o.pCtx, o.pOut(), o.nComp) != 0)
    {
        o.nError = nErrOther;
        return;
    }
    uint64_t aMask[8];
    for (uint32_t n = 0; n < o.nCount; ++n)
    {
        MaskWords(*o.apLeaves[n], aMask);
        if (k7_next_leaf(o.pCtx, aMask, o.apLeaves[n]->buffer().data()) != 0)
        {
            o.nError = nErrOther;
            return;
        }
    }
    if (k7_decode_end(o.pCtx) != 0)
        o.nError = nErrOther;
}

/// Codes one slot. Nothing here throws (the codec is C, and the leaf values are allocated
/// before a slot is launched), so it is safe as a oneTBB task.
void RunSlot(Slot& o) noexcept
{
    if (o.nKind == 4)
        return DecodeSlot(o);
    if (o.nKind == 0)
        o.nComp = k7_bytes_compress(o.pCtx, o.pRaw(), o.nRaw, o.pOut(), o.nOutCap());
    else
    {
        uint64_t aMask[8];
        k7_begin(o.pCtx);
        for (uint32_t n = 0; n < o.nCount; ++n)
        {
            MaskWords(*o.apLeaves[n], aMask);
            k7_add_leaf(o.pCtx, aMask, o.apLeaves[n]->buffer().data());
        }
        o.nComp = k7_finish(o.pCtx, o.pOut(), o.nOutCap());
    }
    // bConfig checked both encoders' bounds against the slot, so this guard cannot fire; it
    // stops an empty frame from being stored (and its leaves freed) if that ever changed.
    if (!o.nComp)
        o.nError = nErrOther;
}

/// The ring. Launch hands the next slot to the mode; Retire returns the oldest launched slot, coded.
/// The destructor drains every launched slot and joins every mode-2 callback, so no task outlives
/// the park or restore. Between those, a callback whose slot the calling thread took may find the
/// slot launched again and code that launch instead: harmless, as a launch is complete before it is
/// queued and its own callback then finds it taken.
struct Pipe
{
    SlotSet& S;
    int32_t  nMode;
    size_t   nRing;
    size_t   nHead = 0, nTail = 0; // sequence numbers: launched, retired

    Pipe(SlotSet& oS, int32_t nM) : S(oS), nMode(nM), nRing(oS.oSlots.size())
    {
        for (auto& a : S.oState)
            a.store(0);
    }
    /// Runs on every way out, including while std::bad_alloc unwinds, so it neither allocates nor
    /// throws: a queued slot is claimed uncoded (an unwinding park or restore discards it) and a
    /// running one is waited for. Then the mode-2 callbacks are joined.
    ~Pipe()
    {
        for (size_t q = nTail; q < nHead; ++q)
        {
            int nQueued = 1;
            std::atomic<int>& a = S.oState[q % nRing];
            if (!a.compare_exchange_strong(nQueued, 2, std::memory_order_acq_rel))
                WaitRunning(a);
        }
#ifdef __EMSCRIPTEN_PTHREADS__
        while (g_nTasks.load(std::memory_order_acquire) != 0)
            std::this_thread::yield();
#endif
    }

    bool  bFull() const { return nHead - nTail == nRing; }
    bool  bEmpty() const { return nHead == nTail; }
    Slot& Next() { return S.oSlots[nHead % nRing]; } // the caller made room with Retire first

    void Launch()
    {
        const size_t s = nHead++ % nRing;
        Slot* p = &S.oSlots[s];
        std::atomic<int>* pState = &S.oState[s];
        p->nError = 0;
        if (nMode == 0)
        {
            RunSlot(*p);
            pState->store(2, std::memory_order_release);
            return;
        }
        pState->store(1, std::memory_order_release);
#ifdef __EMSCRIPTEN_PTHREADS__
        if (nMode == 2)
        {
            oTaskArena().enqueue([p, pState] {
                int nQueued = 1;
                if (pState->compare_exchange_strong(nQueued, 3, std::memory_order_acq_rel))
                {
                    RunSlot(*p);
                    pState->store(2, std::memory_order_release);
                } // else the calling thread took it
                g_nTasks.fetch_sub(1, std::memory_order_release); // the callback's last touch
            });
            g_nTasks.fetch_add(1, std::memory_order_relaxed); // after enqueue: a throwing enqueue left no task
        }
#endif
    }

    /// Mode 1: codes every queued slot in one wave on the pool.
    void RunWave()
    {
        std::vector<size_t> oQueued;
        oQueued.reserve(nRing);
        for (size_t q = nTail; q < nHead; ++q)
            if (S.oState[q % nRing].load(std::memory_order_acquire) == 1)
                oQueued.push_back(q % nRing);
        tbb::parallel_for(tbb::blocked_range<size_t>(0, oQueued.size(), 1), [&](const tbb::blocked_range<size_t>& r) {
            for (size_t n = r.begin(); n != r.end(); ++n)
            {
                RunSlot(S.oSlots[oQueued[n]]);
                S.oState[oQueued[n]].store(2, std::memory_order_release);
            }
        });
    }

    /// Waits for slot s, coding it here if nothing has started it yet.
    void WaitDone(size_t s)
    {
        std::atomic<int>& a = S.oState[s];
        if (a.load(std::memory_order_acquire) != 1)
            return WaitRunning(a); // mode 2: a pool task may be coding it; mode 0 coded it at launch
        if (nMode == 1)
            return RunWave();
#ifdef __EMSCRIPTEN_PTHREADS__
        int nQueued = 1; // mode 2: take it from the pool unless a task just did
        if (a.compare_exchange_strong(nQueued, 3, std::memory_order_acq_rel))
        {
            RunSlot(S.oSlots[s]);
            a.store(2, std::memory_order_release);
            return;
        }
        WaitRunning(a);
#endif
    }

    Slot& Retire()
    {
        const size_t s = nTail % nRing;
        WaitDone(s); // before nTail moves: a mode-1 wave codes the slots in [nTail, nHead)
        ++nTail;
        S.oState[s].store(0, std::memory_order_relaxed);
        return S.oSlots[s];
    }
};

/// The topology stream cut into nTopoChunk pieces, each written straight into a ring slot's raw area.
template <class Room> class PipeTopoBuf : public std::streambuf
{
public:
    PipeTopoBuf(Pipe& oPipe, Room& fnRoom) : m_oPipe(oPipe), m_fnRoom(fnRoom) { Begin(); }
    void Finish() { Submit(); }

protected:
    int_type overflow(int_type c) override
    {
        Submit();
        Begin();
        if (!traits_type::eq_int_type(c, traits_type::eof()))
        {
            *pptr() = traits_type::to_char_type(c);
            pbump(1);
        }
        return traits_type::not_eof(c);
    }
    int sync() override { return 0; }

private:
    void Begin()
    {
        m_fnRoom();
        Slot& o = m_oPipe.Next();
        char* p = (char*) o.pRaw();
        setp(p, p + nTopoChunk);
        m_pSlot = &o;
    }
    /// Never empty: overflow submits a full chunk, and Finish follows at least the grid's metadata.
    void Submit()
    {
        const size_t n = (size_t) (pptr() - pbase());
        m_pSlot->nKind = 0;
        m_pSlot->nRaw = (uint32_t) n;
        m_oPipe.Launch();
        setp(nullptr, nullptr);
    }

    Pipe&   m_oPipe;
    Room&   m_fnRoom;
    Slot*   m_pSlot = nullptr;
};

/// Pulls whole frames from the host source, verifying each frame's checksum.
struct Reader
{
    PKParkSource pfnSource = nullptr;

    bool bPull(uint8_t* p, size_t n)
    {
        size_t nDone = 0;
        while (nDone < n)
        {
            const int32_t nGot = pfnSource((char*) p + nDone, (int32_t) std::min<size_t>(n - nDone, size_t(1) << 30));
            if (nGot <= 0 || (size_t) nGot > n - nDone)
                return false;
            nDone += (size_t) nGot;
        }
        return true;
    }

    /// The next frame's header, and its bytes into pDst (at most nCap). false = truncated, oversized or corrupt.
    bool bGet(Frame& oFrame, uint8_t* pDst, size_t nCap)
    {
        if (!bPull((uint8_t*) &oFrame, sizeof(Frame)) || oFrame.nComp > nCap)
            return false;
        return bPull(pDst, oFrame.nComp) && nCheck(pDst, oFrame.nComp) == oFrame.nCheck;
    }
};

/// Topology frames back into a stream: each kind-0 frame is decompressed into slot 0's raw area.
class TopoSourceBuf : public std::streambuf
{
public:
    TopoSourceBuf(Reader& oReader, Slot& oSlot) : m_oReader(oReader), m_oSlot(oSlot)
    {
        setg(nullptr, nullptr, nullptr);
    }

protected:
    /// Called only with the get area empty (std::streambuf's contract): pulls the next topology frame.
    int_type underflow() override
    {
        Frame oFrame;
        if (!m_oReader.bGet(oFrame, m_oSlot.pOut(), m_oSlot.nOutCap()) || oFrame.nKind != 0 || oFrame.nRaw == 0 ||
            oFrame.nRaw > nTopoChunk ||
            k7_bytes_decompress(m_oSlot.pCtx, m_oSlot.pOut(), oFrame.nComp, m_oSlot.pRaw(), nTopoChunk) != oFrame.nRaw)
            return traits_type::eof();
        char* p = (char*) m_oSlot.pRaw();
        setg(p, p, p + oFrame.nRaw);
        return traits_type::to_int_type(*gptr());
    }

private:
    Reader& m_oReader;
    Slot&   m_oSlot;
};

/// Frees a grid's nodes without allocating. Tree::~Tree() collects the nodes into vectors
/// first, which on a full heap throws inside a noexcept destructor and aborts the instance;
/// RootNode::clear() deletes the children in place, after which the tree has nothing to collect.
void ClearInPlace(openvdb::FloatTree& oTree) noexcept
{
    oTree.root().clear();
}

/// Clears a partly restored grid on every way out of K7_hRestore but success.
struct ClearUnlessKept
{
    openvdb::FloatGrid::Ptr* proGrid;
    ~ClearUnlessKept()
    {
        if (proGrid && *proGrid)
            ClearInPlace((*proGrid)->tree());
    }
};

} // namespace

/// Parks the grid as frames to pfnSink. nFlags bit 0: destructive — each block's leaves are
/// freed as soon as its frame is stored, so the park needs no second copy of the grid.
PICOGK_API int64_t K7_nPark(PKINSTANCE hLib,
                            PKVOXELS   hThis,
                            int32_t    nTransform,
                            int32_t    nCodec,
                            int32_t    nLevel,
                            int32_t    nBlockLeaves,
                            int32_t    nFlags,
                            PKParkSink pfnSink)
{
    g_nLastError = 0;
    ReleaseReserve(); // the reserve pays for this park's own allocations
    uint64_t nFreed = 0;
    openvdb::FloatTree* poTree = nullptr;
    auto fail = [&](int32_t nError) -> int64_t {
        g_nLastError = nError;
        if (nFreed)
        {
            ClearInPlace(*poTree); // damaged: emptied here, so destroying it needs no heap
            return -3;
        }
        return nError == nErrMemory ? -2 : -1;
    };
    try
    {
        PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
        openvdb::FloatGrid::Ptr roGrid = roLib->m_oVoxels.roGet(hThis)->roVdbGrid();
        openvdb::FloatTree& oTree = roGrid->tree();
        poTree = &oTree;
        const float fBg = oTree.background();
        if (nBlockLeaves < 1)
            nBlockLeaves = 512;
        if (nBlockLeaves > nMaxLeaves)
            return fail(nErrOther);

        SlotSet oLocal;
        SlotSet* poSlots = poSlotsFor(oLocal, (uint32_t) nBlockLeaves);
        if (!poSlots)
            return fail(nErrMemory);
        if (!poSlots->bConfig(nTransform, nCodec, nLevel, fBg))
            return fail(nErrOther);

        int32_t nSinkError = 0;
        int32_t nPipeError = 0;
        int64_t nTotal = 0;
        auto emit = [&](uint8_t* pJoined, const Frame& oFrame) {
            std::memcpy(pJoined, &oFrame, sizeof(Frame));
            nTotal += (int64_t) (sizeof(Frame) + oFrame.nComp);
            const int32_t n = pfnSink((const char*) pJoined, (int32_t) (sizeof(Frame) + oFrame.nComp));
            if (n != 0)
                nSinkError = n == 1 ? nErrMemory : nErrOther;
        };
        auto bStopped = [&]() { return nSinkError != 0 || nPipeError != 0; };

        // Header, stored through slot 0 before the ring starts.
        const Header oHeader{nMagic, nTransform, nCodec, nLevel, nBlockLeaves, fBg, (uint64_t) oTree.leafCount()};
        {
            Slot& o = poSlots->oSlots[0];
            std::memcpy(o.pOut(), &oHeader, sizeof(Header));
            emit(o.pBuf, Frame{2, (uint32_t) sizeof(Header), (uint32_t) sizeof(Header), nCheck(o.pOut(), sizeof(Header))});
        }

        Pipe oPipe(*poSlots, nModeFor(*poSlots));
        auto store = [&](Slot& o) {
            nPipeError = nPipeError ? nPipeError : o.nError; // the first error stands
            if (bStopped())
                return;
            const uint32_t nComp = (uint32_t) o.nComp;
            emit(o.pBuf, Frame{o.nKind == 0 ? 0u : 1u, o.nKind == 0 ? o.nRaw : o.nCount, nComp, nCheck(o.pOut(), nComp)});
            if (o.nKind == 1 && (nFlags & 1) && !bStopped())
            {
                // Freed here, on the calling thread, while later blocks encode. Deferring the frees to the
                // grid's destroy measured 3-4x slower: Tree::clear frees on the pool against dlmalloc's lock.
                for (uint32_t n = 0; n < o.nCount; ++n)
                    oTree.addTile(1, o.apLeaves[n]->origin(), fBg, false); // deletes the leaf
                nFreed += o.nCount;
            }
        };
        auto room = [&]() {
            if (oPipe.bFull())
                store(oPipe.Retire());
        };
        if (!bStopped())
        {
            PipeTopoBuf<decltype(room)> oBuf(oPipe, room);
            std::ostream oStream(&oBuf);
            // A failure inside the buffer (std::bad_alloc while making room) must reach the catch
            // below, not set badbit and let a truncated topology be finished and stored.
            oStream.exceptions(std::ios_base::badbit);
            roGrid->writeMeta(oStream);
            roGrid->writeTransform(oStream);
            oTree.writeTopology(oStream, false);
            oStream.flush();
            oBuf.Finish();
        }
        uint64_t nCollected = 0;
        // Leaves behind the iterator are freed as their blocks retire; the iterator only moves forward.
        for (auto oLeaf = oTree.beginLeaf(); oLeaf && !bStopped();)
        {
            room();
            if (bStopped())
                break;
            Slot& o = oPipe.Next();
            o.nKind = 1;
            o.nCount = 0;
            while (o.nCount < (uint32_t) nBlockLeaves && oLeaf)
            {
                o.apLeaves[o.nCount++] = oLeaf.getLeaf();
                ++oLeaf;
            }
            nCollected += o.nCount;
            oPipe.Launch();
        }
        while (!oPipe.bEmpty())
            store(oPipe.Retire());
        if (nSinkError)
            return fail(nSinkError);
        // Neither can happen: encoding cannot fail (RunSlot), and the leaf iterator visits every
        // leaf the header counted. Kept so a broken image is never reported as parked.
        if (nPipeError || nCollected != oHeader.nLeaves)
            return fail(nErrOther);
        return nTotal;
    }
    catch (const std::bad_alloc&)
    {
        return fail(nErrMemory);
    }
    catch (...)
    {
        return fail(nErrOther);
    }
}

/// Rebuilds a grid from frames pulled from pfnSource. Returns a new Voxels handle, or 0 (see K7_nLastError).
PICOGK_API PKVOXELS K7_hRestore(PKINSTANCE hLib, PKParkSource pfnSource)
{
    g_nLastError = 0;
    auto fail = [](int32_t nError) -> PKVOXELS {
        g_nLastError = nError;
        return 0;
    };
    try
    {
        PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
        Reader oReader;
        oReader.pfnSource = pfnSource;

        Frame oFrame;
        Header oHeader;
        if (!oReader.bGet(oFrame, (uint8_t*) &oHeader, sizeof(Header)) || oFrame.nKind != 2 ||
            oFrame.nComp != sizeof(Header) || oHeader.nMagic != nMagic || oHeader.nBlockLeaves < 1 ||
            oHeader.nBlockLeaves > nMaxLeaves)
            return fail(nErrOther);

        SlotSet oLocal;
        SlotSet* poSlots = poSlotsFor(oLocal, (uint32_t) oHeader.nBlockLeaves);
        if (!poSlots)
            return fail(nErrMemory);
        if (!poSlots->bConfig(oHeader.nTransform, oHeader.nCodec, oHeader.nLevel, oHeader.fBackground))
            return fail(nErrOther);

        openvdb::FloatGrid::Ptr roGrid = openvdb::FloatGrid::create();
        ClearUnlessKept oClear{&roGrid};
        {
            TopoSourceBuf oBuf(oReader, poSlots->oSlots[0]);
            std::istream oStream(&oBuf);
            openvdb::io::setCurrentVersion(oStream);
            roGrid->readMeta(oStream);
            roGrid->readTransform(oStream);
            roGrid->tree().readTopology(oStream, false);
            if (!oStream || roGrid->tree().leafCount() != oHeader.nLeaves)
                return fail(nErrOther); // a short topology stream, or one that disagrees with the header
        }
        openvdb::FloatTree& oTree = roGrid->tree();

        Pipe oPipe(*poSlots, nModeFor(*poSlots));
        int32_t nError = 0;
        auto check = [&](Slot& o) { nError = nError ? nError : o.nError; };
        auto oLeaf = oTree.beginLeaf();
        uint64_t nGot = 0;
        while (nGot < oHeader.nLeaves && !nError)
        {
            if (oPipe.bFull())
                check(oPipe.Retire());
            Slot& o = oPipe.Next();
            if (!oReader.bGet(oFrame, o.pOut(), o.nOutCap()) || oFrame.nKind != 1 || oFrame.nRaw == 0 ||
                oFrame.nRaw > poSlots->nBlockLeaves || nGot + oFrame.nRaw > oHeader.nLeaves)
            {
                nError = nErrOther;
                break;
            }
            o.nComp = oFrame.nComp;
            o.nKind = 4;
            o.nCount = 0;
            while (o.nCount < oFrame.nRaw && oLeaf)
            {
                LeafT* p = oLeaf.getLeaf();
                // readTopology left the values unallocated: data() allocates them here, on the
                // calling thread (dlmalloc's one lock makes allocation on the pool slower), and
                // throws std::bad_alloc when the heap is full.
                p->buffer().data();
                o.apLeaves[o.nCount++] = p;
                ++oLeaf;
            }
            nGot += oFrame.nRaw;
            oPipe.Launch();
        }
        while (!oPipe.bEmpty())
            check(oPipe.Retire());
        if (nError)
            return fail(nError);
        const PKVOXELS hVoxels =
            roLib->m_oVoxels.hAdd(std::make_shared<PicoGK::Voxels>(roGrid, PICOGK_VOXEL_DEFAULTNARROWBAND));
        oClear.proGrid = nullptr; // kept: the instance owns it now
        return hVoxels;
    }
    catch (const std::bad_alloc&)
    {
        return fail(nErrMemory);
    }
    catch (...)
    {
        return fail(nErrOther);
    }
}

/// Sets up the encode arena: nSlots codec slots of nBlockLeaves leaves, a reserve of nReserveMiB
/// released at the start of every park, and the mode (0 serial, 1 pooled, 2 pipelined).
/// nSlots 0 frees the arena. Returns the arena bytes, -2 when out of memory, or -1 (nothing changed)
/// for more than 64 slots or more than K7_MAX_LEAVES leaves per block.
PICOGK_API int64_t K7_nArena(int32_t nSlots, int32_t nBlockLeaves, int32_t nReserveMiB, int32_t nMode)
{
    if (nSlots > nMaxSlots || nBlockLeaves > nMaxLeaves)
        return -1;
    ReleaseReserve();
    g_nMode = std::clamp(nMode, 0, 2);
    g_nReserve = (size_t) std::max(nReserveMiB, 0) << 20;
    if (nSlots <= 0)
    {
        g_oArena.Clear();
        g_nReserve = 0;
        return 0;
    }
    if (!g_oArena.bMake((size_t) nSlots, (uint32_t) std::max(nBlockLeaves, 1)) || !bRearm())
    {
        g_oArena.Clear();
        ReleaseReserve();
        return -2;
    }
    return g_oArena.nBytes + (int64_t) g_nReserve;
}

/// Re-takes the reserve after a park has freed its grid. 1 = held.
PICOGK_API int32_t K7_nRearm()
{
    return bRearm() ? 1 : 0;
}

/// Why the last K7_nPark or K7_hRestore failed: 0 none, 1 out of memory, 2 other.
PICOGK_API int32_t K7_nLastError()
{
    return g_nLastError;
}
