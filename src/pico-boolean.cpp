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
// reverted merge-based U20 design is not re-attempted here (NON-DETERMINISM
// §12.10, §11.3).
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
