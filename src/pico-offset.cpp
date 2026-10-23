// SK-0.8 — the offset family's renormalization knobs, exposed.
//
// Every offset in PicoGK (Voxels_Offset / DoubleOffset / TripleOffset, and the C#
// voxFillet / voxShell / voxOverOffset compositions built on them) is
// openvdb::tools::LevelSetFilter::offset, which advances the surface in CFL-limited
// steps of half a voxel and calls LevelSetTracker::track() after every step
// (LevelSetFilter.h:355-377). track() is dilate + normalize + prune, and normalize
// re-solves the Eikonal equation getNormCount() times with the tracker's spatial
// scheme (LevelSetTracker.h:302-315, 534-598).
//
// The tracker's defaults are LEVEL_SET_HALF_WIDTH normalization sweeps (3) using
// HJWENO5_BIAS, the 5th-order Hamilton-Jacobi WENO gradient (LevelSetTracker.h:74-83).
// That is the accuracy setting for *interface tracking*, where the level set is
// advected by an arbitrary velocity field and the distance property genuinely decays.
// An offset moves the surface along its own normal by a constant: the field stays
// close to a signed distance by construction, and upstream's own documentation says
// so — "many level set applications perform interface-tracking, which in turn
// rebuilds the narrow-band accurately, [so] this dilate method can often be used
// with a single iterations of low-order re-normalization" (LevelSetTracker.h:115-123).
// Offsets pay for tracking they do not do. This TU makes that payment adjustable.
//
// WHY A NEW TU AND NOT A PATCH. setSpatialScheme/setNormCount are public
// LevelSetTracker API and LevelSetFilter inherits them, so nothing needs patching —
// the knobs are simply unreachable from PicoGK's three exports, which construct
// their filter locally and take no settings. A parallel export reaches them without
// touching either vendored tree, and without changing the existing exports' ABI.
//
// WHY ONE EXPORT COVERS ALL THREE. PicoGK's Offset/DoubleOffset/TripleOffset differ
// only in the sequence of offset() calls they make on one filter, plus RebuildGrid
// calls that are dead code (PicoGKVdbVoxels.h:888-892 returns immediately, upstream
// "disabled until we determine it is necessary"). So an offset sequence plus the two
// knobs is the whole family:
//
//     Offset(d)         -> [d]
//     DoubleOffset(a,b) -> [a, b]           (fillet: [r, -r + final])
//     TripleOffset(d)   -> [-d, 2d, -d]     (smoothen)
//
// DEFAULT PATH IS BIT-IDENTICAL, BY CONSTRUCTION. Pass nSpatialScheme/nNormCount < 0
// and this function is textually the body of the corresponding PicoGK export: same
// grid object (roVdbGrid() returns m_roGrid itself), same filter type, same negation
// of the distance ("OpenVDB treats offsets as inwards"), same untouched tracker
// state. test/voxels-offsets.test.ts pins that equivalence against all three exports.

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/Composite.h>
#include <openvdb/tools/FastSweeping.h>
#include <openvdb/tools/LevelSetFilter.h>
#include <openvdb/tools/LevelSetUtil.h>
#include <openvdb/tools/Prune.h>
#include <openvdb/tree/LeafManager.h>

#include <cmath>

// VO1 — an offset engine that extends the band, then shifts it, instead of
// advancing the surface in CFL steps. Selected by nSpatialScheme in
// Voxels_OffsetTuned; never the default, because its values differ from the
// LevelSetFilter's (the audit measured at most 0.13 voxel from stock on
// distance-field inputs, as close to the closed form as stock, and 1.9-26x
// faster).
constexpr int32_t OFFSET_FAST_SWEEPING        = 100; // sdfToSdf reinit, then sweep
constexpr int32_t OFFSET_FAST_SWEEPING_NOINIT = 101; // sweep the band as it is
constexpr int32_t OFFSET_FAST_SWEEPING_BOUND  = 102; // re-sweep the moving side, keep the farther value
constexpr int32_t OFFSET_FAST_SWEEPING_SDF    = 103; // 102, but the first offset sweeps the band as it is

