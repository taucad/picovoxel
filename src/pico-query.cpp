// SKv2-0 V0.11 — the P8 query repairs: batched raycast over ONE cached
// intersector, and the closest-point algorithm swap (index-once via
// openvdb::tools::ClosestSurfacePoint) with a batched ABI.
//
// Upstream bRayCastToSurface constructs a LevelSetRayIntersector PER CALL
// (PicoGKVdbVoxels.h:733-760) and bFindClosestPointOnSurface runs a Bresenham
// sphere-shell scan that is O(r³) per query and — per the WORKLOAD ledger —
// algorithmically wrong before it is executor-wrong. Both batched entries
// amortize one ABI crossing and one acceleration-structure build over N
// queries.
//
// Raycast semantics are UPSTREAM'S EXACTLY, per ray: origin converted with
// fToVoxels, direction taken as-is, `intersectsIS`, and the hit converted
// with vecToMM(Coord(...)) — including upstream's truncation of the
// fractional index-space hit to integer voxel coordinates (batch ≡ serial
// exact per ray is the gate; fixing the truncation would be a value change
// and belongs to a chartered move of its own).
//
// Closest-point is the C2-by-nature algorithm swap: ClosestSurfacePoint
// builds its index once and answers every query with sub-voxel surface
// points. The SDF is its own oracle: |φ(query)| IS the true distance (within
// band clamping), so the test gates check the returned point lies in-band
// and its distance matches |φ| within a voxel — no comparison against the
// old scan's voxel-snapped answer is meaningful beyond that band.

#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/openvdb.h>
#include <openvdb/tools/RayIntersector.h>
#include <openvdb/tools/VolumeToSpheres.h>
#include <openvdb/util/NullInterrupter.h>

#include <cmath>
#include <vector>

/// N rays against one cached LevelSetRayIntersector. Returns the hit count;
/// pbHit[i] ∈ {0,1}; pvecHits[i] is valid only where pbHit[i] == 1.
/// The shared ray loop. bSubVoxel keeps the fractional index-space hit (MI6):
/// upstream truncates it to whole voxels, which puts hits up to one voxel
/// inside the surface along each positive axis.
static int32_t nRayCastBatch(   PKINSTANCE       hLib,
                                PKVOXELS         hThis,
                                const PKVector3* pvecOrigins,
                                const PKVector3* pvecDirections,
                                int32_t          nCount,
                                PKVector3*       pvecHits,
                                uint8_t*         pbHit,
                                bool             bSubVoxel)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);
    const openvdb::FloatGrid& oGrid = *roVoxels->roVdbGrid();
    const PicoGK::VoxelSize oVoxelSize = roVoxels->oVoxelSize();
    const float fVoxelSize = (float) oVoxelSize;

    openvdb::tools::LevelSetRayIntersector<openvdb::FloatGrid> oIntersector(oGrid);

    int32_t nHits = 0;
    for (int32_t i = 0; i < nCount; i++)
    {
        // Upstream's own public fToVoxels per axis — identical by construction.
        openvdb::math::Ray<openvdb::Real> oRay(
            openvdb::Vec3f(oVoxelSize.fToVoxels(pvecOrigins[i].X),
                           oVoxelSize.fToVoxels(pvecOrigins[i].Y),
                           oVoxelSize.fToVoxels(pvecOrigins[i].Z)),
            openvdb::Vec3f(pvecDirections[i].X, pvecDirections[i].Y, pvecDirections[i].Z));

        openvdb::math::Vec3<openvdb::Real> xyz;
        if (oIntersector.intersectsIS(oRay, xyz))
        {
            if (bSubVoxel)
            {
                pvecHits[i] = PicoGK::Vector3(  (float) xyz.x() * fVoxelSize,
                                                (float) xyz.y() * fVoxelSize,
                                                (float) xyz.z() * fVoxelSize);
            }
            else
            {
                // Upstream truncation preserved: vecToMM(Coord(x, y, z)) — the
                // Coord construction truncates the fractional index-space hit.
                pvecHits[i] = oVoxelSize.vecToMM(PicoGK::Coord((int32_t)xyz.x(),
                                                               (int32_t)xyz.y(),
                                                               (int32_t)xyz.z()));
            }
            pbHit[i] = 1;
            nHits++;
        }
        else
        {
            pbHit[i] = 0;
        }
    }
    return nHits;
}

PICOGK_API int32_t Voxels_RayCastBatch( PKINSTANCE       hLib,
                                        PKVOXELS         hThis,
                                        const PKVector3* pvecOrigins,
                                        const PKVector3* pvecDirections,
                                        int32_t          nCount,
                                        PKVector3*       pvecHits,
                                        uint8_t*         pbHit)
{
    return nRayCastBatch(hLib, hThis, pvecOrigins, pvecDirections, nCount, pvecHits, pbHit, false);
}

/// MI6 — the same rays, with each hit at its fractional index-space position
/// instead of truncated to a whole voxel. Opt-in: it changes the answers.
PICOGK_API int32_t Voxels_RayCastBatchSubVoxel( PKINSTANCE       hLib,
                                                PKVOXELS         hThis,
                                                const PKVector3* pvecOrigins,
                                                const PKVector3* pvecDirections,
                                                int32_t          nCount,
                                                PKVector3*       pvecHits,
                                                uint8_t*         pbHit)
{
    return nRayCastBatch(hLib, hThis, pvecOrigins, pvecDirections, nCount, pvecHits, pbHit, true);
}

/// N closest-surface-point queries against one index build. Returns the
/// found count; pbFound[i] ∈ {0,1}; pvecPoints[i] valid only where found.
PICOGK_API int32_t Voxels_ClosestPointBatch(PKINSTANCE       hLib,
                                            PKVOXELS         hThis,
                                            const PKVector3* pvecQueries,
                                            int32_t          nCount,
                                            PKVector3*       pvecPoints,
                                            uint8_t*         pbFound)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);
    const openvdb::FloatGrid& oGrid = *roVoxels->roVdbGrid();

    auto roIndex = openvdb::tools::ClosestSurfacePoint<openvdb::FloatGrid>::create(oGrid);
    if (!roIndex)
    {
        for (int32_t i = 0; i < nCount; i++)
            pbFound[i] = 0;
        return 0;
    }

    std::vector<openvdb::Vec3R> vecPoints((size_t)nCount);
    for (int32_t i = 0; i < nCount; i++)
        vecPoints[(size_t)i] = openvdb::Vec3R(pvecQueries[i].X, pvecQueries[i].Y, pvecQueries[i].Z);

    std::vector<float> vecDistances;
    const bool bOk = roIndex->searchAndReplace(vecPoints, vecDistances);

    int32_t nFound = 0;
    for (int32_t i = 0; i < nCount; i++)
    {
        const bool bFound = bOk && std::isfinite(vecDistances[(size_t)i]);
        pbFound[i] = bFound ? 1 : 0;
        if (bFound)
        {
            pvecPoints[i] = PKVector3((float)vecPoints[(size_t)i].x(),
                                      (float)vecPoints[(size_t)i].y(),
                                      (float)vecPoints[(size_t)i].z());
            nFound++;
        }
    }
    return nFound;
}
