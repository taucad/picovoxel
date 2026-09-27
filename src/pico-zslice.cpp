// SKv2-0 V0.9 — ProjectZSlice repair (T5×F15) + the U2 seal-count fix.
//
// Upstream ProjectZSliceDn/Up (PicoGKVdbVoxels.h:549-633) sweeps EVERY (x,y)
// column of the active bbox with per-voxel accessor reads — O(bbox area ×
// slab height) regardless of occupancy — then seals the end cap over
// `(int)(0.5f + background())` layers. That count treats a MILLIMETRE
// quantity as a layer count (U2, PicoPie Fix 3): at 1.0 mm voxels it lands
// on the correct 3 by coincidence; at 0.5 mm it seals 2 of 3 layers; below
// ~0.167 mm it seals zero and caps come out open. The correct count is the
// narrow band in voxels: background()/voxelSize (= the
// PICOGK_VOXEL_DEFAULTNARROWBAND the grid was built with).
//
// This TU keeps upstream's per-column value logic verbatim (min-propagation
// down/up the slab, average-seal at the end cap, SetSdValue clamp+off
// semantics, terminal PruneFill) and changes exactly three things:
//   (1) F15 culling — only columns whose slab z-range intersects stored
//       content are visited. Untouched columns differ from upstream only by
//       writes SetSdValue makes at background value, which the terminal
//       prune removes — value-identical after prune (upstream prunes too).
//   (2) The seal layer count is measured in voxels, not millimetres (U2).
//       At 1.0 mm the two agree, so 1.0 mm pins hold byte-for-byte.
//   (3) D-pre.4 — columns run in parallel over 8×8 leaf-aligned blocks after
//       a serial touchLeaf pre-pass (see the block comment at the loop);
//       Class 0 vs the serial path by construction.
//
// The mutating upstream export stays on the raw subpath as the oracle for
// the differential suite (which asserts identity at 1.0 mm and the CORRECTED
// seal at other scales).

#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/openvdb.h>

#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace
{

using openvdb::Coord;
using openvdb::CoordBBox;

inline void SetSd(openvdb::FloatGrid::Accessor& oAccess, const Coord& xyz, float fBackground, float fValue)
{
    // Verbatim upstream SetSdValue (PicoGKVdbVoxels.h:1024-1035).
    oAccess.setValue(xyz, std::clamp(fValue, -fBackground, fBackground));
    if (std::abs(fValue) >= fBackground)
        oAccess.setValueOff(xyz);
}

/// Columns whose [zMin, zMax] slab intersects stored content (active voxels,
/// active tiles, or negative inactive tiles — anything a read could see that
/// is not plain background). O(stored nodes), never O(bbox).
void MarkColumns(const openvdb::FloatTree& oTree, int32_t iZMin, int32_t iZMax,
                 std::unordered_set<uint64_t>& oColumns)
{
    const auto nKey = [](int32_t x, int32_t y) {
        return ((uint64_t)(uint32_t)x << 32) | (uint64_t)(uint32_t)y;
    };
    const auto mark = [&](const CoordBBox& oBBox) {
        if (oBBox.min().z() > iZMax || oBBox.max().z() < iZMin)
            return;
        for (int32_t x = oBBox.min().x(); x <= oBBox.max().x(); x++)
            for (int32_t y = oBBox.min().y(); y <= oBBox.max().y(); y++)
                oColumns.insert(nKey(x, y));
    };
    for (auto leafIt = oTree.cbeginLeaf(); leafIt; ++leafIt)
    {
        CoordBBox oBBox = leafIt->getNodeBoundingBox();
        if (oBBox.min().z() > iZMax || oBBox.max().z() < iZMin)
            continue;
        // Per-voxel precision inside the leaf: stored = active OR negative.
        const auto& oLeaf = *leafIt;
        for (openvdb::Index n = 0; n < oLeaf.SIZE; n++)
        {
            if (!oLeaf.isValueOn(n) && !(oLeaf.getValue(n) < 0.0f))
                continue;
            const Coord xyz = oLeaf.offsetToGlobalCoord(n);
            if (xyz.z() >= iZMin && xyz.z() <= iZMax)
                oColumns.insert(nKey(xyz.x(), xyz.y()));
        }
    }
    auto onIt = oTree.cbeginValueOn();
    onIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
    for (; onIt; ++onIt)
    {
        CoordBBox oBBox;
        onIt.getBoundingBox(oBBox);
        mark(oBBox);
    }
    auto offIt = oTree.cbeginValueOff();
    offIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
    for (; offIt; ++offIt)
    {
        if (!(offIt.getValue() < 0.0f))
            continue;
        CoordBBox oBBox;
        offIt.getBoundingBox(oBBox);
        mark(oBBox);
    }
}

} // namespace

