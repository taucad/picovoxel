// P2 — spike-only CPU classify / GPU ingest ABI.
//
// Include the production tape TU verbatim so this separate spike module keeps
// its validated CPU oracle while exposing the two seams the GPU PoC needs.
#include "../../../src/pico-tape.cpp"

#include <tbb/blocked_range2d.h>
#include <tbb/enumerable_thread_specific.h>
#include <tbb/parallel_for.h>

#include <array>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace
{

struct TapeGpuSlab
{
    int32_t originX;
    int32_t originY;
    int32_t originZ;
    int32_t minX;
    int32_t minY;
    int32_t minZ;
    int32_t maxX;
    int32_t maxY;
    int32_t maxZ;
};

static_assert(sizeof(TapeGpuSlab) == 9 * sizeof(int32_t));

struct TapeGpuInfo
{
    uint32_t slabData;
    uint32_t slabCount;
    uint32_t tapeData;
    uint32_t tapeCount;
    uint32_t constantData;
    uint32_t constantCount;
    uint32_t outputCount;
    uint32_t interiorCount;
    float    voxelSize;
    float    background;
};

static_assert(sizeof(TapeGpuInfo) == 40);

struct TapeGpuPlan
{
    TapeGpuPlan(PicoGK::Voxels::Ptr roTarget,
                PicoGK::VoxelSize   oVoxelSize,
                float               fBackground)
        : target(std::move(roTarget)),
          voxelSize(oVoxelSize),
          background(fBackground)
    {
    }

    PicoGK::Voxels::Ptr          target;
    PicoGK::VoxelSize            voxelSize;
    float                        background;
    std::vector<TapeGpuSlab>     ambiguous;
    std::vector<TapeGpuSlab>     interior;
    std::vector<uint32_t>        instructions;
    std::vector<double>          constants64;
    std::vector<float>           constants32;
};

TapeGpuPlan& Plan(uintptr_t nHandle)
{
    if (nHandle == 0)
        throw std::invalid_argument("tape gpu plan: null handle");
    return *reinterpret_cast<TapeGpuPlan*>(nHandle);
}

bool SlabLess(const TapeGpuSlab& a, const TapeGpuSlab& b)
{
    return std::tie(a.originX, a.originY, a.originZ) <
           std::tie(b.originX, b.originY, b.originZ);
}

TapeGpuSlab MakeSlab(int32_t nCX, int32_t nCY, int32_t nCZ,
                     int32_t nX0, int32_t nX1,
                     int32_t nY0, int32_t nY1,
                     int32_t nZ0, int32_t nZ1)
{
    return TapeGpuSlab{
        nCX * 8, nCY * 8, nCZ * 8,
        std::max(nX0, nCX * 8), std::max(nY0, nCY * 8), std::max(nZ0, nCZ * 8),
        std::min(nX1, nCX * 8 + 7), std::min(nY1, nCY * 8 + 7), std::min(nZ1, nCZ * 8 + 7),
    };
}

bool IsFullSlab(const TapeGpuSlab& oSlab)
{
    return oSlab.minX == oSlab.originX && oSlab.maxX == oSlab.originX + 7 &&
           oSlab.minY == oSlab.originY && oSlab.maxY == oSlab.originY + 7 &&
           oSlab.minZ == oSlab.originZ && oSlab.maxZ == oSlab.originZ + 7;
}

std::array<int32_t, 3> CoordForOutput(const TapeGpuSlab& oSlab, uint32_t nLocal)
{
    return {
        oSlab.originX + static_cast<int32_t>(nLocal >> 6),
        oSlab.originY + static_cast<int32_t>((nLocal >> 3) & 7),
        oSlab.originZ + static_cast<int32_t>(nLocal & 7),
    };
}

bool Contains(const TapeGpuSlab& oSlab, const std::array<int32_t, 3>& oCoord)
{
    return oCoord[0] >= oSlab.minX && oCoord[0] <= oSlab.maxX &&
           oCoord[1] >= oSlab.minY && oCoord[1] <= oSlab.maxY &&
           oCoord[2] >= oSlab.minZ && oCoord[2] <= oSlab.maxZ;
}

} // namespace

