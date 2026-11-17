// Streamed meshing and STL export: the K6 slab mesher (research run
// 2026-11-16-r1, lane k6-streamed-meshing), moved into a production TU.
//
// toMesh() materializes the whole uniform mesh, and toStl() then copies it out
// twice more (a staging buffer in the heap, a JS array outside it) before the
// file exists as one buffer. At fine voxel sizes that export transient is the
// largest single allocation of a run. Three additions remove it:
//
//  1. Zero-copy readback. Mesh_pVertexData / Mesh_pTriangleData return the
//     address of the Mesh's own std::vector storage, so the facade copies
//     straight out of the heap instead of malloc-ing a staging buffer of the
//     same size first.
//  2. STL records from an existing Mesh, a slice at a time
//     (Mesh_GetStlRecords): the 50-byte records src/stl.ts writes, computed
//     here so a caller can stream them into a fixed-size buffer.
//  3. A slab mesher (MeshStream_*): the uniform dual-contouring pass of
//     openvdb::tools::VolumeToMesh, driven batch by batch over the level-1
//     internal nodes (128^3 voxels each) of the surface-intersection tree, in
//     tree order. A batch owns the cells inside its nodes and reads a halo of
//     whole neighbouring leaves on the low x/y/z sides; a quad is emitted by
//     the batch that owns the cell whose low edge it wraps. VolumeToMesh
//     emits per leaf in tree order, so the concatenation of the batches is the
//     monolithic output element for element: the same triangle sequence and,
//     in indexed mode, the same vertex sequence and global indices as
//     Voxels::roAsMesh(0) (the flat-quad path of patches/openvdb/0001).
//
// The mesher drives OpenVDB's own volume_to_mesh_internal passes for the
// uniform path; nothing vendored changes. Memory per batch is about one batch
// of sign and index leaves plus its points and quads, against the whole mesh
// plus two copies of it for toMesh().toStl().
//
// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/VolumeToMesh.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <vector>

namespace
{
namespace v2m = openvdb::tools::volume_to_mesh_internal;

using FloatTreeT   = openvdb::FloatGrid::TreeType;
using BoolTreeT    = FloatTreeT::ValueConverter<bool>::Type;
using BoolLeafT    = BoolTreeT::LeafNodeType;
using BoolL1T      = BoolTreeT::RootNodeType::ChildNodeType::ChildNodeType;
using Int16TreeT   = FloatTreeT::ValueConverter<openvdb::Int16>::Type;
using Int16LeafT   = Int16TreeT::LeafNodeType;
using Index32TreeT = FloatTreeT::ValueConverter<openvdb::Index32>::Type;
using Index32LeafT = Index32TreeT::LeafNodeType;

static_assert(sizeof(PicoGK::Vector3) == 12, "Vector3 must be three packed floats");
static_assert(sizeof(PicoGK::Triangle) == 12, "Triangle must be three packed int32");

/// One binary-STL record, computed exactly as src/stl.ts writeStlBytes does on
/// its identity path (millimetres, scale 1, offset 0): each corner is a float32
/// widened to double with `+ 0` (so -0 becomes +0), and the normal is float64
/// arithmetic rounded once to float32. wasm32 has no fused multiply-add, so the
/// products below round like the JavaScript ones (see build-pico-module.sh).
inline void WriteStlRecord(uint8_t* pnOut, const float* pfA, const float* pfB, const float* pfC)
{
    double ad[9];
    for (int i = 0; i < 3; i++)
    {
        ad[i]     = double(pfA[i]) + 0.0;
        ad[3 + i] = double(pfB[i]) + 0.0;
        ad[6 + i] = double(pfC[i]) + 0.0;
    }
    const double ux = ad[3] - ad[0], uy = ad[4] - ad[1], uz = ad[5] - ad[2];
    const double vx = ad[6] - ad[0], vy = ad[7] - ad[1], vz = ad[8] - ad[2];
    double nx = uy * vz - uz * vy;
    double ny = uz * vx - ux * vz;
    double nz = ux * vy - uy * vx;
    const double dLength = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (dLength > 0)
    {
        nx /= dLength;
        ny /= dLength;
        nz /= dLength;
    }
    float af[12];
    af[0] = float(nx);
    af[1] = float(ny);
    af[2] = float(nz);
    for (int i = 0; i < 9; i++)
        af[3 + i] = float(ad[i]);
    std::memcpy(pnOut, af, 48);
    pnOut[48] = 0;
    pnOut[49] = 0;
}

/// What a stream hands out per chunk.
enum Mode : int32_t
{
    kStl     = 0, ///< 50-byte STL records, at most nChunkQuads * 2 per chunk
    kIndexed = 1, ///< per batch: float32 xyz vertices + global corner indices
    kCount   = 2, ///< nothing; counts only (the pass a non-seekable STL sink needs)
};

struct MeshStream
{
    openvdb::FloatGrid::Ptr roGrid; // keeps the grid alive while streaming
    BoolTreeT oIsect{false};
    std::vector<const BoolL1T*> apL1;
    size_t nNextL1 = 0;
    size_t nMaxLeaves = 1;
    size_t nChunkQuads = 1;
    int32_t nMode = kStl;
    bool bInvert = false;