namespace
{

/// Shifts every active value by -fDistance and re-bands: a value at or past
/// the background becomes an inactive +-background, then the tree is pruned
/// to the level-set background.
void ShiftAndReband(openvdb::FloatGrid& oGrid, float fDistance, float fBackground)
{
    openvdb::tree::LeafManager<openvdb::FloatTree> oLeafs(oGrid.tree());
    oLeafs.foreach([fDistance, fBackground](openvdb::FloatTree::LeafNodeType& oLeaf, size_t)
    {
        for (auto it = oLeaf.beginValueOn(); it; ++it)
        {
            const float fValue = *it - fDistance;
            if (std::abs(fValue) >= fBackground)
            {
                it.setValue(fValue < 0.0f ? -fBackground : fBackground);
                it.setValueOff();
            }
            else
            {
                it.setValue(fValue);
            }
        }
    });
    openvdb::tools::changeLevelSetBackground(oGrid.tree(), fBackground);
    openvdb::tools::pruneLevelSet(oGrid.tree());
}

/// VO12: the sweeping tools throw ("inside value must be negative") on a band
/// with no zero crossing, which a thin wall eroded away leaves behind. Such a
/// band only shifts and re-bands, which is what the filter does to it too.
bool bHasInterface(const openvdb::FloatGrid& oGrid)
{
    bool bNegative = false, bPositive = false;
    for (auto it = oGrid.cbeginValueOn(); it && !(bNegative && bPositive); ++it)
    {
        if (*it < 0.0f)
            bNegative = true;
        else
            bPositive = true;
    }
    return bNegative && bPositive;
}

/// How OffsetBySweeping prepares the band before it widens it.
enum class EReinit
{
    None,       // sweep the band as it is (101)
    Full,       // sdfToSdf from the zero crossing (100)
    Bounded     // ForgetMovingSide, sweep, KeepLowerBounds (102, 103)
};

/// After the sweep: a 1-Lipschitz field (a distance field, a union or
/// intersection of them, a band shifted by an earlier offset) never
/// overstates the distance to its own zero crossing, on either side. So on
/// the side the surface moves to, the farther of the old value and the
/// re-swept one is the better estimate. This keeps a closing a closing: the
/// sweep alone misses by up to a tenth of a voxel inwards on beams about a
/// voxel in radius, and a fillet then loses the beams it should keep.
void KeepLowerBounds(openvdb::FloatGrid& oSwept, const openvdb::FloatGrid& oOld, bool bOutward)
{
    openvdb::tree::LeafManager<openvdb::FloatTree> oLeafs(oSwept.tree());
    oLeafs.foreach([&oOld, bOutward](openvdb::FloatTree::LeafNodeType& oLeaf, size_t)
    {
        auto oAcc = oOld.getConstAccessor();
        for (auto it = oLeaf.beginValueOn(); it; ++it)
        {
            float fOld;
            if (!oAcc.probeValue(it.getCoord(), fOld) || (fOld > 0.0f) != bOutward)
                continue;
            if (std::abs(fOld) > std::abs(*it))
                it.setValue(fOld);
        }
    });
}

/// The 102 and 103 preparation. sdfToSdf re-derives the voxels next to the zero
/// crossing from axis-wise linear crossings: the plane through them lies
/// inside a convex surface, so it moves the surface inwards, by up to a
/// tenth of a voxel on a beam one voxel in radius, and every value further
/// out comes from first-order sweeping off those voxels. A fillet runs it
/// twice and erodes thin beams away. Here the interface voxels (a face
/// neighbour of the other sign) keep their values, and every other active
/// value on the side the surface moves to becomes +-background, which
/// dilateSdf treats as unknown and re-derives by sweeping from the
/// interface. That side is the one an earlier step left inconsistent: the
/// inside of a growth that merged features (which a closing has to keep
/// filled), or the outside of an erosion that removed some.
openvdb::FloatGrid::Ptr ForgetMovingSide(const openvdb::FloatGrid& oGrid, bool bOutward)
{
    openvdb::FloatGrid::Ptr roOut = oGrid.deepCopy();
    const float fBackground = oGrid.background();
    openvdb::tree::LeafManager<openvdb::FloatTree> oLeafs(roOut->tree());
    oLeafs.foreach([&oGrid, bOutward, fBackground](openvdb::FloatTree::LeafNodeType& oLeaf, size_t)
    {
        auto oAcc = oGrid.getConstAccessor();
        for (auto it = oLeaf.beginValueOn(); it; ++it)
        {
            if ((*it > 0.0f) != bOutward)
                continue;
            const openvdb::Coord xyz = it.getCoord();
            bool bInterface = false;
            for (int32_t n = 0; n < 6 && !bInterface; n++)
            {
                openvdb::Coord xyzNeighbour = xyz;
                xyzNeighbour[n >> 1] += (n & 1) ? 1 : -1;
                bInterface = (oAcc.getValue(xyzNeighbour) > 0.0f) != bOutward;
            }
            if (!bInterface)
                it.setValue(bOutward ? fBackground : -fBackground);
        }
    });
    return roOut;
}

/// One PicoGK-signed offset (positive grows) by band extension and shift:
/// optionally re-derive the band from its zero crossing (sdfToSdf, for
/// fields that are not distance fields, such as implicit renders), widen it
/// by ceil(|d| / voxel) + 1 voxels on the side the surface moves to with
/// fast-sweeping (Eikonal) distances, subtract d and re-band. Returns the
/// tree to seat into the caller's grid.
openvdb::FloatTree::Ptr OffsetBySweeping(const openvdb::FloatGrid& oGrid, float fDistance, EReinit eReinit)
{
    const float fBackground = oGrid.background();
    if (!bHasInterface(oGrid))
    {
        openvdb::FloatGrid::Ptr roOut = oGrid.deepCopy();
        ShiftAndReband(*roOut, fDistance, fBackground);
        return roOut->treePtr();
    }

    openvdb::FloatGrid::ConstPtr roSource = oGrid.copy(); // shallow: shares the tree
    if (eReinit == EReinit::Full)
    {
        openvdb::FloatGrid::Ptr roReinit = openvdb::tools::sdfToSdf(oGrid, 0.0f, 1);
        openvdb::tools::changeLevelSetBackground(roReinit->tree(), fBackground);
        roSource = roReinit;
    }
    else if (eReinit == EReinit::Bounded)
    {
        roSource = ForgetMovingSide(oGrid, fDistance > 0.0f);
    }

    const float   fVoxel = (float) oGrid.voxelSize().x();
    const int32_t nWiden = (int32_t) std::ceil(std::abs(fDistance) / fVoxel) + 1;
    const auto    eSide  = fDistance > 0.0f ? openvdb::tools::FastSweepingDomain::SWEEP_GREATER_THAN_ISOVALUE
                                            : openvdb::tools::FastSweepingDomain::SWEEP_LESS_THAN_ISOVALUE;
    openvdb::FloatGrid::Ptr roOut = openvdb::tools::dilateSdf(  *roSource, nWiden,
                                                                openvdb::tools::NN_FACE_EDGE_VERTEX, 1, eSide);
    if (eReinit == EReinit::Bounded)
        KeepLowerBounds(*roOut, oGrid, fDistance > 0.0f);
    ShiftAndReband(*roOut, fDistance, fBackground);
    return roOut->treePtr();
}

/// +1 when the sequence's exact result contains its input (one growth, two
/// growths, or a closing that ends at or outside the input: fillet),
/// -1 when it lies inside it (the mirror cases), 0 otherwise (smoothen).
int32_t nContainment(const float* pfDistancesMM, int32_t nCount)
{
    if (nCount < 1 || nCount > 2)
        return 0;
    const float fFirst = pfDistancesMM[0];
    const float fSum   = nCount == 2 ? fFirst + pfDistancesMM[1] : fFirst;
    if (fFirst > 0.0f && fSum >= 0.0f)
        return 1;
    if (fFirst < 0.0f && fSum <= 0.0f)
        return -1;
    return 0;
}

} // namespace