PICOGK_API uintptr_t Voxels_TapeGpuClassify( PKINSTANCE      hLib,
                                             PKVOXELS        hVoxels,
                                             const PKBBox3*  poBBox,
                                             const uint32_t* pnInstructions,
                                             int32_t         nInstructionCount,
                                             const double*   pfConstants,
                                             int32_t         nConstantCount)
{
    if (poBBox == nullptr)
        throw std::invalid_argument("tape gpu classify: null bounding box");
    ValidateTape(pnInstructions, nInstructionCount, nConstantCount);
    if (nConstantCount > 0 && pfConstants == nullptr)
        throw std::invalid_argument("tape gpu classify: null constants");

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hVoxels);
    if (!roVoxels->bIsEmpty())
        throw std::invalid_argument("tape gpu classify: target grid must be empty");

    auto roPlan = std::make_unique<TapeGpuPlan>(
        roVoxels,
        roVoxels->oVoxelSize(),
        roVoxels->fBackgroundMM());
    roPlan->instructions.assign(
        pnInstructions,
        pnInstructions + 2 * static_cast<size_t>(nInstructionCount));
    if (nConstantCount > 0)
        roPlan->constants64.assign(pfConstants, pfConstants + nConstantCount);
    roPlan->constants32.reserve(roPlan->constants64.size());
    for (double fValue : roPlan->constants64)
        roPlan->constants32.push_back(static_cast<float>(fValue));

    const int32_t nNarrowBand =
        static_cast<int32_t>(std::lround(roPlan->background / static_cast<float>(roPlan->voxelSize)));
    const PicoGK::Coord xyzMin = roPlan->voxelSize.xyzToVoxels(poBBox->vecMin);
    const PicoGK::Coord xyzMax = roPlan->voxelSize.xyzToVoxels(poBBox->vecMax);
    const int32_t nX0 = xyzMin.X - nNarrowBand, nX1 = xyzMax.X + nNarrowBand;
    const int32_t nY0 = xyzMin.Y - nNarrowBand, nY1 = xyzMax.Y + nNarrowBand;
    const int32_t nZ0 = xyzMin.Z - nNarrowBand, nZ1 = xyzMax.Z + nNarrowBand;
    const int32_t nCX0 = nX0 >> 3, nCX1 = nX1 >> 3;
    const int32_t nCY0 = nY0 >> 3, nCY1 = nY1 >> 3;
    const int32_t nCZ0 = nZ0 >> 3, nCZ1 = nZ1 >> 3;
    const double fBackground = static_cast<double>(roPlan->background);

    tbb::enumerable_thread_specific<std::vector<TapeGpuSlab>> oAmbiguous;
    tbb::enumerable_thread_specific<std::vector<TapeGpuSlab>> oInterior;
    tbb::parallel_for(
        tbb::blocked_range2d<int32_t>(nCX0, nCX1 + 1, nCY0, nCY1 + 1),
        [&](const tbb::blocked_range2d<int32_t>& oRange)
        {
            std::vector<Interval> vecIntervals(static_cast<size_t>(nInstructionCount));
            std::vector<uint8_t> vecChoices(static_cast<size_t>(nInstructionCount));
            std::vector<TapeGpuSlab>& vecAmbiguous = oAmbiguous.local();
            std::vector<TapeGpuSlab>& vecInterior = oInterior.local();

            for (int32_t nCX = oRange.rows().begin(); nCX != oRange.rows().end(); nCX++)
            for (int32_t nCY = oRange.cols().begin(); nCY != oRange.cols().end(); nCY++)
            for (int32_t nCZ = nCZ0; nCZ <= nCZ1; nCZ++)
            {
                const TapeGpuSlab oSlab =
                    MakeSlab(nCX, nCY, nCZ, nX0, nX1, nY0, nY1, nZ0, nZ1);
                const Interval oX = ivMake(
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.minX)),
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.maxX)));
                const Interval oY = ivMake(
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.minY)),
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.maxY)));
                const Interval oZ = ivMake(
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.minZ)),
                    static_cast<double>(roPlan->voxelSize.fToMM(oSlab.maxZ)));
                const Interval oResult = oEvalTapeInterval(
                    pnInstructions,
                    nInstructionCount,
                    pfConstants,
                    oX,
                    oY,
                    oZ,
                    vecIntervals.data(),
                    vecChoices.data());
                if (!oResult.bNaN && oResult.fLo >= fBackground)
                    continue;
                if (!oResult.bNaN && oResult.fHi <= -fBackground)
                    vecInterior.push_back(oSlab);
                else
                    vecAmbiguous.push_back(oSlab);
            }
        });

    for (std::vector<TapeGpuSlab>& vec : oAmbiguous)
        roPlan->ambiguous.insert(roPlan->ambiguous.end(), vec.begin(), vec.end());
    for (std::vector<TapeGpuSlab>& vec : oInterior)
        roPlan->interior.insert(roPlan->interior.end(), vec.begin(), vec.end());
    std::sort(roPlan->ambiguous.begin(), roPlan->ambiguous.end(), SlabLess);
    std::sort(roPlan->interior.begin(), roPlan->interior.end(), SlabLess);
    return reinterpret_cast<uintptr_t>(roPlan.release());
}