    std::vector<uint8_t> anOut;       // STL records, or vertices in indexed mode
    std::vector<uint32_t> anOutTris;  // indexed mode: global corner indices
    std::map<openvdb::Coord, openvdb::Index32> oGlobalOffset; // indexed: leaf origin -> first point

    // STL mode: the current batch's points and compacted quads, formatted into
    // anOut one chunk per call, so the record buffer never scales with the
    // batch (a record is 50 bytes per triangle, four times the indexed form).
    std::unique_ptr<openvdb::Vec3s[]> aPendingPoints;
    std::unique_ptr<openvdb::Vec4I[]> aPendingQuads;
    size_t nPendingQuads = 0;
    size_t nPendingAt = 0;

    double dTriangles = 0;
    double dVertices = 0;
};

/// Formats the next chunk of the pending batch into anOut. Returns false when
/// the batch is exhausted, and releases its points and quads.
bool bNextStlChunk(MeshStream& s)
{
    if (s.nPendingAt >= s.nPendingQuads)
    {
        s.aPendingPoints.reset();
        s.aPendingQuads.reset();
        s.nPendingQuads = 0;
        s.nPendingAt = 0;
        return false;
    }
    const size_t nFirst = s.nPendingAt;
    const size_t nCount = std::min(s.nChunkQuads, s.nPendingQuads - nFirst);
    s.anOut.resize(nCount * 100);
    uint8_t* pnOut = s.anOut.data();
    const openvdb::Vec3s* aP = s.aPendingPoints.get();
    const openvdb::Vec4I* aQ = s.aPendingQuads.get() + nFirst;
    tbb::parallel_for(tbb::blocked_range<size_t>(0, nCount, 1024), [&](const tbb::blocked_range<size_t>& oRange) {
        for (size_t i = oRange.begin(); i != oRange.end(); i++)
        {
            const openvdb::Vec4I& q = aQ[i];
            uint8_t* pnDst = pnOut + i * 100;
            // The split and winding of Voxels::roAsMesh: (q2,q1,q0), (q0,q3,q2).
            WriteStlRecord(pnDst, aP[q[2]].asPointer(), aP[q[1]].asPointer(), aP[q[0]].asPointer());
            WriteStlRecord(pnDst + 50, aP[q[0]].asPointer(), aP[q[3]].asPointer(), aP[q[2]].asPointer());
        }
    });
    s.nPendingAt += nCount;
    return true;
}

/// Meshes the next batch of level-1 nodes. Returns false at the end.
bool bNextBatch(MeshStream& s)
{
    s.anOut.clear();
    std::vector<uint32_t>().swap(s.anOutTris);
    if (s.nMode == kIndexed)
        std::vector<uint8_t>().swap(s.anOut); // release before the batch allocates
    if (s.nNextL1 >= s.apL1.size())
        return false;

    const FloatTreeT& roInput = s.roGrid->tree();
    const float fIso = 0.0f;

    // The batch: consecutive level-1 nodes in tree order, at least one.
    std::vector<const BoolLeafT*> apOwned;
    std::set<openvdb::Coord> oOwnedL1;
    while (s.nNextL1 < s.apL1.size())
    {
        const BoolL1T* pNode = s.apL1[s.nNextL1];
        const size_t nChildren = pNode->getChildMask().countOn();
        if (!apOwned.empty() && apOwned.size() + nChildren > s.nMaxLeaves)
            break;
        for (auto it = pNode->cbeginChildOn(); it; ++it)
            apOwned.push_back(&*it);
        oOwnedL1.insert(pNode->origin());
        s.nNextL1++;
    }

    // Intersection mask for the batch: owned leaves plus low-side halo leaves.
    BoolTreeT oBatch(false);
    {
        openvdb::tree::ValueAccessor<BoolTreeT> oAcc(oBatch);
        for (const BoolLeafT* pLeaf : apOwned)
            oAcc.addLeaf(new BoolLeafT(*pLeaf));
        openvdb::tree::ValueAccessor<const BoolTreeT> oFull(s.oIsect);
        const int32_t D = int32_t(BoolLeafT::DIM);
        for (const BoolLeafT* pLeaf : apOwned)
        {
            const openvdb::Coord o = pLeaf->origin();
            for (int d = 1; d < 7; d++) // a quad reaches -1 in at most two axes
            {
                const openvdb::Coord c(o.x() - D * (d & 1), o.y() - D * ((d >> 1) & 1), o.z() - D * ((d >> 2) & 1));
                if (oAcc.probeConstLeaf(c) != nullptr)
                    continue;
                if (const BoolLeafT* pHalo = oFull.probeConstLeaf(c))
                    oAcc.addLeaf(new BoolLeafT(*pHalo));
            }
        }
    }

    // Sign flags and point indices, for the batch only.
    Int16TreeT oSign(0);
    Index32TreeT oIdx(std::numeric_limits<openvdb::Index32>::max());
    v2m::computeAuxiliaryData(oSign, oIdx, oBatch, roInput, fIso);
    oBatch.clear();

    std::vector<Index32LeafT*> apIdx;
    oIdx.getNodes(apIdx);
    std::vector<Int16LeafT*> apSign;
    oSign.getNodes(apSign);
    const size_t nLeaves = apSign.size();
    const tbb::blocked_range<size_t> oRange(0, nLeaves);

    std::unique_ptr<openvdb::Index32[]> anOffsets(new openvdb::Index32[nLeaves + 1]);
    tbb::parallel_for(oRange, v2m::LeafNodePointCount<Int16LeafT::LOG2DIM>(apSign, anOffsets));
    openvdb::Index32 nPoints = 0;
    for (size_t n = 0; n < nLeaves; n++)
    {
        const openvdb::Index32 nTmp = anOffsets[n];
        anOffsets[n] = nPoints;
        nPoints += nTmp;
    }
    anOffsets[nLeaves] = nPoints;

    std::unique_ptr<openvdb::Vec3s[]> aPoints;
    if (s.nMode != kCount)
    {
        aPoints.reset(new openvdb::Vec3s[nPoints]);
        v2m::ComputePoints<FloatTreeT> oOp(aPoints.get(), roInput, apIdx, apSign, anOffsets,
                                           s.roGrid->transform(), double(fIso));
        tbb::parallel_for(oRange, oOp);
    }

    // Ownership: a sign leaf is owned when its level-1 node is in the batch.
    std::vector<Int16LeafT*> apOwnedSign;
    std::vector<size_t> anOwnedIndex;
    apOwnedSign.reserve(nLeaves);
    const int32_t nL1Mask = ~int32_t(BoolL1T::DIM - 1);
    for (size_t n = 0; n < nLeaves; n++)
    {
        const openvdb::Coord o = apSign[n]->origin();
        if (oOwnedL1.count(openvdb::Coord(o.x() & nL1Mask, o.y() & nL1Mask, o.z() & nL1Mask)) != 0)
        {
            apOwnedSign.push_back(apSign[n]);
            anOwnedIndex.push_back(n);
        }
    }
    const size_t nOwned = apOwnedSign.size();

    // Indexed mode: rewrite batch-local point indices to the global numbering.
    // A halo leaf always belongs to an earlier batch: its origin is lower on
    // every axis, and tree order is lexicographic in x, y, z.
    if (s.nMode == kIndexed)
    {
        std::vector<openvdb::Index32> anDelta(nLeaves);
        openvdb::Index32 nGlobal = openvdb::Index32(s.dVertices);
        size_t nOwnedVerts = 0;
        for (size_t n = 0, m = 0; n < nLeaves; n++)
        {
            const openvdb::Coord o = apSign[n]->origin();
            openvdb::Index32 nFirst;
            if (m < nOwned && anOwnedIndex[m] == n)
            {
                nFirst = nGlobal;
                s.oGlobalOffset[o] = nFirst;
                nGlobal += anOffsets[n + 1] - anOffsets[n];
                nOwnedVerts += anOffsets[n + 1] - anOffsets[n];
                m++;
            }
            else
            {
                nFirst = s.oGlobalOffset.at(o);
            }
            anDelta[n] = nFirst - anOffsets[n];
        }
        tbb::parallel_for(oRange, [&](const tbb::blocked_range<size_t>& oLeafRange) {
            for (size_t n = oLeafRange.begin(); n != oLeafRange.end(); n++)
            {
                Index32LeafT& roLeaf = *apIdx[n];
                openvdb::Index32* anData = roLeaf.buffer().data();
                const openvdb::Index32 nDelta = anDelta[n];
                for (auto it = roLeaf.beginValueOn(); it; ++it)
                    anData[it.pos()] += nDelta;
            }
        });
        s.anOut.resize(nOwnedVerts * 12);
        size_t nAt = 0;
        for (size_t m = 0; m < nOwned; m++)
        {
            const size_t n = anOwnedIndex[m];
            const size_t nCount = anOffsets[n + 1] - anOffsets[n];
            std::memcpy(s.anOut.data() + nAt, aPoints.get() + anOffsets[n], nCount * 12);
            nAt += nCount * 12;
        }
        s.dVertices += double(nOwnedVerts);
        aPoints.reset();
    }

    // Quads for the owned leaves, at per-leaf upper-bound slots (the flat-quad
    // emission of patches/openvdb/0001, which roAsMesh(0) runs).
    std::vector<size_t> anSlot(nOwned + 1, 0), anCount(nOwned, 0);
    {
        std::unique_ptr<size_t[]> anUpper(new size_t[nOwned]);
        tbb::parallel_for(tbb::blocked_range<size_t>(0, nOwned),
                          v2m::CountUniformQuadBounds<FloatTreeT>(apOwnedSign, anUpper.get()));
        for (size_t n = 0; n < nOwned; n++)
            anSlot[n + 1] = anSlot[n] + anUpper[n];
    }
    std::unique_ptr<openvdb::Vec4I[]> aQuads(new openvdb::Vec4I[anSlot[nOwned]]);
    tbb::parallel_for(tbb::blocked_range<size_t>(0, nOwned),
                      v2m::ComputeFlatQuads<FloatTreeT>(apOwnedSign, oSign, oIdx, aQuads.get(), anSlot.data(),
                                                        anCount.data(), s.bInvert));
    oSign.clear();
    oIdx.clear();

    std::vector<size_t> anBase(nOwned + 1, 0);
    for (size_t n = 0; n < nOwned; n++)
        anBase[n + 1] = anBase[n] + anCount[n];
    const size_t nQuads = anBase[nOwned];

    if (s.nMode == kStl)
    {
        // Compact the per-leaf slots into one run, in leaf order, and hand
        // points and quads to the chunk formatter.
        openvdb::Vec4I* aQ = aQuads.get();
        for (size_t n = 0; n < nOwned; n++)
            if (anCount[n] != 0)
                std::memmove(static_cast<void*>(aQ + anBase[n]), aQ + anSlot[n], anCount[n] * sizeof(openvdb::Vec4I));
        s.aPendingPoints = std::move(aPoints);
        s.aPendingQuads = std::move(aQuads);
        s.nPendingQuads = nQuads;
        s.nPendingAt = 0;
    }
    else if (s.nMode == kIndexed)
    {
        s.anOutTris.resize(nQuads * 6);
        uint32_t* anTris = s.anOutTris.data();
        tbb::parallel_for(tbb::blocked_range<size_t>(0, nOwned), [&](const tbb::blocked_range<size_t>& oLeafRange) {
            for (size_t n = oLeafRange.begin(); n != oLeafRange.end(); n++)
            {
                const openvdb::Vec4I* aSrc = aQuads.get() + anSlot[n];
                uint32_t* pnDst = anTris + anBase[n] * 6;
                for (size_t i = 0, I = anCount[n]; i < I; i++, pnDst += 6)
                {
                    const openvdb::Vec4I& q = aSrc[i];
                    pnDst[0] = q[2];
                    pnDst[1] = q[1];
                    pnDst[2] = q[0];
                    pnDst[3] = q[0];
                    pnDst[4] = q[3];
                    pnDst[5] = q[2];
                }
            }
        });
    }

    s.dTriangles += double(nQuads) * 2;
    return true;
}

PicoGK::Mesh::Ptr roMesh(PKINSTANCE hLib, PKMESH hThis)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    return roLib->m_oMeshes.roGet(hThis);
}
} // namespace

