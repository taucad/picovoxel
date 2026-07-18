// TP1 — tape-compiled implicit rendering with a parallel fill.
//
// Voxels_RenderImplicit is a serial triple loop over the bounding box
// (PicoGKVdbVoxels.h:370-381) whose per-sample callback crosses the wasm↔JS
// boundary. Measured at 0.1mm (13.8M samples) the callback math is ~14% of the
// fill; the other ~86% is the grid-write machinery around it — all of it
// parallelizable, and none of it reachable from worker threads while the SDF
// is a JS function (addFunction entries exist only in the registering thread's
// table; emscripten#11317). So the SDF comes in serialized instead: a flat
// SSA tape evaluated by the loop below, in-module, on every thread.
//
// Tape format (built by src/tape.ts — the op list and encoding are mirrored
// there and locked by test/tape.test.ts):
//   instruction i = two u32 words: [op, a | (b << 16)]
//   result register of instruction i is i itself (SSA: dst is implicit), so a
//   valid tape has a < i and b < i for operand-taking ops, and the final
//   result is register nInstructionCount-1. CONST reads pfConstants[a].
// Evaluation is double precision with a single float truncation at the end —
// the same shape as the JS path (f64 Math.* → f32 return), so the two paths
// agree to the libm ulp rather than compounding float error per op.
//
// Parallel fill: the iterated index box is partitioned into 8×8 leaf-aligned
// (x,y) columns — FloatTree leaves span 8³, so no leaf straddles two tasks.
// Each thread writes its own local grid; afterwards the disjoint leaf sets are
// merged into the target tree by node-stealing (O(nodes moved), not O(voxels)).
// Values are pure functions of the coordinate, every voxel is written exactly
// once, and OpenVDB node storage is coordinate-indexed, so the result is
// bit-identical regardless of thread count or schedule — the single/multi
// differential test relies on this.
//
// The target grid must be EMPTY (the fresh grid createVoxels just made): that
// is what makes upstream's min(sdf, existing) collapse to min(sdf, background)
// and the node-steal merge sound. Kept as a hard precondition rather than a
// silent wrong answer. Like the bulk TU, this lives in picogk-js so the
// vendored PicoGKRuntime tree stays pristine (R4/B21).

