// SK-0.5 — voxel field properties in one crossing, with surface area.
//
// `properties()` used to be four ABI calls driven from TypeScript, with two
// intermediate handles registered in the manager and torn down again:
//
//     Mesh_hCreateFromVoxels -> Mesh_GetBoundingBox
//                            -> Voxels_hCreate -> Voxels_RenderMesh
//                            -> Voxels_fCalculateVolume -> destroy, destroy
//
// This TU is that same sequence, in-module, plus openvdb's levelSetArea over the
// grid the sequence already builds.
//
// WHY THE MESH ROUND-TRIP SURVIVES (a deliberate deviation from the audit).
// The A4/A5 reading was that properties()
// re-voxelizes out of laziness and that levelSetVolume over the live grid would
// do. It would not. openvdb's csg ops leave distance-0 voxels behind on
// coincident surfaces, and LevelSetMeasure integrates them as real surface: a−a
// is geometrically empty yet measures a large fraction of a's volume. The
// round-trip through volumeToMesh/meshToVolume IS the correction (upstream's own
// levelSetRebuild is mesh-based for exactly this reason, and it is disabled in
// this tree). test/voxels-properties.test.ts pins the correction at >100x on
// a−a, and five fixture files pin properties().volume as a hex float64. So the
// volume and bounds computed here are the SAME FLOATS the four-call sequence
// produced, by construction — this TU moves the sequence, it does not change it.
//
// Area is the part that is genuinely grid-native: tools::levelSetArea over the
// corrected grid, no second meshing pass, no extra allocation.

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/LevelSetMeasure.h>

/// Volume (mm³), surface area (mm²) and the iso-surface bounding box of a voxel
/// field, from one traversal of the corrected level set. Any out-parameter may
/// be null. An empty field reports 0/0 and leaves the box untouched.
PICOGK_API void Voxels_GetProperties(   PKINSTANCE  hLib,
                                        PKVOXELS    hThis,
                                        float*      pfVolume,
                                        float*      pfArea,
                                        PKBBox3*    poBBox)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    // Mesh_hCreateFromVoxels + Mesh_GetBoundingBox.
    PicoGK::Mesh::Ptr roMesh = roVoxels->roAsMesh();
    if (poBBox != nullptr)
        *poBBox = roMesh->oBBox();

    // Voxels_hCreate + Voxels_RenderMesh — same construction Voxels_hCreate uses
    // (library voxel size, default narrow band), just not handle-registered.
    PicoGK::Voxels oFresh(roLib->fVoxelSizeMM(), PICOGK_VOXEL_DEFAULTNARROWBAND);
    oFresh.RenderMesh(*roMesh);

    const openvdb::FloatGrid::Ptr roGrid = oFresh.roVdbGrid();
    const bool bEmpty = roGrid->tree().empty();

    // Voxels_fCalculateVolume: same guard, same call, same float.
    if (pfVolume != nullptr)
        *pfVolume = bEmpty ? 0.0f : (float) openvdb::tools::levelSetVolume(*roGrid, true);

    if (pfArea != nullptr)
        *pfArea = bEmpty ? 0.0f : (float) openvdb::tools::levelSetArea(*roGrid, true);
}