/// The Mesh's own vertex storage (xyz float32 triples, Mesh_nVertexCount of
/// them). Valid until the mesh is destroyed or changed; read it before the
/// next allocating call. Null for a mesh without vertices.
PICOGK_API const PKVector3* Mesh_pVertexData(PKINSTANCE hLib, PKMESH hThis)
{
    return roMesh(hLib, hThis)->vVertices().data();
}

/// The Mesh's own triangle storage (int32 corner triples, Mesh_nTriangleCount
/// of them), with the lifetime rules of Mesh_pVertexData.
PICOGK_API const PKTriangle* Mesh_pTriangleData(PKINSTANCE hLib, PKMESH hThis)
{
    return roMesh(hLib, hThis)->vTriangles().data();
}

/// Writes the 50-byte binary-STL records (millimetres, no transform) of the
/// triangles [nFirst, nFirst + nCount) into pnBuffer, which holds nCount * 50
/// bytes. The range is clamped to the mesh; returns the records written.
PICOGK_API int32_t Mesh_GetStlRecords(  PKINSTANCE  hLib,
                                        PKMESH      hThis,
                                        int32_t     nFirst,
                                        int32_t     nCount,
                                        uint8_t*    pnBuffer)
{
    PicoGK::Mesh::Ptr roThis = roMesh(hLib, hThis);
    const int32_t nTriangles = roThis->nTriangleCount();
    if (nFirst < 0 || nCount <= 0 || nFirst >= nTriangles)
        return 0;
    const int32_t nEnd = nFirst + std::min(nCount, nTriangles - nFirst);
    const float* afV = reinterpret_cast<const float*>(roThis->vVertices().data());
    const int32_t* anT = reinterpret_cast<const int32_t*>(roThis->vTriangles().data());
    for (int32_t n = nFirst; n < nEnd; n++, pnBuffer += 50)
        WriteStlRecord(pnBuffer, afV + 3 * anT[3 * n], afV + 3 * anT[3 * n + 1], afV + 3 * anT[3 * n + 2]);
    return nEnd - nFirst;
}