// Include order is load-bearing and must match PicoGKLibrary.cpp — see
// src/picogk-bulk.cpp for the PKVector3 aliasing trap. Do not let a formatter
// sort these.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <tbb/blocked_range2d.h>
#include <tbb/enumerable_thread_specific.h>
#include <tbb/parallel_for.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace
{

enum : uint32_t
{
    TAPE_CONST = 0,  // reg[i] = pfConstants[a]
    TAPE_X     = 1,  // reg[i] = sample x (mm)
    TAPE_Y     = 2,
    TAPE_Z     = 3,
    TAPE_ADD   = 4,
    TAPE_SUB   = 5,
    TAPE_MUL   = 6,
    TAPE_DIV   = 7,
    TAPE_NEG   = 8,
    TAPE_ABS   = 9,
    TAPE_SQRT  = 10,
    TAPE_SIN   = 11,
    TAPE_COS   = 12,
    TAPE_FLOOR = 13,
    TAPE_MOD   = 14, // GLSL mod: a - b*floor(a/b)
    TAPE_MIN   = 15,
    TAPE_MAX   = 16,
    TAPE_POW   = 17,
    TAPE_EXP   = 18,
    TAPE_LOG   = 19,
    TAPE_LAST_ = TAPE_LOG,
};

inline bool bHasOperandA(uint32_t nOp) { return nOp >= TAPE_ADD; }
inline bool bHasOperandB(uint32_t nOp)
{
    switch (nOp)
    {
        case TAPE_ADD: case TAPE_SUB: case TAPE_MUL: case TAPE_DIV:
        case TAPE_MOD: case TAPE_MIN: case TAPE_MAX: case TAPE_POW:
            return true;
        default:
            return false;
    }
}

/// Rejects malformed tapes once, before the parallel region — a bad operand
/// index would otherwise read uninitialised registers on twelve threads.
void ValidateTape(  const uint32_t* pnInstructions,
                    int32_t         nInstructionCount,
                    int32_t         nConstantCount)
{
    if (pnInstructions == nullptr || nInstructionCount <= 0)
        throw std::invalid_argument("tape: empty instruction stream");

    for (int32_t i = 0; i < nInstructionCount; i++)
    {
        const uint32_t nOp = pnInstructions[2 * i];
        const uint32_t nA  = pnInstructions[2 * i + 1] & 0xFFFFu;
        const uint32_t nB  = pnInstructions[2 * i + 1] >> 16;

        if (nOp > TAPE_LAST_)
            throw std::invalid_argument("tape: unknown opcode");
        if (nOp == TAPE_CONST && (int32_t) nA >= nConstantCount)
            throw std::invalid_argument("tape: constant index out of range");
        if (bHasOperandA(nOp) && (int32_t) nA >= i)
            throw std::invalid_argument("tape: operand a is not an earlier instruction");
        if (bHasOperandB(nOp) && (int32_t) nB >= i)
            throw std::invalid_argument("tape: operand b is not an earlier instruction");
    }
}

double dEvalTape(   const uint32_t* pnInstructions,
                    int32_t         nInstructionCount,
                    const double*   pfConstants,
                    double          fX,
                    double          fY,
                    double          fZ,
                    double*         pfReg)
{
    for (int32_t i = 0; i < nInstructionCount; i++)
    {
        const uint32_t nOp = pnInstructions[2 * i];
        const uint32_t nAB = pnInstructions[2 * i + 1];
        const uint32_t nA  = nAB & 0xFFFFu;
        const uint32_t nB  = nAB >> 16;

        double fResult;
        switch (nOp)
        {
            case TAPE_CONST: fResult = pfConstants[nA];                                    break;
            case TAPE_X:     fResult = fX;                                                 break;
            case TAPE_Y:     fResult = fY;                                                 break;
            case TAPE_Z:     fResult = fZ;                                                 break;
            case TAPE_ADD:   fResult = pfReg[nA] + pfReg[nB];                              break;
            case TAPE_SUB:   fResult = pfReg[nA] - pfReg[nB];                              break;
            case TAPE_MUL:   fResult = pfReg[nA] * pfReg[nB];                              break;
            case TAPE_DIV:   fResult = pfReg[nA] / pfReg[nB];                              break;
            case TAPE_NEG:   fResult = -pfReg[nA];                                         break;
            case TAPE_ABS:   fResult = std::fabs(pfReg[nA]);                               break;
            case TAPE_SQRT:  fResult = std::sqrt(pfReg[nA]);                               break;
            case TAPE_SIN:   fResult = std::sin(pfReg[nA]);                                break;
            case TAPE_COS:   fResult = std::cos(pfReg[nA]);                                break;
            case TAPE_FLOOR: fResult = std::floor(pfReg[nA]);                              break;
            case TAPE_MOD:   fResult = pfReg[nA] - pfReg[nB] * std::floor(pfReg[nA] / pfReg[nB]); break;
            case TAPE_MIN:   fResult = std::min(pfReg[nA], pfReg[nB]);                     break;
            case TAPE_MAX:   fResult = std::max(pfReg[nA], pfReg[nB]);                     break;
            case TAPE_POW:   fResult = std::pow(pfReg[nA], pfReg[nB]);                     break;
            case TAPE_EXP:   fResult = std::exp(pfReg[nA]);                                break;
            default:         fResult = std::log(pfReg[nA]);                                break; // TAPE_LOG — ValidateTape rejects everything else
        }
        pfReg[i] = fResult;
    }
    return pfReg[nInstructionCount - 1];
}

} // namespace

