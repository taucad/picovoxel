// P1 — spike-only OpenVDB ↔ NanoVDB transport ABI.
//
// This translation unit links only into spikes/webgpu/picovoxel-dist. It uses
// PicoGKRuntime's public headers and never patches the vendored runtime or the
// byte-locked L0 modules.

// Include order is load-bearing; match PicoGKLibrary.cpp and pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <nanovdb/GridHandle.h>
#include <nanovdb/tools/CreateNanoGrid.h>
#include <nanovdb/tools/NanoToOpenVDB.h>

#include <openvdb/tools/Interpolation.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>

namespace
{

using NanoHandle = nanovdb::GridHandle<nanovdb::HostBuffer>;

struct NanoSnapshot
{
    PicoGK::Voxels::Ptr source;
    NanoHandle          handle;
};

NanoSnapshot& Snapshot(uintptr_t nHandle)
{
    if (nHandle == 0)
        throw std::invalid_argument("nano snapshot: null handle");
    return *reinterpret_cast<NanoSnapshot*>(nHandle);
}

nanovdb::FloatGrid& NanoGrid(NanoSnapshot& oSnapshot)
{
    nanovdb::FloatGrid* poGrid = oSnapshot.handle.grid<float>();
    if (poGrid == nullptr)
        throw std::runtime_error("nano snapshot: expected a float grid");
    return *poGrid;
}

uint32_t CheckedU32(uint64_t nValue, const char* pszWhat)
{
    if (nValue > std::numeric_limits<uint32_t>::max())
        throw std::overflow_error(pszWhat);
    return static_cast<uint32_t>(nValue);
}

} // namespace

PICOGK_API uintptr_t Voxels_NanoCreate( PKINSTANCE hLib,
                                        PKVOXELS   hVoxels,
                                        uint32_t*  pnData,
                                        uint32_t*  pnByteSize,
                                        uint32_t*  pnLeafCount,
                                        uint32_t*  pnActiveCount,
                                        uint32_t*  pnLeafOffset,
                                        uint32_t*  pnLeafStride)
{
    if (pnData == nullptr || pnByteSize == nullptr || pnLeafCount == nullptr ||
        pnActiveCount == nullptr || pnLeafOffset == nullptr || pnLeafStride == nullptr)
        throw std::invalid_argument("nano create: null output pointer");

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hVoxels);
    NanoHandle oHandle = nanovdb::tools::createNanoGrid(
        *roVoxels->roVdbGrid(),
        nanovdb::tools::StatsMode::Disable,
        nanovdb::CheckMode::Disable);
    auto roSnapshot = std::make_unique<NanoSnapshot>(
        NanoSnapshot{roVoxels, std::move(oHandle)});
    nanovdb::FloatGrid& oGrid = NanoGrid(*roSnapshot);
    const nanovdb::FloatTree::LeafNodeType* poLeaf = oGrid.tree().getFirstLeaf();
    const uintptr_t nData = reinterpret_cast<uintptr_t>(roSnapshot->handle.data());
    const uintptr_t nLeaf = reinterpret_cast<uintptr_t>(poLeaf);

    *pnData        = CheckedU32(nData, "nano create: data pointer exceeds wasm32");
    *pnByteSize    = CheckedU32(roSnapshot->handle.bufferSize(), "nano create: buffer exceeds wasm32");
    *pnLeafCount   = oGrid.tree().nodeCount(0);
    *pnActiveCount = CheckedU32(oGrid.activeVoxelCount(), "nano create: active count exceeds u32");
    *pnLeafOffset  = poLeaf == nullptr ? 0 : CheckedU32(nLeaf - nData, "nano create: leaf offset exceeds u32");
    *pnLeafStride  = CheckedU32(
        nanovdb::FloatTree::LeafNodeType::DataType::memUsage(),
        "nano create: leaf stride exceeds u32");
    return reinterpret_cast<uintptr_t>(roSnapshot.release());
}

PICOGK_API uint32_t Voxels_NanoApplyValues(uintptr_t nSnapshot)
{
    NanoSnapshot& oSnapshot = Snapshot(nSnapshot);
    nanovdb::FloatGrid& oNano = NanoGrid(oSnapshot);
    const uint32_t nLeafCount = oNano.tree().nodeCount(0);
    const nanovdb::FloatTree::LeafNodeType* poLeaf = oNano.tree().getFirstLeaf();
    openvdb::FloatGrid::Accessor oAccess = oSnapshot.source->roVdbGrid()->getAccessor();
    uint32_t nWritten = 0;

    for (uint32_t nLeaf = 0; nLeaf < nLeafCount; nLeaf++)
    {
        const auto& oLeaf = poLeaf[nLeaf];
        for (uint32_t nVoxel = 0; nVoxel < 512; nVoxel++)
        {
            if (!oLeaf.isActive(nVoxel))
                continue;
            const nanovdb::Coord oNanoCoord = oLeaf.offsetToGlobalCoord(nVoxel);
            oAccess.setValueOnly(
                openvdb::Coord(oNanoCoord[0], oNanoCoord[1], oNanoCoord[2]),
                oLeaf.getValue(nVoxel));
            nWritten++;
        }
    }
    return nWritten;
}

