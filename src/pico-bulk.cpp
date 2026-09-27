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

// SK-0.3 — bulk lattice authoring, the import mirror of the mesh pair above.
//
// Lattice_AddBeam is the hottest ABI site in the port: HelixHeatX crosses it
// 1,197,460 times across 37 lattices. At the post-SK-0.2 direct-export cost of
// 56.4 ns that is ~68 ms of pure crossing, and the facade's per-call option
// destructuring and scratch writes roughly double it.
//
// The wire format is a flat float array, 8 floats per beam, chosen for the GPU
// upload seam rather than for this loop: (x, y, z, radius) per endpoint is two
// vec4 lanes, 32 B stride, no padding under std140 or std430, so the SAME buffer
// the TS side accumulates can be handed to writeBuffer unrepacked (harmonic
// architecture S-A/S-C). Round-cap flags ride in a parallel uint32 array — WGSL
// has no u8, so a byte array would have to be widened for the GPU anyway.
//
// Elements go through Lattice::AddBeam/AddSphere rather than a raw vector insert
// because those maintain the lattice bounding box AND the degenerate-beam rule
// (a round-capped zero-length beam becomes a sphere, PicoGKLattice.h:213-218).
// Bulk-inserting behind their back would change what gets rendered. The win was
// never the loop; it was not crossing the ABI 1.2 million times.
//
// Storage stays upstream's std::vector<LatticeBeam::Ptr> — one make_shared per
// beam. Adopting this flat buffer AS the storage means editing PicoGKLattice.h
// and the renderer in PicoGKVdbVoxels.h, i.e. the vendored tree R4 keeps
// pristine; filed instead as U17 with the measurement that motivates it.

/// Appends nCount beams from a flat float buffer: 8 floats per beam,
/// (x0, y0, z0, r0, x1, y1, z1, r1) — endpoint A then endpoint B, radius in the
/// w lane of each. pnRoundCap is one uint32 per beam (0 = flat cone).
/// Returns the number appended.
PICOGK_API int32_t Lattice_AddBeams(PKINSTANCE      hLib,
                                    PKLATTICE       hThis,
                                    const float*    pfBeams,
                                    const uint32_t* pnRoundCap,
                                    int32_t         nCount)
{
    if (pfBeams == nullptr || pnRoundCap == nullptr || nCount <= 0)
        return 0;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Lattice::Ptr roLattice = roLib->m_oLattices.roGet(hThis);

    for (int32_t n = 0; n < nCount; n++)
    {
        const float* pf = pfBeams + n * 8;
        roLattice->AddBeam( PicoGK::Vector3(pf[0], pf[1], pf[2]),
                            PicoGK::Vector3(pf[4], pf[5], pf[6]),
                            pf[3],
                            pf[7],
                            pnRoundCap[n] != 0);
    }
    return nCount;
}

/// Appends nCount spheres from a flat float buffer: 4 floats per sphere,
/// (x, y, z, radius) — the same vec4 lane shape as one beam endpoint.
/// Returns the number appended.
PICOGK_API int32_t Lattice_AddSpheres(PKINSTANCE   hLib,
                                      PKLATTICE    hThis,
                                      const float* pfSpheres,
                                      int32_t      nCount)
{
    if (pfSpheres == nullptr || nCount <= 0)
        return 0;

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Lattice::Ptr roLattice = roLib->m_oLattices.roGet(hThis);

    for (int32_t n = 0; n < nCount; n++)
    {
        const float* pf = pfSpheres + n * 4;
        roLattice->AddSphere(PicoGK::Vector3(pf[0], pf[1], pf[2]), pf[3]);
    }
    return nCount;
}