/// Renders a tape-compiled implicit into a freshly created (empty) voxel field
/// over the given bounds — the parallel counterpart of Voxels_RenderImplicit.
PICOGK_API void Voxels_RenderImplicitTape(  PKINSTANCE      hLib,
                                            PKVOXELS        hThis,
                                            const PKBBox3*  poBBox,
                                            const uint32_t* pnInstructions,
                                            int32_t         nInstructionCount,
                                            const double*   pfConstants,
                                            int32_t         nConstantCount)
{
    if (poBBox == nullptr)
        throw std::invalid_argument("tape: null bounding box");

    ValidateTape(pnInstructions, nInstructionCount, nConstantCount);

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();
    if (!roGrid->tree().empty())
        throw std::invalid_argument("tape: target voxel field must be empty");

    const float             fBackground = roVoxels->fBackgroundMM();
    const PicoGK::VoxelSize oVoxelSize  = roVoxels->oVoxelSize();
    // Not public on Voxels, but recoverable: the constructor sets the grid
    // background to fToMM(nNarrowBand) (PicoGKVdbVoxels.h:72).
    const int32_t nNarrowBand = (int32_t) std::lround(fBackground / (float) oVoxelSize);

    const PicoGK::Coord xyzMin = oVoxelSize.xyzToVoxels(poBBox->vecMin);
    const PicoGK::Coord xyzMax = oVoxelSize.xyzToVoxels(poBBox->vecMax);
    const int32_t nX0 = xyzMin.X - nNarrowBand, nX1 = xyzMax.X + nNarrowBand;
    const int32_t nY0 = xyzMin.Y - nNarrowBand, nY1 = xyzMax.Y + nNarrowBand;
    const int32_t nZ0 = xyzMin.Z - nNarrowBand, nZ1 = xyzMax.Z + nNarrowBand;

    // Leaf-aligned (x,y) columns; >>3 rounds toward -inf for negatives, which
    // is exactly leaf-origin bucketing.
    const int32_t nCX0 = nX0 >> 3, nCX1 = nX1 >> 3;
    const int32_t nCY0 = nY0 >> 3, nCY1 = nY1 >> 3;

    tbb::enumerable_thread_specific<openvdb::FloatGrid::Ptr> oLocalGrids(
        [fBackground] { return openvdb::FloatGrid::create(fBackground); });

    tbb::parallel_for(
        tbb::blocked_range2d<int32_t>(nCX0, nCX1 + 1, nCY0, nCY1 + 1),
        [&](const tbb::blocked_range2d<int32_t>& oRange)
        {
            openvdb::FloatGrid::Accessor oAccess = oLocalGrids.local()->getAccessor();
            std::vector<double> vecReg((size_t) nInstructionCount);

            for (int32_t nCX = oRange.rows().begin(); nCX != oRange.rows().end(); nCX++)
            for (int32_t nCY = oRange.cols().begin(); nCY != oRange.cols().end(); nCY++)
            {
                const int32_t nColX0 = std::max(nX0, nCX * 8), nColX1 = std::min(nX1, nCX * 8 + 7);
                const int32_t nColY0 = std::max(nY0, nCY * 8), nColY1 = std::min(nY1, nCY * 8 + 7);

                for (int32_t x = nColX0; x <= nColX1; x++)
                for (int32_t y = nColY0; y <= nColY1; y++)
                for (int32_t z = nZ0;    z <= nZ1;    z++)
                {
                    // Same float sample-position math as the serial path.
                    const PicoGK::Vector3 vecSample = oVoxelSize.vecToMM(PicoGK::Coord(x, y, z));
                    const float fSdf = (float) dEvalTape(   pnInstructions,
                                                            nInstructionCount,
                                                            pfConstants,
                                                            (double) vecSample.X,
                                                            (double) vecSample.Y,
                                                            (double) vecSample.Z,
                                                            vecReg.data());

                    // Upstream per-voxel semantics on an empty grid:
                    // min(sdf, getValue)=min(sdf, background), then SetSdValue
                    // (PicoGKVdbVoxels.h:377-380, 909-920). RebuildGrid() is a
                    // no-op upstream and is deliberately not replicated.
                    const float fValue = std::min(fSdf, fBackground);
                    const openvdb::Coord xyz(x, y, z);
                    oAccess.setValue(xyz, std::clamp(fValue, -fBackground, fBackground));
                    if (std::abs(fValue) >= fBackground)
                        oAccess.setValueOff(xyz);
                }
            }
        });

    for (openvdb::FloatGrid::Ptr& roLocal : oLocalGrids)
        roGrid->tree().merge(roLocal->tree(), openvdb::MERGE_ACTIVE_STATES);
}