PICOGK_API uint32_t Voxels_NanoRebuildValues(uintptr_t nSnapshot)
{
    NanoSnapshot& oSnapshot = Snapshot(nSnapshot);
    openvdb::GridBase::Ptr roBase = nanovdb::tools::nanoToOpenVDB(oSnapshot.handle);
    openvdb::FloatGrid::Ptr roGrid = openvdb::gridPtrCast<openvdb::FloatGrid>(roBase);
    if (roGrid == nullptr)
        throw std::runtime_error("nano rebuild: expected a float grid");
    oSnapshot.source->roVdbGrid()->setTree(roGrid->treePtr());
    return CheckedU32(roGrid->activeVoxelCount(), "nano rebuild: active count exceeds u32");
}

PICOGK_API uint32_t Voxels_NanoTransformActive( uintptr_t nSnapshot,
                                                int32_t   nOperation,
                                                float     fOperand)
{
    NanoSnapshot& oSnapshot = Snapshot(nSnapshot);
    nanovdb::FloatGrid& oNano = NanoGrid(oSnapshot);
    const uint32_t nLeafCount = oNano.tree().nodeCount(0);
    nanovdb::FloatTree::LeafNodeType* poLeaf = oNano.tree().getFirstLeaf();
    uint32_t nWritten = 0;

    if (nOperation < 0 || nOperation > 2)
        throw std::invalid_argument("nano transform: operation must be identity, scale, or offset");

    for (uint32_t nLeaf = 0; nLeaf < nLeafCount; nLeaf++)
    {
        auto& oLeaf = poLeaf[nLeaf];
        for (uint32_t nVoxel = 0; nVoxel < 512; nVoxel++)
        {
            if (!oLeaf.isActive(nVoxel))
                continue;
            const float fValue = oLeaf.getValue(nVoxel);
            const float fResult =
                nOperation == 0 ? fValue :
                nOperation == 1 ? fValue * fOperand :
                                  fValue + fOperand;
            oLeaf.setValueOnly(nVoxel, fResult);
            nWritten++;
        }
    }
    return nWritten;
}

PICOGK_API void Voxels_NanoBounds(uintptr_t nSnapshot, int32_t* pnBounds)
{
    if (pnBounds == nullptr)
        throw std::invalid_argument("nano bounds: null output pointer");
    const openvdb::CoordBBox oBBox =
        Snapshot(nSnapshot).source->roVdbGrid()->evalActiveVoxelBoundingBox();
    pnBounds[0] = oBBox.min().x();
    pnBounds[1] = oBBox.min().y();
    pnBounds[2] = oBBox.min().z();
    pnBounds[3] = oBBox.max().x();
    pnBounds[4] = oBBox.max().y();
    pnBounds[5] = oBBox.max().z();
}

PICOGK_API void Voxels_NanoSampleBox( uintptr_t   nSnapshot,
                                      const float* pfCoords,
                                      uint32_t     nCount,
                                      float*       pfValues)
{
    if (pfCoords == nullptr || pfValues == nullptr)
        throw std::invalid_argument("nano sample: null input or output pointer");
    openvdb::FloatGrid::ConstAccessor oAccess =
        Snapshot(nSnapshot).source->roVdbGrid()->getConstAccessor();
    for (uint32_t i = 0; i < nCount; i++)
    {
        const openvdb::Vec3R oCoord(
            static_cast<double>(pfCoords[3 * i]),
            static_cast<double>(pfCoords[3 * i + 1]),
            static_cast<double>(pfCoords[3 * i + 2]));
        pfValues[i] = openvdb::tools::BoxSampler::sample(oAccess, oCoord);
    }
}

PICOGK_API void Voxels_NanoPopulateSynthetic( PKINSTANCE hLib,
                                               PKVOXELS   hVoxels,
                                               uint32_t   nLeafCount)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hVoxels);
    openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();
    if (!roGrid->empty())
        throw std::invalid_argument("nano synthetic: target grid must be empty");

    openvdb::FloatGrid::Accessor oAccess = roGrid->getAccessor();
    constexpr uint32_t nLeafsPerAxis = 128;
    for (uint32_t i = 0; i < nLeafCount; i++)
    {
        const uint32_t nX = i % nLeafsPerAxis;
        const uint32_t nY = (i / nLeafsPerAxis) % nLeafsPerAxis;
        const uint32_t nZ = i / (nLeafsPerAxis * nLeafsPerAxis);
        oAccess.setValueOn(
            openvdb::Coord(
                static_cast<int32_t>(8 * nX),
                static_cast<int32_t>(8 * nY),
                static_cast<int32_t>(8 * nZ)),
            0.25f);
    }
}

PICOGK_API void Voxels_NanoDispose(uintptr_t nSnapshot)
{
    delete reinterpret_cast<NanoSnapshot*>(nSnapshot);
}