/// Upstream ProjectZSlice with F15 column culling and the U2-corrected seal.
PICOGK_API void Voxels_ProjectZSliceFast(PKINSTANCE hLib, PKVOXELS hThis, float fZStart, float fZEnd)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);
    openvdb::FloatGrid& oGrid = *roVoxels->roVdbGrid();

    const bool bDown = fZStart > fZEnd;
    // Upstream's own PUBLIC inlines everywhere a unit conversion happens —
    // exactness by construction, not by re-verification (only the protected
    // SetSdValue must be duplicated; see SetSd above, covered by the 1.0 mm
    // byte-coincidence test).
    const PicoGK::VoxelSize oVoxelSize = roVoxels->oVoxelSize();
    const float fBackgroundMM = roVoxels->fBackgroundMM();
    // U2: the seal depth is the narrow band in VOXELS. Upstream's
    // (int)(0.5f + background()) reads the mm quantity as a layer count —
    // correct only when voxelSize == 1 mm (and harmlessly over-sealing
    // above it: beyond-band layers average to background and prune). Same
    // formula, units fixed via upstream's fToVoxels:
    const int nSealLayers = (int)(0.5f + oVoxelSize.fToVoxels(fBackgroundMM));

    const int32_t iZStart = oVoxelSize.iToVoxels(fZStart);
    const int32_t iZEnd = oVoxelSize.iToVoxels(fZEnd);

    // Slab the columns must intersect: the sweep reads [min(iZStart,iZEnd)-1,
    // max(...)+1] and the seal reads a further nSealLayers+1 past iZEnd.
    const int32_t iLo = bDown ? iZEnd - nSealLayers - 1 : std::min(iZStart, iZEnd) - 1;
    const int32_t iHi = bDown ? std::max(iZStart, iZEnd) + 1 : iZEnd + nSealLayers + 1;

    std::unordered_set<uint64_t> oColumns;
    MarkColumns(oGrid.tree(), iLo, iHi, oColumns);

    // Per-column value logic, verbatim from V0.9 (= upstream's, culled).
    const auto SweepColumn = [&](openvdb::FloatGrid::Accessor& oAccess, int32_t x, int32_t y) {
        if (bDown)
        {
            for (int32_t z = iZStart; z > iZEnd; z--)
            {
                const float fValue = std::min(oAccess.getValue(Coord(x, y, z - 1)), oAccess.getValue(Coord(x, y, z)));
                SetSd(oAccess, Coord(x, y, z - 1), fBackgroundMM, fValue);
            }
            for (int32_t z = iZEnd; z > iZEnd - nSealLayers; z--)
            {
                const float fValue = (oAccess.getValue(Coord(x, y, z)) + oAccess.getValue(Coord(x, y, z - 1))) / 2.0f;
                SetSd(oAccess, Coord(x, y, z), fBackgroundMM, fValue);
            }
        }
        else
        {
            for (int32_t z = iZStart; z < iZEnd; z++)
            {
                const float fValue = std::min(oAccess.getValue(Coord(x, y, z + 1)), oAccess.getValue(Coord(x, y, z)));
                SetSd(oAccess, Coord(x, y, z + 1), fBackgroundMM, fValue);
            }
            for (int32_t z = iZEnd; z < iZEnd + nSealLayers; z++)
            {
                const float fValue = (oAccess.getValue(Coord(x, y, z)) + oAccess.getValue(Coord(x, y, z + 1))) / 2.0f;
                SetSd(oAccess, Coord(x, y, z), fBackgroundMM, fValue);
            }
        }
    };

    // D-pre.4 — leaf-block parallelism. The write set per column is the
    // contiguous range [iWLo, iWHi] (exactly what the loops above write), so
    // the serial touchLeaf pre-pass creates exactly the leaf set the serial
    // accessor would have created (voxelizing the same tiles). A leaf's (x,y)
    // footprint IS its 8×8 block's footprint, so every leaf a column writes
    // belongs to that column's block: tasks share no leaf, reads are
    // same-column only (reads outside the write range hit leaves/tiles no
    // task writes), and writes per voxel happen exactly once per phase,
    // column-sequential — the result is independent of scheduling and thread
    // count (Class 0 vs serial). The terminal prune restores tile topology.
    const bool bHasSweep = bDown ? (iZStart > iZEnd) : (iZStart < iZEnd);
    const bool bHasSeal = nSealLayers > 0;
    if (bHasSweep || bHasSeal)
    {
        int32_t iWLo, iWHi;
        if (bDown)
        {
            iWLo = bHasSeal ? iZEnd - nSealLayers + 1 : iZEnd;
            iWHi = bHasSweep ? iZStart - 1 : iZEnd;
        }
        else
        {
            iWLo = bHasSweep ? iZStart + 1 : iZEnd;
            iWHi = bHasSeal ? iZEnd + nSealLayers - 1 : iZEnd;
        }

        std::unordered_map<uint64_t, std::vector<uint64_t>> oBlocks;
        for (const uint64_t nKey : oColumns)
        {
            const int32_t x = (int32_t)(uint32_t)(nKey >> 32);
            const int32_t y = (int32_t)(uint32_t)nKey;
            oBlocks[((uint64_t)(uint32_t)(x >> 3) << 32) | (uint64_t)(uint32_t)(y >> 3)].push_back(nKey);

            for (int32_t z = iWLo & ~7; z <= iWHi; z += 8)
                oGrid.tree().touchLeaf(Coord(x, y, z));
        }

        std::vector<const std::vector<uint64_t>*> oBlockList;
        oBlockList.reserve(oBlocks.size());
        for (const auto& oEntry : oBlocks)
            oBlockList.push_back(&oEntry.second);

        tbb::parallel_for(tbb::blocked_range<size_t>(0, oBlockList.size()),
            [&](const tbb::blocked_range<size_t>& oRange) {
                auto oAccess = oGrid.getAccessor();
                for (size_t n = oRange.begin(); n != oRange.end(); n++)
                    for (const uint64_t nKey : *oBlockList[n])
                        SweepColumn(oAccess, (int32_t)(uint32_t)(nKey >> 32), (int32_t)(uint32_t)nKey);
            });
    }

    // Upstream's PruneFill (patch 0002), so both paths prune by one rule.
    PicoGK::Voxels::PruneSignUniform(oGrid.tree());
}


