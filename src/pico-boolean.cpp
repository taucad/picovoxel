// SKv2-0 V0.7 — shared-nothing boolean exports (§12.10; the U20 successor).
//
// The upstream booleans are mutating: the facade must copy the receiver
// (Voxels_hCreateCopy) and BoolAdd/Subtract/Intersect deep-copy the operand
// before openvdb's mutating csgUnion/Difference/Intersection consumes it —
// two full materializations per boolean pair, and the second (the operand
// copy) exists only to be destroyed. openvdb's csg*Copy family takes CONST
// inputs and builds exactly one fresh output tree with thread-per-leaf
// shared-nothing composition (`composite::doCSGCopy`) — the execution shape
// this repo has proven deterministic at production scale, and the reason the
// reverted merge-based U20 design, whose output depended on thread scheduling,
// is not re-attempted here.
//
// Post-processing parity: upstream's RebuildGrid() after every boolean is a
// disabled no-op (PicoGKVdbVoxels.h:888 returns immediately), so value-level
// equality with the mutating path needs nothing beyond the csg itself. The
// result grid inherits input A's transform and metadata
// (composite::GridOrTreeConstructor), exactly as the mutating path leaves
// the receiver's. The adopting Voxels(FloatGrid::Ptr, int) constructor wraps
// the output without a further copy; the narrow band is
// PICOGK_VOXEL_DEFAULTNARROWBAND, the constant every library creation path
// passes (PicoGKLibrary.cpp Voxels_hCreate).
//
// The mutating exports stay: the raw subpath keeps them, and the exact-gate
// differentials compare the two paths against each other.

#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/Composite.h>

namespace
{

using ComposeFn = openvdb::FloatGrid::Ptr (*)(const openvdb::FloatGrid&, const openvdb::FloatGrid&);

PKVOXELS hCompose(PKINSTANCE hLib, PKVOXELS hA, PKVOXELS hB, ComposeFn pfnCompose)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roA = roLib->m_oVoxels.roGet(hA);
    PicoGK::Voxels::Ptr roB = roLib->m_oVoxels.roGet(hB);

    openvdb::FloatGrid::Ptr roResult = pfnCompose(*roA->roVdbGrid(), *roB->roVdbGrid());

    return roLib->m_oVoxels.hAdd(
        std::make_shared<PicoGK::Voxels>(roResult, PICOGK_VOXEL_DEFAULTNARROWBAND));
}

openvdb::FloatGrid::Ptr roUnion(const openvdb::FloatGrid& oA, const openvdb::FloatGrid& oB)
{
    return openvdb::tools::csgUnionCopy(oA, oB);
}

openvdb::FloatGrid::Ptr roDifference(const openvdb::FloatGrid& oA, const openvdb::FloatGrid& oB)
{
    return openvdb::tools::csgDifferenceCopy(oA, oB);
}

openvdb::FloatGrid::Ptr roIntersection(const openvdb::FloatGrid& oA, const openvdb::FloatGrid& oB)
{
    return openvdb::tools::csgIntersectionCopy(oA, oB);
}

} // namespace

