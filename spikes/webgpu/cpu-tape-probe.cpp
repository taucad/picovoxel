// P0 T4 CPU oracle for the tape-shaped gyroid throughput probe.
//
// This is a picovoxel-owned, zero-patch C-ABI TU. It compiles against
// PicoGKRuntime's public API header but does not modify or link the runtime:
// the spike isolates the current tape evaluator's axis-hoisted math from VDB
// classification/write costs so the WebGPU kernel sees identical points.
#include "PicoGK.h"

#include <tbb/blocked_range.h>
#include <tbb/global_control.h>
#include <tbb/parallel_for.h>
#include <tbb/task_arena.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdint>

namespace
{

std::atomic<uint32_t> g_nThreadMask {0};

void MarkThread()
{
    const int32_t nIndex = tbb::this_task_arena::current_thread_index();
    if (nIndex >= 0 && nIndex < 32)
        g_nThreadMask.fetch_or(1u << (uint32_t) nIndex, std::memory_order_relaxed);
}

} // namespace

PICOGK_API uint32_t CpuTapeProbe_Eval(
    float*          pfOutput,
    uint32_t        nElementCount,
    uint32_t        nWidth,
    uint32_t        nHeight,
    float           fOriginX,
    float           fOriginY,
    float           fOriginZ,
    float           fSpacing,
    float           fScale,
    float           fThreshold,
    uint32_t        nThreadLimit)
{
    if (pfOutput == nullptr || nElementCount == 0 || nWidth == 0 || nHeight == 0)
        return 0;

    g_nThreadMask.store(0, std::memory_order_relaxed);
    const uint32_t nRowCount = (nElementCount + nWidth - 1) / nWidth;
    tbb::global_control oConcurrency(
        tbb::global_control::max_allowed_parallelism,
        std::max<uint32_t>(1, nThreadLimit));

    tbb::parallel_for(
        tbb::blocked_range<uint32_t>(0, nRowCount, 4),
        [&](const tbb::blocked_range<uint32_t>& oRows)
        {
            MarkThread();
            for (uint32_t nRow = oRows.begin(); nRow != oRows.end(); ++nRow)
            {
                const uint32_t nY = nRow % nHeight;
                const uint32_t nZ = nRow / nHeight;
                const float fY = fOriginY + (float) nY * fSpacing;
                const float fZ = fOriginZ + (float) nZ * fSpacing;
                const double fScaledY = (double) fY * (double) fScale;
                const double fScaledZ = (double) fZ * (double) fScale;
                const double fSinY = std::sin(fScaledY);
                const double fCosY = std::cos(fScaledY);
                const double fSinZ = std::sin(fScaledZ);
                const double fCosZ = std::cos(fScaledZ);
                const uint32_t nBegin = nRow * nWidth;
                const uint32_t nEnd = std::min(nElementCount, nBegin + nWidth);

                for (uint32_t nIndex = nBegin; nIndex != nEnd; ++nIndex)
                {
                    const uint32_t nX = nIndex - nBegin;
                    const float fX = fOriginX + (float) nX * fSpacing;
                    const double fScaledX = (double) fX * (double) fScale;
                    const double fSinX = std::sin(fScaledX);
                    const double fCosX = std::cos(fScaledX);
                    const double fField =
                        fSinX * fCosY +
                        fSinY * fCosZ +
                        fSinZ * fCosX;
                    pfOutput[nIndex] = (float) (std::fabs(fField) - (double) fThreshold);
                }
            }
        });

    return nElementCount;
}

PICOGK_API uint32_t CpuTapeProbe_LastThreadCount()
{
    return (uint32_t) std::popcount(g_nThreadMask.load(std::memory_order_relaxed));
}