/// Starts a slab-meshing pass over the uniform (adaptivity 0) mesh of the
/// voxels. nMode is 0 (STL records), 1 (indexed chunks) or 2 (count only).
/// nBatchLeaves bounds the surface leaves a batch owns (a batch is always at
/// least one level-1 node); nChunkTriangles bounds the records per STL chunk.
/// Values below 1 count as 1. The stream keeps the grid alive; destroy it with
/// MeshStream_Destroy. Returns null for an unknown mode.
PICOGK_API void* MeshStream_pCreate(PKINSTANCE  hLib,
                                    PKVOXELS    hVoxels,
                                    int32_t     nMode,
                                    int32_t     nBatchLeaves,
                                    int32_t     nChunkTriangles)
{
    if (nMode != kStl && nMode != kIndexed && nMode != kCount)
        return nullptr;
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hVoxels);
    std::unique_ptr<MeshStream> poStream(new MeshStream());
    poStream->roGrid = roVoxels->roVdbGrid();
    poStream->nMode = nMode;
    poStream->nMaxLeaves = size_t(std::max(nBatchLeaves, 1));
    poStream->nChunkQuads = size_t(std::max(nChunkTriangles / 2, 1));
    poStream->bInvert = poStream->roGrid->getGridClass() != openvdb::GRID_LEVEL_SET;
    v2m::identifySurfaceIntersectingVoxels(poStream->oIsect, poStream->roGrid->tree(), 0.0f);
    static_cast<const BoolTreeT&>(poStream->oIsect).getNodes(poStream->apL1);
    return poStream.release();
}