/// Runs `nCount` PicoGK-signed offsets (positive grows) as one filter pass, with the
/// level-set tracker's renormalization tuned. `nSpatialScheme` is an
/// openvdb::math::BiasedGradientScheme (0 = FIRST_BIAS ... 4 = HJWENO5_BIAS, the
/// default) and `nNormCount` the sweeps per CFL step (default 3, 0 disables
/// renormalization entirely). Either < 0 leaves the upstream default in place, so
/// (-1, -1) reproduces Voxels_Offset / DoubleOffset / TripleOffset exactly.
///
/// nSpatialScheme 100 selects the VO1 sweeping engine instead of the filter,
/// re-deriving the band with sdfToSdf before each offset; 101 sweeps the band
/// as it is; 102 re-derives the side the surface moves to from the interface
/// voxels and keeps an old value where it is farther (ForgetMovingSide,
/// KeepLowerBounds); 103 is 102 except that the first offset sweeps the band
/// as it is, for grids that already are distance fields. nNormCount is
/// ignored by all four.
PICOGK_API void Voxels_OffsetTuned(     PKINSTANCE      hLib,
                                        PKVOXELS        hThis,
                                        const float*    pfDistancesMM,
                                        int32_t         nCount,
                                        int32_t         nSpatialScheme,
                                        int32_t         nNormCount)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    if (nSpatialScheme == OFFSET_FAST_SWEEPING || nSpatialScheme == OFFSET_FAST_SWEEPING_NOINIT
        || nSpatialScheme == OFFSET_FAST_SWEEPING_BOUND || nSpatialScheme == OFFSET_FAST_SWEEPING_SDF)
    {
        openvdb::FloatGrid& oGrid = *roVoxels->roVdbGrid();
        // The containment guard (102, 103): first-order sweeping beyond the
        // old band still errs inwards, which on beams a voxel or two thick
        // can remove what a closing must keep. Where the exact result
        // contains its input (or lies inside it), the union with (or the
        // intersection with) the input restores that, at the cost of one CSG.
        const int32_t nGuard = nSpatialScheme >= OFFSET_FAST_SWEEPING_BOUND ? nContainment(pfDistancesMM, nCount) : 0;
        openvdb::FloatGrid::Ptr roInput = nGuard != 0 ? oGrid.deepCopy() : nullptr;
        for (int32_t n = 0; n < nCount; n++)
        {
            const EReinit eReinit = nSpatialScheme == OFFSET_FAST_SWEEPING ? EReinit::Full
                                  : nSpatialScheme == OFFSET_FAST_SWEEPING_NOINIT
                                    || (nSpatialScheme == OFFSET_FAST_SWEEPING_SDF && n == 0) ? EReinit::None
                                                                                               : EReinit::Bounded;
            oGrid.setTree(OffsetBySweeping(oGrid, pfDistancesMM[n], eReinit));
        }
        if (nGuard > 0)
            openvdb::tools::csgUnion(oGrid, *roInput);
        else if (nGuard < 0)
            openvdb::tools::csgIntersection(oGrid, *roInput);
        return;
    }

    openvdb::tools::LevelSetFilter<openvdb::FloatGrid> oFilter(*roVoxels->roVdbGrid());

    if (nSpatialScheme >= 0)
        oFilter.setSpatialScheme((openvdb::math::BiasedGradientScheme) nSpatialScheme);
    if (nNormCount >= 0)
        oFilter.setNormCount(nNormCount);

    // OpenVDB treats offsets as inwards (PicoGKVdbVoxels.h:286).
    for (int32_t n = 0; n < nCount; n++)
        oFilter.offset(-pfDistancesMM[n]);
}
