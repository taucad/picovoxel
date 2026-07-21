// R11 — bulk mesh readback.
//
// PicoGK exports Mesh_GetVertex/Mesh_GetTriangle, one element per call. Reading a
// 174k-vertex mesh therefore costs ~522k ABI crossings, which dominates every
// PicoGK-level timing and makes the port look far slower than it is.
//
// The data is already contiguous and bulk-copyable: Mesh::vVertices()/vTriangles()
// (PicoGKMesh.h:161,166) return const refs to std::vector<Vector3>/<Triangle>, both
// 12-byte #pragma pack(1) types identical in layout to PKVector3/PKTriangle. So two
// exports turn 522k crossings into 2.
//
// This lives in picovoxel rather than as a patch to PicoGKRuntime, keeping the
// vendored tree pristine (see R4). It is a separate translation unit that links
// alongside the generated core TU. Signature follows the existing caller-supplied
// buffer precedent, Voxels_GetZSlice (PicoGK.h:341).
//
// Best upstream-contribution candidate: ~10 lines against a real bottleneck.

// Include order is load-bearing and must match PicoGKLibrary.cpp: PicoGKApiTypes.h
// (pulled in by PicoGK.h) checks whether the "rich" PicoGK types are already present
// and, if so, #defines PKVector3 -> PicoGK::Vector3 (PicoGKApiTypes.h:40-53). Include
// PicoGK.h first and you get a SEPARATE POD PKVector3, and the runtime's own headers
// stop compiling. Do not let a formatter sort these.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <algorithm>
#include <type_traits>

// Layout guarantees, proved at compile time — a silent mismatch here would corrupt
// geometry rather than fail to build. (Given the include order above, PKVector3 IS
// PicoGK::Vector3, so the pair is one type.)
//
// Note Vector3 is NOT trivially copyable: it has a user-provided copy constructor
// (PicoGKTypes.h:146) that is memberwise in effect but formally user-provided, so
// memcpy on it is UB even though every real compiler would do the right thing.
// std::copy is well-defined and clang lowers it to the same vectorised move at -O3,
// so there is nothing to buy by cheating here. Triangle (= Coord, PicoGKTypes.h:127)
// happens to be trivially copyable; use the same construct for both regardless.
static_assert(sizeof(PicoGK::Vector3) == 12, "Vector3 must be 12 bytes");
static_assert(sizeof(PicoGK::Triangle) == 12, "Triangle must be 12 bytes");
static_assert(std::is_standard_layout<PicoGK::Vector3>::value, "Vector3 layout not standard");
static_assert(std::is_standard_layout<PicoGK::Triangle>::value, "Triangle layout not standard");

/// Copies up to nBufferCount vertices into a caller-supplied buffer.
/// Returns the number actually written. Pass nBufferCount from Mesh_nVertexCount.
PICOGK_API int32_t Mesh_GetVertices(PKINSTANCE   hLib,
                                    PKMESH       hThis,
                                    PKVector3*   pvecBuffer,
                                    int32_t      nBufferCount)
{
    if (pvecBuffer == nullptr || nBufferCount <= 0)
        return 0;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    const std::vector<PicoGK::Vector3>& oVertices = roLib->m_oMeshes.roGet(hThis)->vVertices();

    // Clamp to the caller's buffer — never trust the count to match the mesh.
    const int32_t nCount = std::min(nBufferCount, static_cast<int32_t>(oVertices.size()));
    std::copy(oVertices.begin(), oVertices.begin() + nCount, pvecBuffer);
    return nCount;
}

/// Copies up to nBufferCount triangles into a caller-supplied buffer.
/// Returns the number actually written. Pass nBufferCount from Mesh_nTriangleCount.
PICOGK_API int32_t Mesh_GetTriangles(PKINSTANCE  hLib,
                                     PKMESH      hThis,
                                     PKTriangle* psBuffer,
                                     int32_t     nBufferCount)
{
    if (psBuffer == nullptr || nBufferCount <= 0)
        return 0;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    const std::vector<PicoGK::Triangle>& oTriangles = roLib->m_oMeshes.roGet(hThis)->vTriangles();

    const int32_t nCount = std::min(nBufferCount, static_cast<int32_t>(oTriangles.size()));
    std::copy(oTriangles.begin(), oTriangles.begin() + nCount, psBuffer);
    return nCount;
}

// R8 — the import mirror of the two exports above: one ABI crossing carries the
// whole array in. Elements go through Mesh::nAddVertex/nAddTriangle rather than a
// raw vector insert because those maintain the mesh's bounding box and memUsage
// bookkeeping (PicoGKMesh.h:76-93) — bulk-inserting behind their back would corrupt
// Mesh_GetBoundingBox. The per-element cost is a few ns in-wasm; the win was never
// the loop, it was not crossing the ABI 100k times.

/// Appends nCount vertices from a caller-supplied buffer.
/// Returns the index of the FIRST appended vertex (they are contiguous).
PICOGK_API int32_t Mesh_AddVertices(PKINSTANCE       hLib,
                                    PKMESH           hThis,
                                    const PKVector3* pvecBuffer,
                                    int32_t          nCount)
{
    if (pvecBuffer == nullptr || nCount <= 0)
        return -1;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Mesh::Ptr roMesh = roLib->m_oMeshes.roGet(hThis);

    const int32_t nFirst = roMesh->nAddVertex(pvecBuffer[0]);
    for (int32_t n = 1; n < nCount; n++)
        roMesh->nAddVertex(pvecBuffer[n]);
    return nFirst;
}

/// Appends nCount triangles (vertex-index triples) from a caller-supplied buffer.
/// Returns the index of the FIRST appended triangle (they are contiguous).
PICOGK_API int32_t Mesh_AddTriangles(PKINSTANCE       hLib,
                                     PKMESH           hThis,
                                     const PKTriangle* psBuffer,
                                     int32_t           nCount)
{
    if (psBuffer == nullptr || nCount <= 0)
        return -1;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Mesh::Ptr roMesh = roLib->m_oMeshes.roGet(hThis);

    const int32_t nFirst = roMesh->nAddTriangle(psBuffer[0]);
    for (int32_t n = 1; n < nCount; n++)
        roMesh->nAddTriangle(psBuffer[n]);
    return nFirst;
}

