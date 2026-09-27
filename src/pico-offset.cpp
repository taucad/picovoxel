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

#include <openvdb/tools/LevelSetFilter.h>

/// Runs `nCount` PicoGK-signed offsets (positive grows) as one filter pass, with the
/// level-set tracker's renormalization tuned. `nSpatialScheme` is an
/// openvdb::math::BiasedGradientScheme (0 = FIRST_BIAS ... 4 = HJWENO5_BIAS, the
/// default) and `nNormCount` the sweeps per CFL step (default 3, 0 disables
/// renormalization entirely). Either < 0 leaves the upstream default in place, so
/// (-1, -1) reproduces Voxels_Offset / DoubleOffset / TripleOffset exactly.
PICOGK_API void Voxels_OffsetTuned(     PKINSTANCE      hLib,
                                        PKVOXELS        hThis,
                                        const float*    pfDistancesMM,
                                        int32_t         nCount,
                                        int32_t         nSpatialScheme,
                                        int32_t         nNormCount)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    openvdb::tools::LevelSetFilter<openvdb::FloatGrid> oFilter(*roVoxels->roVdbGrid());

    if (nSpatialScheme >= 0)
        oFilter.setSpatialScheme((openvdb::math::BiasedGradientScheme) nSpatialScheme);
    if (nNormCount >= 0)
        oFilter.setNormCount(nNormCount);

    // OpenVDB treats offsets as inwards (PicoGKVdbVoxels.h:286).
    for (int32_t n = 0; n < nCount; n++)
        oFilter.offset(-pfDistancesMM[n]);
}