/// SKv2-0 V0.10 — U1-corrected, F17 support-restricted IntersectImplicit
/// (JS-callback path; the vendored `Voxels::IntersectImplicit` stays raw-side
/// as the oracle). Upstream builds its fresh grid as
/// `Voxels oVox(oVoxelSize(), fBackgroundMM())`, passing MILLIMETRES into the
/// ctor's `int nNarrowBand` — truncated to band 1 at 0.5 mm and band 0 below
/// ~1/3 mm (U1, PicoPie Fix 2). Corrected here to background/voxelSize (3).
/// F17: the dense sample loop runs only over leaf-aligned block columns where
/// the target stores content — everywhere else the subsequent intersection
/// yields background regardless of the SDF.
PICOGK_API void Voxels_IntersectImplicitFast(PKINSTANCE hLib, PKVOXELS hThis, PKPFnfSdf pfn)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);
    openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();
    if (roGrid->tree().empty())
        return;

    const PicoGK::VoxelSize oVoxelSize = roVoxels->oVoxelSize();
    const float fBackgroundMM = roVoxels->fBackgroundMM();
    const int32_t nBand = (int32_t)std::lround(oVoxelSize.fToVoxels(fBackgroundMM)); // U1 fix
    const float fFreshBackground = oVoxelSize.fToMM(nBand);

    const CoordBBox oActive = roGrid->evalActiveVoxelBoundingBox();

    // Block-column support map (leaf-aligned x,y), tiles marked wholesale.
    std::unordered_set<uint64_t> oColumns;
    {
        const auto nKey = [](int32_t nCX, int32_t nCY) {
            return ((uint64_t)(uint32_t)nCX << 32) | (uint64_t)(uint32_t)nCY;
        };
        const auto markBBox = [&](const CoordBBox& oBBox) {
            for (int32_t nCX = oBBox.min().x() >> 3; nCX <= oBBox.max().x() >> 3; nCX++)
                for (int32_t nCY = oBBox.min().y() >> 3; nCY <= oBBox.max().y() >> 3; nCY++)
                    oColumns.insert(nKey(nCX, nCY));
        };
        const openvdb::FloatTree& oTree = roGrid->tree();
        for (auto leafIt = oTree.cbeginLeaf(); leafIt; ++leafIt)
            oColumns.insert(nKey(leafIt->origin().x() >> 3, leafIt->origin().y() >> 3));
        auto onIt = oTree.cbeginValueOn();
        onIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
        for (; onIt; ++onIt)
        {
            CoordBBox oBBox;
            onIt.getBoundingBox(oBBox);
            markBBox(oBBox);
        }
        auto offIt = oTree.cbeginValueOff();
        offIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
        for (; offIt; ++offIt)
        {
            if (!(offIt.getValue() < 0.0f))
                continue;
            CoordBBox oBBox;
            offIt.getBoundingBox(oBBox);
            if (!oBBox.empty())
                markBBox(oBBox);
        }
    }

    openvdb::FloatGrid::Ptr roImplicit = openvdb::FloatGrid::create(fFreshBackground);
    roImplicit->setGridClass(openvdb::GRID_LEVEL_SET);
    roImplicit->setTransform(openvdb::math::Transform::createLinearTransform(oVoxelSize));
    auto oAccess = roImplicit->getAccessor();

    // Upstream RenderImplicit's dense loop over bbox±band, restricted to the
    // support columns; sample positions and per-voxel float ops verbatim
    // (vecToMM = i·voxelSize; min(sdf, background); SetSdValue clamp/off).
    const int32_t nX0 = oActive.min().x() - nBand, nX1 = oActive.max().x() + nBand;
    const int32_t nY0 = oActive.min().y() - nBand, nY1 = oActive.max().y() + nBand;
    const int32_t nZ0 = oActive.min().z() - nBand, nZ1 = oActive.max().z() + nBand;
    for (int32_t nCX = nX0 >> 3; nCX <= nX1 >> 3; nCX++)
    for (int32_t nCY = nY0 >> 3; nCY <= nY1 >> 3; nCY++)
    {
        if (oColumns.count(((uint64_t)(uint32_t)nCX << 32) | (uint64_t)(uint32_t)nCY) == 0)
            continue;
        const int32_t nBX0 = std::max(nX0, nCX * 8), nBX1 = std::min(nX1, nCX * 8 + 7);
        const int32_t nBY0 = std::max(nY0, nCY * 8), nBY1 = std::min(nY1, nCY * 8 + 7);
        for (int32_t x = nBX0; x <= nBX1; x++)
        for (int32_t y = nBY0; y <= nBY1; y++)
        for (int32_t z = nZ0; z <= nZ1; z++)
        {
            const PKVector3 vecSample = oVoxelSize.vecToMM(PicoGK::Coord(x, y, z));
            const float fSdf = (*pfn)(&vecSample);
            const float fValue = std::min(fSdf, oAccess.getValue(Coord(x, y, z)));
            SetSd(oAccess, Coord(x, y, z), fFreshBackground, fValue);
        }
    }

    openvdb::tools::csgIntersection(*roImplicit, *roGrid);
    roGrid->setTree(roImplicit->baseTreePtr());
}