PICOGK_API void Voxels_TapeGpuGetInfo(uintptr_t nPlan, TapeGpuInfo* poInfo)
{
    if (poInfo == nullptr)
        throw std::invalid_argument("tape gpu info: null output pointer");
    TapeGpuPlan& oPlan = Plan(nPlan);
    const uint64_t nOutputCount = 512ull * oPlan.ambiguous.size();
    if (nOutputCount > std::numeric_limits<uint32_t>::max())
        throw std::overflow_error("tape gpu info: output exceeds u32");
    *poInfo = TapeGpuInfo{
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(oPlan.ambiguous.data())),
        static_cast<uint32_t>(oPlan.ambiguous.size()),
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(oPlan.instructions.data())),
        static_cast<uint32_t>(oPlan.instructions.size() / 2),
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(oPlan.constants32.data())),
        static_cast<uint32_t>(oPlan.constants32.size()),
        static_cast<uint32_t>(nOutputCount),
        static_cast<uint32_t>(oPlan.interior.size()),
        static_cast<float>(oPlan.voxelSize),
        oPlan.background,
    };
}

PICOGK_API void Voxels_TapeGpuEvalCpuSamples( uintptr_t       nPlan,
                                              const uint32_t* pnIndices,
                                              uint32_t        nCount,
                                              float*          pfValues)
{
    if (pnIndices == nullptr || pfValues == nullptr)
        throw std::invalid_argument("tape gpu cpu samples: null input or output");
    TapeGpuPlan& oPlan = Plan(nPlan);
    const uint32_t nTapeCount = static_cast<uint32_t>(oPlan.instructions.size() / 2);
    std::vector<double> vecRegisters(nTapeCount);
    const uint64_t nOutputCount = 512ull * oPlan.ambiguous.size();

    for (uint32_t i = 0; i < nCount; i++)
    {
        const uint32_t nOutput = pnIndices[i];
        if (nOutput >= nOutputCount)
            throw std::out_of_range("tape gpu cpu samples: output index out of range");
        const TapeGpuSlab& oSlab = oPlan.ambiguous[nOutput >> 9];
        const auto oCoord = CoordForOutput(oSlab, nOutput & 511);
        if (!Contains(oSlab, oCoord))
        {
            pfValues[i] = oPlan.background;
            continue;
        }
        const double fX = static_cast<double>(oPlan.voxelSize.fToMM(oCoord[0]));
        const double fY = static_cast<double>(oPlan.voxelSize.fToMM(oCoord[1]));
        const double fZ = static_cast<double>(oPlan.voxelSize.fToMM(oCoord[2]));
        for (uint32_t nInstruction = 0; nInstruction < nTapeCount; nInstruction++)
        {
            vecRegisters[nInstruction] = dEvalOne(
                oPlan.instructions.data(),
                static_cast<int32_t>(nInstruction),
                oPlan.constants64.data(),
                fX,
                fY,
                fZ,
                vecRegisters.data());
        }
        pfValues[i] = static_cast<float>(vecRegisters[nTapeCount - 1]);
    }
}

PICOGK_API uint32_t Voxels_TapeGpuIngest( uintptr_t    nPlan,
                                          const float* pfValues,
                                          uint32_t     nValueCount)
{
    TapeGpuPlan& oPlan = Plan(nPlan);
    const uint64_t nExpected = 512ull * oPlan.ambiguous.size();
    if (pfValues == nullptr || nValueCount != nExpected)
        throw std::invalid_argument("tape gpu ingest: value count mismatch");

    openvdb::FloatGrid::Ptr roGrid = oPlan.target->roVdbGrid();
    openvdb::FloatGrid::Accessor oAccess = roGrid->getAccessor();
    uint32_t nWritten = 0;

    for (size_t nSlab = 0; nSlab < oPlan.ambiguous.size(); nSlab++)
    {
        const TapeGpuSlab& oSlab = oPlan.ambiguous[nSlab];
        for (uint32_t nLocal = 0; nLocal < 512; nLocal++)
        {
            const auto oCoord = CoordForOutput(oSlab, nLocal);
            if (!Contains(oSlab, oCoord))
                continue;
            const float fValue =
                std::min(pfValues[512 * nSlab + nLocal], oPlan.background);
            const openvdb::Coord xyz(oCoord[0], oCoord[1], oCoord[2]);
            oAccess.setValue(
                xyz,
                std::clamp(fValue, -oPlan.background, oPlan.background));
            if (std::abs(fValue) >= oPlan.background)
                oAccess.setValueOff(xyz);
            nWritten++;
        }
    }

    for (const TapeGpuSlab& oSlab : oPlan.interior)
    {
        if (IsFullSlab(oSlab))
        {
            roGrid->tree().addTile(
                1,
                openvdb::Coord(oSlab.originX, oSlab.originY, oSlab.originZ),
                -oPlan.background,
                false);
            nWritten += 512;
            continue;
        }
        for (int32_t x = oSlab.minX; x <= oSlab.maxX; x++)
        for (int32_t y = oSlab.minY; y <= oSlab.maxY; y++)
        for (int32_t z = oSlab.minZ; z <= oSlab.maxZ; z++)
        {
            oAccess.setValueOff(openvdb::Coord(x, y, z), -oPlan.background);
            nWritten++;
        }
    }
    return nWritten;
}

PICOGK_API void Voxels_TapeGpuDispose(uintptr_t nPlan)
{
    delete reinterpret_cast<TapeGpuPlan*>(nPlan);
}