namespace
{

/// SKv2-0 V0.8 (T11) — the inside-set of a level-set tree as a voxelized mask.
///
/// Upstream bIsEqual classifies every coordinate in the union active bbox by
/// `getValue(xyz) <= 0` — a dense O(bbox³) serial accessor scan. The
/// classification is a pure function of the STORED values: active voxels and
/// tiles, plus inactive negative tiles and inactive negative leaf voxels (the
/// interior encoding G0's §14.5 OFF-stream walks); everything else returns the
/// positive background = outside. So two grids are bIsEqual-equal iff their
/// inside-sets match — built here in O(stored nodes) and compared tile-aware
/// by dual topologyDifference (an interior tile and the same interior as
/// dense leaves are one set; nothing is ever densified).
void BuildInsideMask(const openvdb::FloatTree& oTree, openvdb::MaskTree& oMask)
{
    // Leaf voxels (active AND inactive — G0's OFF-stream lesson): straight
    // buffer scans, one touchLeaf per leaf. Per-voxel tree-level setValueOn
    // would pay a root-to-leaf descent per voxel (measured: it capped the
    // repair at ~2×); leaf-local bit sets are O(1).
    using MaskLeaf = openvdb::MaskTree::LeafNodeType;
    for (auto leafIt = oTree.cbeginLeaf(); leafIt; ++leafIt)
    {
        const auto& oLeaf = *leafIt;
        MaskLeaf* poMaskLeaf = nullptr;
        for (openvdb::Index n = 0; n < oLeaf.SIZE; n++)
        {
            // NaN never classifies inside (<= is false), matching upstream.
            if (!(oLeaf.getValue(n) <= 0.0f))
                continue;
            if (!poMaskLeaf)
                poMaskLeaf = oMask.touchLeaf(oLeaf.origin());
            poMaskLeaf->setValueOn(n);
        }
    }
    // Tiles (active and inactive, any internal level): depth-capped iterators
    // never descend to leaf voxels, so this visits O(tiles) entries only.
    auto onIt = oTree.cbeginValueOn();
    onIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
    for (; onIt; ++onIt)
    {
        openvdb::CoordBBox oBBox;
        if (!(onIt.getValue() <= 0.0f) || onIt.isVoxelValue())
            continue;
        onIt.getBoundingBox(oBBox);
        if (!oBBox.empty())
            oMask.sparseFill(oBBox, true, true);
    }
    auto offIt = oTree.cbeginValueOff();
    offIt.setMaxDepth(openvdb::FloatTree::DEPTH - 2);
    for (; offIt; ++offIt)
    {
        openvdb::CoordBBox oBBox;
        if (!(offIt.getValue() <= 0.0f) || offIt.isVoxelValue())
            continue;
        offIt.getBoundingBox(oBBox);
        if (!oBBox.empty())
            oMask.sparseFill(oBBox, true, true);
    }
    // NO voxelizeActiveTiles: densifying interior tiles is O(interior volume)
    // and hands back most of the O(bbox³) cost this repair removes. Equality
    // is decided tile-aware by dual topologyDifference — O(stored nodes).
}

/// Set equality over active states, representation-aware (a tile and the same
/// region as dense leaves compare equal): A≡B iff A∖B and B∖A are both empty.
bool bSameActiveSet(const openvdb::MaskTree& oMaskA, openvdb::MaskTree& oMaskB)
{
    openvdb::MaskTree oDiff(oMaskA);
    oDiff.topologyDifference(oMaskB);
    if (oDiff.activeVoxelCount() != 0)
        return false;
    oMaskB.topologyDifference(oMaskA); // B is ours to consume
    return oMaskB.activeVoxelCount() == 0;
}

} // namespace

/// Sign-classification equality, upstream-verdict-identical, O(stored) instead
/// of O(bbox³): the T11 repair. Falls back to the upstream scan for the
/// degenerate non-positive-background case upstream's semantics make weird.
PICOGK_API bool Voxels_bIsEqualFast(PKINSTANCE hLib, PKVOXELS hA, PKVOXELS hB)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roA = roLib->m_oVoxels.roGet(hA);
    PicoGK::Voxels::Ptr roB = roLib->m_oVoxels.roGet(hB);

    const openvdb::FloatGrid& oGridA = *roA->roVdbGrid();
    const openvdb::FloatGrid& oGridB = *roB->roVdbGrid();

    if (oGridA.transform() != oGridB.transform())
        return false;

    // A non-positive background would put unbounded space "inside"; only the
    // dense scan reproduces upstream's bbox-clipped answer for that shape.
    if (oGridA.background() <= 0.0f || oGridB.background() <= 0.0f)
        return roA->bIsEqual(*roB);

    openvdb::MaskTree oMaskA, oMaskB;
    BuildInsideMask(oGridA.tree(), oMaskA);
    BuildInsideMask(oGridB.tree(), oMaskB);
    return bSameActiveSet(oMaskA, oMaskB);
}

/// A ∪ B into a fresh grid; both inputs untouched.
PICOGK_API PKVOXELS Voxels_hBoolAddCopy(PKINSTANCE hLib, PKVOXELS hA, PKVOXELS hB)
{
    return hCompose(hLib, hA, hB, roUnion);
}

/// A − B into a fresh grid; both inputs untouched.
PICOGK_API PKVOXELS Voxels_hBoolSubtractCopy(PKINSTANCE hLib, PKVOXELS hA, PKVOXELS hB)
{
    return hCompose(hLib, hA, hB, roDifference);
}

/// A ∩ B into a fresh grid; both inputs untouched.
PICOGK_API PKVOXELS Voxels_hBoolIntersectCopy(PKINSTANCE hLib, PKVOXELS hA, PKVOXELS hB)
{
    return hCompose(hLib, hA, hB, roIntersection);
}