/// Produces the next chunk. Returns 1 when a chunk is ready (an STL chunk may
/// hold no records only in count mode), 0 at the end of the mesh.
PICOGK_API int32_t MeshStream_nNext(void* pStream)
{
    MeshStream& s = *static_cast<MeshStream*>(pStream);
    if (s.nMode != kStl)
        return bNextBatch(s) ? 1 : 0;
    for (;;)
    {
        if (bNextStlChunk(s))
            return 1;
        if (!bNextBatch(s))
            return 0;
    }
}

/// The current chunk: STL records, or float32 xyz vertices in indexed mode.
PICOGK_API const uint8_t* MeshStream_pData(void* pStream)
{
    return static_cast<MeshStream*>(pStream)->anOut.data();
}

/// Bytes at MeshStream_pData.
PICOGK_API int32_t MeshStream_nDataBytes(void* pStream)
{
    return int32_t(static_cast<MeshStream*>(pStream)->anOut.size());
}

/// Indexed mode: the current chunk's global corner indices (uint32 triples).
PICOGK_API const uint32_t* MeshStream_pTriangles(void* pStream)
{
    return static_cast<MeshStream*>(pStream)->anOutTris.data();
}

/// Indices at MeshStream_pTriangles (three per triangle).
PICOGK_API int32_t MeshStream_nTriangleIndices(void* pStream)
{
    return int32_t(static_cast<MeshStream*>(pStream)->anOutTris.size());
}

/// Triangles meshed so far; the whole mesh's count once nNext returned 0.
PICOGK_API double MeshStream_dTriangleCount(void* pStream)
{
    return static_cast<MeshStream*>(pStream)->dTriangles;
}

/// Indexed mode: vertices emitted so far.
PICOGK_API double MeshStream_dVertexCount(void* pStream)
{
    return static_cast<MeshStream*>(pStream)->dVertices;
}

/// Frees the stream and its batch buffers.
PICOGK_API void MeshStream_Destroy(void* pStream)
{
    delete static_cast<MeshStream*>(pStream);
}
