// SKv2-0 V0.7 / NON-DETERMINISM §11.3 — native stock-TBB reproducer for the
// U-SK05-a merge-based CSG defect class.
//
// The wasm 12-thread build dropped geometry nondeterministically at fine cells
// under the merge shape (TreeToMerge + DeepCopy tag via DynamicNodeManager
// foreachTopDown — the exact reverted CsgMergeFrom below). The toggle matrix
// proved it necessary+sufficient IN WASM; all four configs ran patched oneTBB
// on emscripten pthreads, so upstream-vs-substrate stayed open. This harness
// runs the same operator shape on native arm64 + STOCK oneTBB (homebrew) +
// the same openvdb sources PicoGKRuntime vendors, N runs per arm:
//   arm A: CsgMergeFrom (the reverted shape)
//   arm B: openvdb::tools::csgUnion over an eager deep copy (the shipped shape)
// and prints an order-independent content checksum per run. Divergence in arm A
// on native = upstream defect (novel report, Merge.h unchanged +122 commits);
// bit-stability here = substrate interaction becomes the leading suspect.
//
// VERDICT 2026-07-27 (SKv2-0 V0.7, Apple M2 Pro 12-core, openvdb 13.0.0 from
// the PicoGKRuntime vendor tree, homebrew oneTBB 12.18): REPRODUCED — the
// merge arm emitted 4 distinct checksums AND active-voxel counts in 5 runs
// (13,120,165..13,189,311 — dropped geometry, the wasm P0 class) while the
// steal arm was bit-stable 5/5 at the merge arm's best-case value; capped to
// 1 thread the merge arm is bit-stable and correct 3/3. Upstream defect;
// substrate exonerated; novel report (see MIGRATING-FROM-CSHARP.md U20).
//
// Build (native, against the PicoGKRuntime vendored openvdb build):
//   R=~/git/tau/repos/PicoGKRuntime
//   clang++ -std=c++17 -O2 -o u20-repro bench/u20-native-repro.cpp \
//     -I$R/openvdb/openvdb -I$R/build-r2/openvdb/openvdb/openvdb \
//     -I$R/build-r2/openvdb/openvdb/openvdb/openvdb -I/opt/homebrew/include \
//     $R/build-r2/lib/libopenvdb.a /opt/homebrew/lib/libtbb.dylib -lz
//   ./u20-repro [runs=5] [ops=40] [voxel=0.05] [threads=0=default]

#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <memory>

#include <openvdb/openvdb.h>
#include <openvdb/tools/Composite.h>
#include <openvdb/tools/LevelSetSphere.h>
#include <openvdb/tools/Merge.h>
#include <openvdb/tools/Prune.h>
#include <openvdb/tree/NodeManager.h>
#include <openvdb/util/NullInterrupter.h>
#include <oneapi/tbb/global_control.h>

using openvdb::FloatGrid;
using openvdb::FloatTree;

// The reverted U-SK05-a shape, verbatim in structure.
template <class TCsgOp>
static void CsgMergeFrom(FloatGrid& oA, const FloatGrid& oB)
{
    FloatTree&       oTree      = oA.tree();
    const FloatTree& oOtherTree = oB.tree();
    TCsgOp oOp(oOtherTree, openvdb::DeepCopy());
    openvdb::tree::DynamicNodeManager<FloatTree> oNodes(oTree);
    oNodes.foreachTopDown(oOp);
    openvdb::tools::pruneLevelSet(oTree);
}

// Order-independent content checksum: 64-bit sums over (coord, value-bits)
// products; immune to iteration order, sensitive to any value/topology change.
static void checksum(const FloatGrid& oGrid, uint64_t* pnSum, uint64_t* pnCount)
{
    uint64_t nSum = 0, nCount = 0;
    for (auto it = oGrid.tree().cbeginValueOn(); it; ++it)
    {
        const openvdb::Coord xyz = it.getCoord();
        uint32_t nBits;
        const float fValue = it.getValue();
        std::memcpy(&nBits, &fValue, sizeof(nBits));
        const uint64_t nCoord =
            (uint64_t)(uint32_t)xyz.x() * 0x9E3779B97F4A7C15ull ^
            (uint64_t)(uint32_t)xyz.y() * 0xC2B2AE3D27D4EB4Full ^
            (uint64_t)(uint32_t)xyz.z() * 0x165667B19E3779F9ull;
        nSum += nCoord ^ ((uint64_t)nBits * 0xFF51AFD7ED558CCDull);
        nCount++;
    }
    *pnSum = nSum;
    *pnCount = nCount;
}

// Boolean-heavy fine-cell fixture: one large accumulator, many overlapping
// operands — the union-chain shape HeatX construct drives.
static FloatGrid::Ptr accumulator(float fVoxel)
{
    return openvdb::tools::createLevelSetSphere<FloatGrid>(20.0f, openvdb::Vec3f(0, 0, 0), fVoxel);
}

int main(int argc, char** argv)
{
    openvdb::initialize();
    const int   nRuns   = argc > 1 ? atoi(argv[1]) : 5;
    const int   nOps    = argc > 2 ? atoi(argv[2]) : 40;
    const float fVoxel  = argc > 3 ? (float)atof(argv[3]) : 0.05f;
    const int   nThreads = argc > 4 ? atoi(argv[4]) : 0;
    std::unique_ptr<oneapi::tbb::global_control> roCap;
    if (nThreads > 0)
        roCap = std::make_unique<oneapi::tbb::global_control>(oneapi::tbb::global_control::max_allowed_parallelism, nThreads);

    printf("u20-native-repro: runs=%d ops=%d voxel=%.3f threads=%d\n", nRuns, nOps, fVoxel, nThreads);

    for (int nArm = 0; nArm < 2; nArm++)
    {
        const char* pszArm = nArm == 0 ? "merge(DeepCopy)" : "csgUnion(steal-on-copy)";
        for (int nRun = 0; nRun < nRuns; nRun++)
        {
            FloatGrid::Ptr roA = accumulator(fVoxel);
            for (int nOp = 0; nOp < nOps; nOp++)
            {
                const float fAngle = 0.157f * (float)nOp;
                const openvdb::Vec3f vecAt(18.0f * cosf(fAngle), 18.0f * sinf(fAngle), (float)(nOp % 7) - 3.0f);
                FloatGrid::Ptr roB =
                    openvdb::tools::createLevelSetSphere<FloatGrid>(4.0f + 0.1f * (float)(nOp % 5), vecAt, fVoxel);
                if (nArm == 0)
                {
                    CsgMergeFrom<openvdb::tools::CsgUnionOp<FloatTree>>(*roA, *roB);
                }
                else
                {
                    FloatGrid::Ptr roCopy = roB->deepCopy();
                    openvdb::tools::csgUnion(*roA, *roCopy);
                }
            }
            uint64_t nSum = 0, nCount = 0;
            checksum(*roA, &nSum, &nCount);
            printf("  arm=%-24s run=%d  sum=%016" PRIx64 "  active=%" PRIu64 "\n", pszArm, nRun, nSum, nCount);
        }
    }
    return 0;
}
