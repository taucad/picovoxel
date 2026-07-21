// TP1 — tape-compiled implicit rendering with a parallel fill.
// TP6 — MPR-style interval pruning over that fill.
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
// Interval pruning (Keeter 2020, "Massively Parallel Rendering of Complex
// Closed-Form Implicit Surfaces"): before the dense per-voxel loop, the tape
// is evaluated in conservative interval arithmetic over each column and each
// 8³ leaf-aligned z-slab of it. A block whose interval sits entirely at or
// above +background produces only inactive background voxels — upstream's
// SetSdValue writes clamp(+…)=+background then setValueOff, which reads
// identically to untouched background — so it is skipped outright. A block
// entirely at or below -background is solid interior: a fully-covered leaf
// becomes an inactive -background tile at level 1 (the canonical form
// signedFloodFill produces, sign-correct for the csg ops), a bbox-clipped
// block is written directly without evaluating the tape. Ambiguous blocks
// fall back to the dense loop — but with an MPR-shortened tape: any min/max
// whose branch an interval sweep decided for the whole block is dropped and
// its uses remapped to the surviving operand. Decisions use strict
// inequalities on outward-rounded bounds, so every surviving evaluation is
// bit-identical to the full tape (ties, the sign of zero, and NaN propagation
// included — a possibly-NaN operand blocks both the decision and the
// inside/outside classification, because upstream stores NaN samples as
// ACTIVE voxels and pruning must not hide them).
//
// Voxels_RenderImplicitTape targets an EMPTY grid (the fresh grid createVoxels
// just made): that is what makes upstream's min(sdf, existing) collapse to
// min(sdf, background) and the node-steal merge sound — kept as a hard
// precondition rather than a silent wrong answer. The R9 entries lift the
// limitation for the compose paths: Voxels_RenderImplicitTapeCompose composes
// min(sdf, existing) into a live grid (parallel eval, serial apply), and
// Voxels_IntersectImplicitTape mirrors upstream IntersectImplicit's
// fresh-render + csgIntersection dance. Like the bulk TU, this lives in
// picovoxel so the vendored PicoGKRuntime tree stays pristine (R4/B21).

// Include order is load-bearing and must match PicoGKLibrary.cpp — see
// src/pico-bulk.cpp for the PKVector3 aliasing trap. Do not let a formatter
// sort these.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/Composite.h>

#include <tbb/blocked_range2d.h>
#include <tbb/enumerable_thread_specific.h>
#include <tbb/parallel_for.h>

#include <wasm_simd128.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
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

inline double dEvalOne( const uint32_t* pnInstructions,
                        int32_t         i,
                        const double*   pfConstants,
                        double          fX,
                        double          fY,
                        double          fZ,
                        const double*   pfReg)
{
    const uint32_t nOp = pnInstructions[2 * i];
    const uint32_t nAB = pnInstructions[2 * i + 1];
    const uint32_t nA  = nAB & 0xFFFFu;
    const uint32_t nB  = nAB >> 16;

    switch (nOp)
    {
        case TAPE_CONST: return pfConstants[nA];
        case TAPE_X:     return fX;
        case TAPE_Y:     return fY;
        case TAPE_Z:     return fZ;
        case TAPE_ADD:   return pfReg[nA] + pfReg[nB];
        case TAPE_SUB:   return pfReg[nA] - pfReg[nB];
        case TAPE_MUL:   return pfReg[nA] * pfReg[nB];
        case TAPE_DIV:   return pfReg[nA] / pfReg[nB];
        case TAPE_NEG:   return -pfReg[nA];
        case TAPE_ABS:   return std::fabs(pfReg[nA]);
        case TAPE_SQRT:  return std::sqrt(pfReg[nA]);
        case TAPE_SIN:   return std::sin(pfReg[nA]);
        case TAPE_COS:   return std::cos(pfReg[nA]);
        case TAPE_FLOOR: return std::floor(pfReg[nA]);
        case TAPE_MOD:   return pfReg[nA] - pfReg[nB] * std::floor(pfReg[nA] / pfReg[nB]);
        case TAPE_MIN:   return std::min(pfReg[nA], pfReg[nB]);
        case TAPE_MAX:   return std::max(pfReg[nA], pfReg[nB]);
        case TAPE_POW:   return std::pow(pfReg[nA], pfReg[nB]);
        case TAPE_EXP:   return std::exp(pfReg[nA]);
        default:         return std::log(pfReg[nA]); // TAPE_LOG — ValidateTape rejects everything else
    }
}

/// TP7a — evaluates only the instructions named in pnIdx (an axis-dependency
/// level), writing results into the shared register file. Same scalar ops on
/// the same inputs as the flat sweep, just executed at the loop depth where
/// their inputs last changed — bit-identical by construction.
void EvalTapeIndices(   const uint32_t* pnInstructions,
                        const uint32_t* pnIdx,
                        int32_t         nIdxCount,
                        const double*   pfConstants,
                        double          fX,
                        double          fY,
                        double          fZ,
                        double*         pfReg)
{
    for (int32_t k = 0; k < nIdxCount; k++)
    {
        const int32_t i = (int32_t) pnIdx[k];
        pfReg[i] = dEvalOne(pnInstructions, i, pfConstants, fX, fY, fZ, pfReg);
    }
}

// ---------------------------------------------------------------------------
// TP7b — f64x2 evaluation of the z-varying level over a PAIR of z samples.
//
// Bit-identity boundary: +,-,*,/,sqrt are IEEE correctly rounded and floor is
// exact, so their f64x2 forms match the scalar ops lane-for-lane. min/max are
// rebuilt as compare+bitselect to replicate std::min/max exactly — first
// operand on unordered comparisons, and min(+0,-0)=+0 / max(-0,+0)=-0 (the
// comparison is false on equal-valued zeros, so lane selection falls through
// to operand a, same as the scalar template). Transcendentals stay scalar
// musl calls per lane — a vectorized polynomial libm would break the
// tape ≡ JS pin (musl-wasm ≡ V8 fdlibm).
//
// Only instructions whose axis mask contains Z can appear in the level-3
// list (CONST/X/Y sit at levels 0-2 by construction), so leaves reduce to
// TAPE_Z. Operands from lower levels are lane-splat from the scalar register
// file on the fly — the axis mask doubles as the "which file" discriminator.
// ---------------------------------------------------------------------------

void EvalTapeIndicesV(  const uint32_t* pnInstructions,
                        const uint32_t* pnIdx,
                        int32_t         nIdxCount,
                        const uint8_t*  pnAxisMask,
                        const double*   pfRegScalar,
                        v128_t          vZ,
                        v128_t*         pvReg)
{
    const auto LANE = [&](uint32_t r) -> v128_t
    {
        return (pnAxisMask[r] & 4) ? pvReg[r] : wasm_f64x2_splat(pfRegScalar[r]);
    };
    const auto LIBM1 = [](v128_t v, double (*pfn)(double)) -> v128_t
    {
        return wasm_f64x2_make( pfn(wasm_f64x2_extract_lane(v, 0)),
                                pfn(wasm_f64x2_extract_lane(v, 1)));
    };

    for (int32_t k = 0; k < nIdxCount; k++)
    {
        const int32_t  i   = (int32_t) pnIdx[k];
        const uint32_t nOp = pnInstructions[2 * i];
        const uint32_t nAB = pnInstructions[2 * i + 1];
        const uint32_t nA  = nAB & 0xFFFFu;
        const uint32_t nB  = nAB >> 16;

        v128_t vResult;
        switch (nOp)
        {
            case TAPE_Z:     vResult = vZ;                                          break;
            case TAPE_ADD:   vResult = wasm_f64x2_add(LANE(nA), LANE(nB));          break;
            case TAPE_SUB:   vResult = wasm_f64x2_sub(LANE(nA), LANE(nB));          break;
            case TAPE_MUL:   vResult = wasm_f64x2_mul(LANE(nA), LANE(nB));          break;
            case TAPE_DIV:   vResult = wasm_f64x2_div(LANE(nA), LANE(nB));          break;
            case TAPE_NEG:   vResult = wasm_f64x2_neg(LANE(nA));                    break;
            case TAPE_ABS:   vResult = wasm_f64x2_abs(LANE(nA));                    break;
            case TAPE_SQRT:  vResult = wasm_f64x2_sqrt(LANE(nA));                   break;
            case TAPE_SIN:   vResult = LIBM1(LANE(nA), std::sin);                   break;
            case TAPE_COS:   vResult = LIBM1(LANE(nA), std::cos);                   break;
            case TAPE_FLOOR: vResult = wasm_f64x2_floor(LANE(nA));                  break;
            case TAPE_MOD:
            {
                const v128_t vA = LANE(nA), vB = LANE(nB);
                vResult = wasm_f64x2_sub(vA, wasm_f64x2_mul(vB, wasm_f64x2_floor(wasm_f64x2_div(vA, vB))));
                break;
            }
            case TAPE_MIN:
            {
                const v128_t vA = LANE(nA), vB = LANE(nB);
                vResult = wasm_v128_bitselect(vB, vA, wasm_f64x2_lt(vB, vA)); // (b<a)?b:a ≡ std::min
                break;
            }
            case TAPE_MAX:
            {
                const v128_t vA = LANE(nA), vB = LANE(nB);
                vResult = wasm_v128_bitselect(vB, vA, wasm_f64x2_lt(vA, vB)); // (a<b)?b:a ≡ std::max
                break;
            }
            case TAPE_POW:
            {
                const v128_t vA = LANE(nA), vB = LANE(nB);
                vResult = wasm_f64x2_make(  std::pow(wasm_f64x2_extract_lane(vA, 0), wasm_f64x2_extract_lane(vB, 0)),
                                            std::pow(wasm_f64x2_extract_lane(vA, 1), wasm_f64x2_extract_lane(vB, 1)));
                break;
            }
            case TAPE_EXP:   vResult = LIBM1(LANE(nA), std::exp);                   break;
            default:         vResult = LIBM1(LANE(nA), std::log);                   break; // TAPE_LOG
        }
        pvReg[i] = vResult;
    }
}

// ---------------------------------------------------------------------------
// Interval arithmetic (TP6)
//
// Soundness contract: for every sample position in the block, the exact double
// the scalar evaluator would compute for a register lies within [fLo, fHi] of
// that register's interval — unless bNaN is set, in which case the register
// may be NaN at some sample and nothing may be decided from it. Bounds are
// widened outward after every inexact operation: 1 ulp covers the correctly
// rounded +,-,*,/,sqrt; libm sin/cos/exp/log get 4 ulps and pow 8 (musl keeps
// these within ~1 ulp — the extra slack is insurance that costs nothing at
// the ±background thresholds these bounds are compared against). Widening can
// only lose pruning opportunities, never correctness of values: pruned blocks
// are never evaluated, ambiguous blocks are evaluated exactly.
// ---------------------------------------------------------------------------

constexpr double TAPE_PI      = 3.141592653589793238462643383279502884;
constexpr double TAPE_HALF_PI = TAPE_PI / 2.0; // exact: exponent decrement
constexpr double TAPE_TAU     = TAPE_PI * 2.0; // exact: exponent increment
constexpr double TAPE_INF     = std::numeric_limits<double>::infinity();

struct Interval
{
    double fLo;
    double fHi;
    bool   bNaN;
};

constexpr Interval IV_WHOLE = { -TAPE_INF, TAPE_INF, true };

inline double fOutward(double f, int nUlps, bool bUp)
{
    for (int i = 0; i < nUlps; i++)
        f = std::nextafter(f, bUp ? TAPE_INF : -TAPE_INF);
    return f;
}

/// NaN in either bound (or an inverted pair) means an op overflowed into
/// undefined territory (inf-inf, 0*inf, …) — collapse to no-information.
/// Full-line bounds collapse too: add/mul can hit NaN at INTERIOR samples
/// (a=-inf with b=+inf, a=0 with b=inf) without a NaN corner, but whenever
/// that is possible their bound arithmetic yields -inf AND +inf — and if the
/// full line survived with bNaN=false, a later min/max could tighten one
/// bound while silently carrying the NaN, then let a branch decision fire on
/// it. Collapsing costs nothing: full-line bounds can neither classify a
/// block nor decide a branch.
inline Interval ivMake(double fLo, double fHi)
{
    if (std::isnan(fLo) || std::isnan(fHi) || fLo > fHi)
        return IV_WHOLE;
    if (fLo == -TAPE_INF && fHi == TAPE_INF)
        return IV_WHOLE;
    return { fLo, fHi, false };
}

inline Interval ivWiden(double fLo, double fHi, int nUlps)
{
    return ivMake(fOutward(fLo, nUlps, false), fOutward(fHi, nUlps, true));
}

inline Interval ivFromCorners(double f0, double f1, double f2, double f3, int nUlps)
{
    if (std::isnan(f0) || std::isnan(f1) || std::isnan(f2) || std::isnan(f3))
        return IV_WHOLE;
    return ivWiden( std::min(std::min(f0, f1), std::min(f2, f3)),
                    std::max(std::max(f0, f1), std::max(f2, f3)), nUlps);
}

/// True range of sin/cos over [fLo, fHi] plus libm slop. The stationary-point
/// containment test is slackened so double(π) rounding can only ADD extrema
/// (which only widens the result), never miss one.
Interval ivSinCos(const Interval& a, bool bCos)
{
    if (a.bNaN || !std::isfinite(a.fLo) || !std::isfinite(a.fHi))
        return IV_WHOLE; // sin(±inf) = NaN
    if (a.fHi - a.fLo >= TAPE_TAU)
        return { -1.0, 1.0, false };

    const double fA = bCos ? std::cos(a.fLo) : std::sin(a.fLo);
    const double fB = bCos ? std::cos(a.fHi) : std::sin(a.fHi);
    double fMin = std::min(fA, fB);
    double fMax = std::max(fA, fB);

    const double fSlack    = 1e-9 * (1.0 + std::max(std::fabs(a.fLo), std::fabs(a.fHi)));
    const double fMaxPhase = bCos ? 0.0     : TAPE_HALF_PI;  // peaks at fMaxPhase + k·2π
    const double fMinPhase = bCos ? TAPE_PI : -TAPE_HALF_PI; // troughs at fMinPhase + k·2π

    for (int nWhich = 0; nWhich < 2; nWhich++)
    {
        const double fPhase = (nWhich == 0) ? fMaxPhase : fMinPhase;
        const double fK0    = std::floor((a.fLo - fPhase) / TAPE_TAU);
        for (int i = 0; i <= 2; i++)
        {
            const double fT = fPhase + (fK0 + (double) i) * TAPE_TAU;
            if (fT >= a.fLo - fSlack && fT <= a.fHi + fSlack)
            {
                if (nWhich == 0) fMax = 1.0;
                else             fMin = -1.0;
            }
        }
    }

    // Widen for libm endpoint error, then clamp back into [-1, 1] — both the
    // true range and every libm return live there.
    Interval oResult = ivWiden(fMin, fMax, 4);
    oResult.fLo = std::max(oResult.fLo, -1.0);
    oResult.fHi = std::min(oResult.fHi, 1.0);
    return oResult;
}

inline Interval ivAdd(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    return ivWiden(a.fLo + b.fLo, a.fHi + b.fHi, 1);
}

inline Interval ivSub(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    return ivWiden(a.fLo - b.fHi, a.fHi - b.fLo, 1);
}

inline Interval ivMul(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    return ivFromCorners(   a.fLo * b.fLo, a.fLo * b.fHi,
                            a.fHi * b.fLo, a.fHi * b.fHi, 1);
}

inline Interval ivDiv(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    if (b.fLo <= 0.0 && b.fHi >= 0.0) return IV_WHOLE; // 0 in denominator: ±inf, NaN
    return ivFromCorners(   a.fLo / b.fLo, a.fLo / b.fHi,
                            a.fHi / b.fLo, a.fHi / b.fHi, 1);
}

inline Interval ivNeg(const Interval& a)
{
    if (a.bNaN) return IV_WHOLE;
    return { -a.fHi, -a.fLo, false }; // exact
}

inline Interval ivAbs(const Interval& a)
{
    if (a.bNaN) return IV_WHOLE;
    if (a.fLo >= 0.0) return a;                          // exact
    if (a.fHi <= 0.0) return { -a.fHi, -a.fLo, false };  // exact
    return { 0.0, std::max(-a.fLo, a.fHi), false };      // exact
}

inline Interval ivSqrt(const Interval& a)
{
    if (a.bNaN || a.fLo < 0.0) return IV_WHOLE; // sqrt(negative) = NaN for some samples
    return ivWiden(std::sqrt(a.fLo), std::sqrt(a.fHi), 1);
}

inline Interval ivFloor(const Interval& a)
{
    if (a.bNaN) return IV_WHOLE;
    return { std::floor(a.fLo), std::floor(a.fHi), false }; // exact
}

inline Interval ivMin(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    return { std::min(a.fLo, b.fLo), std::min(a.fHi, b.fHi), false }; // exact
}

inline Interval ivMax(const Interval& a, const Interval& b)
{
    if (a.bNaN || b.bNaN) return IV_WHOLE;
    return { std::max(a.fLo, b.fLo), std::max(a.fHi, b.fHi), false }; // exact
}

Interval ivPow(const Interval& a, const Interval& b)
{
    // Non-finite inputs breed inf^0 / 1^inf edge cases — no-information path.
    if (a.bNaN || b.bNaN ||
        !std::isfinite(a.fLo) || !std::isfinite(a.fHi) ||
        !std::isfinite(b.fLo) || !std::isfinite(b.fHi))
        return IV_WHOLE;

    // Degenerate integer exponent — the overwhelmingly common SDF shape
    // (x², r³ …; the constant pool makes the operand a point interval):
    // defined for negative bases too, and piecewise monotone, so the earlier
    // negative-base bailout would otherwise poison every distance-style SDF
    // whose coordinate offsets straddle zero.
    if (b.fLo == b.fHi && b.fLo == std::floor(b.fLo))
    {
        const double k = b.fLo;
        if (k == 0.0)
            return { 1.0, 1.0, false }; // IEC 60559: pow(x, 0) = 1 for every x
        const bool bEven = std::fmod(k, 2.0) == 0.0;
        if (k > 0.0)
        {
            // Even k: monotone increasing in |x|. Odd k: increasing in x.
            const Interval oBase = bEven ? ivAbs(a) : a;
            return ivWiden(std::pow(oBase.fLo, k), std::pow(oBase.fHi, k), 8);
        }
        if (a.fLo <= 0.0 && a.fHi >= 0.0)
            return IV_WHOLE; // pole at 0: pow(±0, negative) = ±inf
        // Negative k away from the pole: monotone decreasing counterparts.
        const Interval oBase = bEven ? ivAbs(a) : a;
        return ivWiden(std::pow(oBase.fHi, k), std::pow(oBase.fLo, k), 8);
    }

    if (a.fLo < 0.0)
        return IV_WHOLE; // NaN for non-integer exponents

    // For x >= 0, pow is monotone in x for fixed y and in y for fixed x, so
    // box extrema sit on corners (pow(0,0)=1 and pow(0,neg)=+inf included,
    // matching the scalar std::pow the dense loop uses).
    return ivFromCorners(   std::pow(a.fLo, b.fLo), std::pow(a.fLo, b.fHi),
                            std::pow(a.fHi, b.fLo), std::pow(a.fHi, b.fHi), 8);
}

inline Interval ivExp(const Interval& a)
{
    if (a.bNaN) return IV_WHOLE;
    return ivWiden(std::exp(a.fLo), std::exp(a.fHi), 4); // monotone
}

inline Interval ivLog(const Interval& a)
{
    if (a.bNaN || a.fLo < 0.0) return IV_WHOLE; // log(negative) = NaN for some samples
    return ivWiden(std::log(a.fLo), std::log(a.fHi), 4); // monotone; log(0) = -inf is a valid bound
}

inline Interval ivMod(const Interval& a, const Interval& b)
{
    // Composed exactly as the scalar path computes it: a - b*floor(a/b).
    // Composition of conservative ops is conservative.
    return ivSub(a, ivMul(b, ivFloor(ivDiv(a, b))));
}

/// Interval-evaluates the tape over a block of sample positions, recording a
/// branch decision per instruction (0 = undecided, 1 = always operand a,
/// 2 = always operand b — meaningful only for MIN/MAX). Decisions use strict
/// inequalities on conservative bounds: a.fHi < b.fLo means a < b pointwise
/// across the block, so std::min/max returns operand a's exact double (bit
/// pattern included) at every sample — ties are left undecided so the sign of
/// zero can never flip, and a possibly-NaN operand blocks the decision because
/// std::min/max propagate NaN asymmetrically.
Interval oEvalTapeInterval( const uint32_t* pnInstructions,
                            int32_t         nInstructionCount,
                            const double*   pfConstants,
                            const Interval& oX,
                            const Interval& oY,
                            const Interval& oZ,
                            Interval*       poReg,
                            uint8_t*        pnChoice)
{
    for (int32_t i = 0; i < nInstructionCount; i++)
    {
        const uint32_t nOp = pnInstructions[2 * i];
        const uint32_t nAB = pnInstructions[2 * i + 1];
        const uint32_t nA  = nAB & 0xFFFFu;
        const uint32_t nB  = nAB >> 16;
        pnChoice[i] = 0;

        Interval oResult;
        switch (nOp)
        {
            case TAPE_CONST: oResult = ivMake(pfConstants[nA], pfConstants[nA]);    break;
            case TAPE_X:     oResult = oX;                                          break;
            case TAPE_Y:     oResult = oY;                                          break;
            case TAPE_Z:     oResult = oZ;                                          break;
            case TAPE_ADD:   oResult = ivAdd(poReg[nA], poReg[nB]);                 break;
            case TAPE_SUB:   oResult = ivSub(poReg[nA], poReg[nB]);                 break;
            case TAPE_MUL:   oResult = ivMul(poReg[nA], poReg[nB]);                 break;
            case TAPE_DIV:   oResult = ivDiv(poReg[nA], poReg[nB]);                 break;
            case TAPE_NEG:   oResult = ivNeg(poReg[nA]);                            break;
            case TAPE_ABS:   oResult = ivAbs(poReg[nA]);                            break;
            case TAPE_SQRT:  oResult = ivSqrt(poReg[nA]);                           break;
            case TAPE_SIN:   oResult = ivSinCos(poReg[nA], false);                  break;
            case TAPE_COS:   oResult = ivSinCos(poReg[nA], true);                   break;
            case TAPE_FLOOR: oResult = ivFloor(poReg[nA]);                          break;
            case TAPE_MOD:   oResult = ivMod(poReg[nA], poReg[nB]);                 break;
            case TAPE_MIN:
            {
                const Interval& a = poReg[nA];
                const Interval& b = poReg[nB];
                oResult = ivMin(a, b);
                if (!a.bNaN && !b.bNaN)
                {
                    if (a.fHi < b.fLo)      pnChoice[i] = 1;
                    else if (b.fHi < a.fLo) pnChoice[i] = 2;
                }
                break;
            }
            case TAPE_MAX:
            {
                const Interval& a = poReg[nA];
                const Interval& b = poReg[nB];
                oResult = ivMax(a, b);
                if (!a.bNaN && !b.bNaN)
                {
                    if (a.fLo > b.fHi)      pnChoice[i] = 1;
                    else if (b.fLo > a.fHi) pnChoice[i] = 2;
                }
                break;
            }
            case TAPE_POW:   oResult = ivPow(poReg[nA], poReg[nB]);                 break;
            case TAPE_EXP:   oResult = ivExp(poReg[nA]);                            break;
            default:         oResult = ivLog(poReg[nA]);                            break; // TAPE_LOG
        }
        poReg[i] = oResult;
    }
    return poReg[nInstructionCount - 1];
}

/// MPR-style tape shortening: given the branch decisions of an interval sweep
/// over a block, emits the sub-tape live for that block. Decided min/max
/// instructions vanish — uses of their register are remapped to the surviving
/// operand — and dead branches are never emitted. Emission preserves original
/// order, so the output stays SSA and its result is its last register: if the
/// root is a decided min/max, the decision chain n-1 → … → t steps strictly
/// downward and marks nothing between its nodes, so the chain's terminus t is
/// the highest-index emitted instruction.
int32_t nShortenTape(   const uint32_t* pnInstructions,
                        int32_t         nInstructionCount,
                        const uint8_t*  pnChoice,
                        uint32_t*       pnOut,   // capacity 2*nInstructionCount words
                        int32_t*        pnRemap, // capacity nInstructionCount
                        uint8_t*        pbLive)  // capacity nInstructionCount
{
    std::fill(pbLive, pbLive + nInstructionCount, uint8_t{0});
    pbLive[nInstructionCount - 1] = 1;

    for (int32_t i = nInstructionCount - 1; i >= 0; i--)
    {
        if (!pbLive[i])
            continue;
        const uint32_t nOp = pnInstructions[2 * i];
        const uint32_t nA  = pnInstructions[2 * i + 1] & 0xFFFFu;
        const uint32_t nB  = pnInstructions[2 * i + 1] >> 16;
        if ((nOp == TAPE_MIN || nOp == TAPE_MAX) && pnChoice[i] != 0)
        {
            pbLive[pnChoice[i] == 1 ? nA : nB] = 1;
        }
        else
        {
            if (bHasOperandA(nOp)) pbLive[nA] = 1;
            if (bHasOperandB(nOp)) pbLive[nB] = 1;
        }
    }

    int32_t nOut = 0;
    for (int32_t i = 0; i < nInstructionCount; i++)
    {
        if (!pbLive[i])
        {
            pnRemap[i] = -1;
            continue;
        }
        const uint32_t nOp = pnInstructions[2 * i];
        uint32_t nA = pnInstructions[2 * i + 1] & 0xFFFFu;
        uint32_t nB = pnInstructions[2 * i + 1] >> 16;
        if ((nOp == TAPE_MIN || nOp == TAPE_MAX) && pnChoice[i] != 0)
        {
            pnRemap[i] = pnRemap[pnChoice[i] == 1 ? nA : nB];
            continue;
        }
        if (bHasOperandA(nOp)) nA = (uint32_t) pnRemap[nA];
        if (bHasOperandB(nOp)) nB = (uint32_t) pnRemap[nB];
        pnOut[2 * nOut]     = nOp;
        pnOut[2 * nOut + 1] = nA | (nB << 16);
        pnRemap[i]          = nOut;
        nOut++;
    }
    return nOut;
}

/// The parallel fill core shared by the fresh-grid and intersect entries:
/// renders the tape into roGrid — which MUST be empty (that is what makes
/// upstream's min(sdf, existing) collapse to min(sdf, background) and the
/// node-steal merge sound) — over oBBox expanded by the narrow band.
void ParallelTapeFillGrid(  const openvdb::FloatGrid::Ptr& roGrid,
                            const float                    fBackground,
                            const PicoGK::VoxelSize        oVoxelSize,
                            const PKBBox3&                 oBBox,
                            const uint32_t*                pnInstructions,
                            int32_t                        nInstructionCount,
                            const double*                  pfConstants)
{
    // Not public on Voxels, but recoverable: the constructor sets the grid
    // background to fToMM(nNarrowBand) (PicoGKVdbVoxels.h:72).
    const int32_t nNarrowBand = (int32_t) std::lround(fBackground / (float) oVoxelSize);

    const PicoGK::Coord xyzMin = oVoxelSize.xyzToVoxels(oBBox.vecMin);
    const PicoGK::Coord xyzMax = oVoxelSize.xyzToVoxels(oBBox.vecMax);
    const int32_t nX0 = xyzMin.X - nNarrowBand, nX1 = xyzMax.X + nNarrowBand;
    const int32_t nY0 = xyzMin.Y - nNarrowBand, nY1 = xyzMax.Y + nNarrowBand;
    const int32_t nZ0 = xyzMin.Z - nNarrowBand, nZ1 = xyzMax.Z + nNarrowBand;

    // Leaf-aligned (x,y) columns; >>3 rounds toward -inf for negatives, which
    // is exactly leaf-origin bucketing.
    const int32_t nCX0 = nX0 >> 3, nCX1 = nX1 >> 3;
    const int32_t nCY0 = nY0 >> 3, nCY1 = nY1 >> 3;
    const int32_t nCZ0 = nZ0 >> 3, nCZ1 = nZ1 >> 3;

    const double fBg = (double) fBackground;

    tbb::enumerable_thread_specific<openvdb::FloatGrid::Ptr> oLocalGrids(
        [fBackground] { return openvdb::FloatGrid::create(fBackground); });
    // Fully-covered leaves proven solid interior; turned into level-1 tiles on
    // the target grid after the merge (worker-tree tiles would be inactive, and
    // MERGE_ACTIVE_STATES does not preserve inactive source tiles).
    tbb::enumerable_thread_specific<std::vector<openvdb::Coord>> oInteriorLeafs;

    tbb::parallel_for(
        tbb::blocked_range2d<int32_t>(nCX0, nCX1 + 1, nCY0, nCY1 + 1),
        [&](const tbb::blocked_range2d<int32_t>& oRange)
        {
            openvdb::FloatGrid::Accessor oAccess = oLocalGrids.local()->getAccessor();
            std::vector<openvdb::Coord>& vecInterior = oInteriorLeafs.local();

            const size_t nRegs = (size_t) nInstructionCount;
            std::vector<double>   vecReg(nRegs);
            std::vector<Interval> vecIv(nRegs);
            std::vector<uint8_t>  vecChoice(nRegs);
            std::vector<uint32_t> vecColTape(2 * nRegs);
            std::vector<uint32_t> vecSlabTape(2 * nRegs);
            std::vector<int32_t>  vecRemap(nRegs);
            std::vector<uint8_t>  vecLive(nRegs);
            // TP7a scratch: axis-dependency mask + per-level instruction lists.
            std::vector<uint8_t>  vecAxisMask(nRegs);
            std::vector<uint32_t> vecLevel[4];
            for (auto& vec : vecLevel)
                vec.reserve(nRegs);
            // TP7b scratch: f64x2 register file for the z-varying level.
            std::vector<v128_t>   vecRegV(nRegs);

            for (int32_t nCX = oRange.rows().begin(); nCX != oRange.rows().end(); nCX++)
            for (int32_t nCY = oRange.cols().begin(); nCY != oRange.cols().end(); nCY++)
            {
                const int32_t nColX0 = std::max(nX0, nCX * 8), nColX1 = std::min(nX1, nCX * 8 + 7);
                const int32_t nColY0 = std::max(nY0, nCY * 8), nColY1 = std::min(nY1, nCY * 8 + 7);
                const bool bColFullX = (nColX0 == nCX * 8) && (nColX1 == nCX * 8 + 7);
                const bool bColFullY = (nColY0 == nCY * 8) && (nColY1 == nCY * 8 + 7);

                // Sample positions are fToMM(i) = i * voxelSize — monotone in
                // i for the positive voxel size — so the block's endpoint
                // samples bound every sample inside it. These are the exact
                // float positions the dense loop evaluates.
                const Interval oColX = ivMake((double) oVoxelSize.fToMM(nColX0), (double) oVoxelSize.fToMM(nColX1));
                const Interval oColY = ivMake((double) oVoxelSize.fToMM(nColY0), (double) oVoxelSize.fToMM(nColY1));

                // Dense per-voxel loop — upstream per-voxel semantics on an
                // empty grid: min(sdf, getValue)=min(sdf, background), then
                // SetSdValue (PicoGKVdbVoxels.h:377-380, 909-920).
                // RebuildGrid() is a no-op upstream and is deliberately not
                // replicated.
                const auto DenseFill = [&](  const uint32_t* pnTape,
                                             int32_t         nTapeCount,
                                             int32_t         nSlabZ0,
                                             int32_t         nSlabZ1)
                {
                    // TP7a — classify every instruction by which sample axes
                    // reach it (an operand's mask is a subset of its user's,
                    // so each level's inputs are ready at its loop depth).
                    for (auto& vec : vecLevel)
                        vec.clear();
                    for (int32_t i = 0; i < nTapeCount; i++)
                    {
                        const uint32_t nOp = pnTape[2 * i];
                        const uint32_t nAB = pnTape[2 * i + 1];
                        uint8_t nMask;
                        switch (nOp)
                        {
                            case TAPE_CONST: nMask = 0; break;
                            case TAPE_X:     nMask = 1; break;
                            case TAPE_Y:     nMask = 2; break;
                            case TAPE_Z:     nMask = 4; break;
                            default:
                                nMask = vecAxisMask[nAB & 0xFFFFu];
                                if (bHasOperandB(nOp))
                                    nMask |= vecAxisMask[nAB >> 16];
                                break;
                        }
                        vecAxisMask[i] = nMask;
                        const int nLevel = (nMask & 4) ? 3 : (nMask & 2) ? 2 : (nMask & 1) ? 1 : 0;
                        vecLevel[nLevel].push_back((uint32_t) i);
                    }

                    const auto WriteVoxel = [&](int32_t x, int32_t y, int32_t z, float fSdf)
                    {
                        const float fValue = std::min(fSdf, fBackground);
                        const openvdb::Coord xyz(x, y, z);
                        oAccess.setValue(xyz, std::clamp(fValue, -fBackground, fBackground));
                        if (std::abs(fValue) >= fBackground)
                            oAccess.setValueOff(xyz);
                    };

                    // Constants and pure-x/y subexpressions evaluate at the
                    // loop depth where their inputs last changed instead of
                    // once per voxel. Sample positions are the same per-axis
                    // floats vecToMM produces (fToMM is componentwise).
                    EvalTapeIndices(pnTape, vecLevel[0].data(), (int32_t) vecLevel[0].size(),
                                    pfConstants, 0.0, 0.0, 0.0, vecReg.data());
                    for (int32_t x = nColX0; x <= nColX1; x++)
                    {
                        const double fX = (double) oVoxelSize.fToMM(x);
                        EvalTapeIndices(pnTape, vecLevel[1].data(), (int32_t) vecLevel[1].size(),
                                        pfConstants, fX, 0.0, 0.0, vecReg.data());
                        for (int32_t y = nColY0; y <= nColY1; y++)
                        {
                            const double fY = (double) oVoxelSize.fToMM(y);
                            EvalTapeIndices(pnTape, vecLevel[2].data(), (int32_t) vecLevel[2].size(),
                                            pfConstants, fX, fY, 0.0, vecReg.data());

                            if (vecLevel[3].empty())
                            {
                                // z-independent tape: the result register is
                                // already final for the whole z-run.
                                const float fSdf = (float) vecReg[nTapeCount - 1];
                                for (int32_t z = nSlabZ0; z <= nSlabZ1; z++)
                                    WriteVoxel(x, y, z, fSdf);
                                continue;
                            }

                            // TP7b — pairs of z samples through the f64x2
                            // evaluator; odd tail runs the scalar path.
                            int32_t z = nSlabZ0;
                            for (; z < nSlabZ1; z += 2)
                            {
                                const v128_t vZ = wasm_f64x2_make(  (double) oVoxelSize.fToMM(z),
                                                                    (double) oVoxelSize.fToMM(z + 1));
                                EvalTapeIndicesV(pnTape, vecLevel[3].data(), (int32_t) vecLevel[3].size(),
                                                 vecAxisMask.data(), vecReg.data(), vZ, vecRegV.data());
                                WriteVoxel(x, y, z,     (float) wasm_f64x2_extract_lane(vecRegV[nTapeCount - 1], 0));
                                WriteVoxel(x, y, z + 1, (float) wasm_f64x2_extract_lane(vecRegV[nTapeCount - 1], 1));
                            }
                            if (z == nSlabZ1)
                            {
                                const double fZ = (double) oVoxelSize.fToMM(z);
                                EvalTapeIndices(pnTape, vecLevel[3].data(), (int32_t) vecLevel[3].size(),
                                                pfConstants, fX, fY, fZ, vecReg.data());
                                WriteVoxel(x, y, z, (float) vecReg[nTapeCount - 1]);
                            }
                        }
                    }
                };

                // A slab proven solid interior: every voxel would be written
                // as inactive -background. A fully-covered leaf is recorded
                // for a level-1 tile; a bbox-clipped block writes the dense
                // representation directly (a tile would spill -background
                // onto out-of-range voxels of the shared leaf).
                const auto InteriorFill = [&](int32_t nCZ, int32_t nSlabZ0, int32_t nSlabZ1)
                {
                    if (bColFullX && bColFullY && nSlabZ0 == nCZ * 8 && nSlabZ1 == nCZ * 8 + 7)
                    {
                        vecInterior.push_back(openvdb::Coord(nCX * 8, nCY * 8, nCZ * 8));
                        return;
                    }
                    for (int32_t x = nColX0; x <= nColX1; x++)
                    for (int32_t y = nColY0; y <= nColY1; y++)
                    for (int32_t z = nSlabZ0; z <= nSlabZ1; z++)
                    {
                        const openvdb::Coord xyz(x, y, z);
                        oAccess.setValue(xyz, -fBackground);
                        oAccess.setValueOff(xyz);
                    }
                };

                // Column-level classification over the full z extent.
                const Interval oColZ = ivMake((double) oVoxelSize.fToMM(nZ0), (double) oVoxelSize.fToMM(nZ1));
                const Interval oCol  = oEvalTapeInterval(   pnInstructions, nInstructionCount, pfConstants,
                                                            oColX, oColY, oColZ,
                                                            vecIv.data(), vecChoice.data());

                if (!oCol.bNaN && oCol.fLo >= fBg)
                    continue; // entire column outside the band — inactive background either way

                if (!oCol.bNaN && oCol.fHi <= -fBg)
                {
                    for (int32_t nCZ = nCZ0; nCZ <= nCZ1; nCZ++)
                        InteriorFill(nCZ, std::max(nZ0, nCZ * 8), std::min(nZ1, nCZ * 8 + 7));
                    continue;
                }

                // Ambiguous column: shorten once with the column's decisions,
                // then classify each 8³ z-slab with the shortened tape.
                const int32_t nColCount = nShortenTape( pnInstructions, nInstructionCount, vecChoice.data(),
                                                        vecColTape.data(), vecRemap.data(), vecLive.data());

                for (int32_t nCZ = nCZ0; nCZ <= nCZ1; nCZ++)
                {
                    const int32_t nSlabZ0 = std::max(nZ0, nCZ * 8), nSlabZ1 = std::min(nZ1, nCZ * 8 + 7);
                    const Interval oSlabZ = ivMake((double) oVoxelSize.fToMM(nSlabZ0), (double) oVoxelSize.fToMM(nSlabZ1));
                    const Interval oSlab  = oEvalTapeInterval(  vecColTape.data(), nColCount, pfConstants,
                                                                oColX, oColY, oSlabZ,
                                                                vecIv.data(), vecChoice.data());

                    if (!oSlab.bNaN && oSlab.fLo >= fBg)
                        continue;

                    if (!oSlab.bNaN && oSlab.fHi <= -fBg)
                    {
                        InteriorFill(nCZ, nSlabZ0, nSlabZ1);
                        continue;
                    }

                    const int32_t nSlabCount = nShortenTape(vecColTape.data(), nColCount, vecChoice.data(),
                                                            vecSlabTape.data(), vecRemap.data(), vecLive.data());
                    DenseFill(vecSlabTape.data(), nSlabCount, nSlabZ0, nSlabZ1);
                }
            }
        });

    for (openvdb::FloatGrid::Ptr& roLocal : oLocalGrids)
        roGrid->tree().merge(roLocal->tree(), openvdb::MERGE_ACTIVE_STATES);

    // Interior tiles go on AFTER the merge: each proven leaf slot is disjoint
    // from every dense write, and the coordinate set is a pure function of the
    // tape and bounds, so the final tree is schedule-independent.
    for (std::vector<openvdb::Coord>& vecLeafs : oInteriorLeafs)
        for (const openvdb::Coord& xyz : vecLeafs)
            roGrid->tree().addTile(/*level=*/1, xyz, -fBackground, /*active=*/false);
}

/// R9 — the compose core: renders the tape into an EXISTING (possibly
/// non-empty) grid with upstream Voxels_RenderImplicit's exact per-voxel
/// semantics — fValue = min(sdf, getValue), then SetSdValue
/// (PicoGKVdbVoxels.h:377-380, 909-920; RebuildGrid is a no-op upstream).
///
/// Structure mirrors ParallelTapeFillGrid — keep the two in lockstep. The
/// differences are confined to three points:
///   1. each thread reads the existing grid through its own ConstAccessor
///      (the tree is frozen during the parallel phase),
///   2. WriteVoxel composes min(sdf, existing) instead of min(sdf, background),
///   3. results apply SERIALLY per voxel instead of the node-steal merge —
///      thread-local leaves can be bbox-partial, and only the composed subset
///      may touch the target. Evaluation (the 84-91% share) stays parallel;
///      TP6 pruning still skips every block the tape proves is a no-op
///      (min(sdf>=bg, existing) == existing).
///
/// Every voxel is written by exactly one thread (blocks partition space) and
/// the applied value is a pure function of coordinate + frozen input grid, so
/// the result is schedule-independent — the single/multi differential holds.
void ParallelTapeComposeGrid(   const openvdb::FloatGrid::Ptr& roGrid,
                                const float                    fBackground,
                                const PicoGK::VoxelSize        oVoxelSize,
                                const PKBBox3&                 oBBox,
                                const uint32_t*                pnInstructions,
                                int32_t                        nInstructionCount,
                                const double*                  pfConstants)
{
    const int32_t nNarrowBand = (int32_t) std::lround(fBackground / (float) oVoxelSize);

    const PicoGK::Coord xyzMin = oVoxelSize.xyzToVoxels(oBBox.vecMin);
    const PicoGK::Coord xyzMax = oVoxelSize.xyzToVoxels(oBBox.vecMax);
    const int32_t nX0 = xyzMin.X - nNarrowBand, nX1 = xyzMax.X + nNarrowBand;
    const int32_t nY0 = xyzMin.Y - nNarrowBand, nY1 = xyzMax.Y + nNarrowBand;
    const int32_t nZ0 = xyzMin.Z - nNarrowBand, nZ1 = xyzMax.Z + nNarrowBand;

    const int32_t nCX0 = nX0 >> 3, nCX1 = nX1 >> 3;
    const int32_t nCY0 = nY0 >> 3, nCY1 = nY1 >> 3;
    const int32_t nCZ0 = nZ0 >> 3, nCZ1 = nZ1 >> 3;

    const double fBg = (double) fBackground;

    tbb::enumerable_thread_specific<openvdb::FloatGrid::Ptr> oLocalGrids(
        [fBackground] { return openvdb::FloatGrid::create(fBackground); });
    tbb::enumerable_thread_specific<std::vector<openvdb::Coord>> oInteriorLeafs;

    tbb::parallel_for(
        tbb::blocked_range2d<int32_t>(nCX0, nCX1 + 1, nCY0, nCY1 + 1),
        [&](const tbb::blocked_range2d<int32_t>& oRange)
        {
            openvdb::FloatGrid::Accessor      oAccess = oLocalGrids.local()->getAccessor();
            openvdb::FloatGrid::ConstAccessor oRead   = roGrid->getConstAccessor();
            std::vector<openvdb::Coord>& vecInterior = oInteriorLeafs.local();

            const size_t nRegs = (size_t) nInstructionCount;
            std::vector<double>   vecReg(nRegs);
            std::vector<Interval> vecIv(nRegs);
            std::vector<uint8_t>  vecChoice(nRegs);
            std::vector<uint32_t> vecColTape(2 * nRegs);
            std::vector<uint32_t> vecSlabTape(2 * nRegs);
            std::vector<int32_t>  vecRemap(nRegs);
            std::vector<uint8_t>  vecLive(nRegs);
            std::vector<uint8_t>  vecAxisMask(nRegs);
            std::vector<uint32_t> vecLevel[4];
            for (auto& vec : vecLevel)
                vec.reserve(nRegs);
            std::vector<v128_t>   vecRegV(nRegs);

            for (int32_t nCX = oRange.rows().begin(); nCX != oRange.rows().end(); nCX++)
            for (int32_t nCY = oRange.cols().begin(); nCY != oRange.cols().end(); nCY++)
            {
                const int32_t nColX0 = std::max(nX0, nCX * 8), nColX1 = std::min(nX1, nCX * 8 + 7);
                const int32_t nColY0 = std::max(nY0, nCY * 8), nColY1 = std::min(nY1, nCY * 8 + 7);
                const bool bColFullX = (nColX0 == nCX * 8) && (nColX1 == nCX * 8 + 7);
                const bool bColFullY = (nColY0 == nCY * 8) && (nColY1 == nCY * 8 + 7);

                const Interval oColX = ivMake((double) oVoxelSize.fToMM(nColX0), (double) oVoxelSize.fToMM(nColX1));
                const Interval oColY = ivMake((double) oVoxelSize.fToMM(nColY0), (double) oVoxelSize.fToMM(nColY1));

                // Dense per-voxel loop — upstream per-voxel semantics against
                // the EXISTING grid: min(sdf, getValue), then SetSdValue.
                const auto DenseFill = [&](  const uint32_t* pnTape,
                                             int32_t         nTapeCount,
                                             int32_t         nSlabZ0,
                                             int32_t         nSlabZ1)
                {
                    for (auto& vec : vecLevel)
                        vec.clear();
                    for (int32_t i = 0; i < nTapeCount; i++)
                    {
                        const uint32_t nOp = pnTape[2 * i];
                        const uint32_t nAB = pnTape[2 * i + 1];
                        uint8_t nMask;
                        switch (nOp)
                        {
                            case TAPE_CONST: nMask = 0; break;
                            case TAPE_X:     nMask = 1; break;
                            case TAPE_Y:     nMask = 2; break;
                            case TAPE_Z:     nMask = 4; break;
                            default:
                                nMask = vecAxisMask[nAB & 0xFFFFu];
                                if (bHasOperandB(nOp))
                                    nMask |= vecAxisMask[nAB >> 16];
                                break;
                        }
                        vecAxisMask[i] = nMask;
                        const int nLevel = (nMask & 4) ? 3 : (nMask & 2) ? 2 : (nMask & 1) ? 1 : 0;
                        vecLevel[nLevel].push_back((uint32_t) i);
                    }

                    const auto WriteVoxel = [&](int32_t x, int32_t y, int32_t z, float fSdf)
                    {
                        const openvdb::Coord xyz(x, y, z);
                        const float fValue = std::min(fSdf, oRead.getValue(xyz));
                        oAccess.setValue(xyz, std::clamp(fValue, -fBackground, fBackground));
                        if (std::abs(fValue) >= fBackground)
                            oAccess.setValueOff(xyz);
                    };

                    EvalTapeIndices(pnTape, vecLevel[0].data(), (int32_t) vecLevel[0].size(),
                                    pfConstants, 0.0, 0.0, 0.0, vecReg.data());
                    for (int32_t x = nColX0; x <= nColX1; x++)
                    {
                        const double fX = (double) oVoxelSize.fToMM(x);
                        EvalTapeIndices(pnTape, vecLevel[1].data(), (int32_t) vecLevel[1].size(),
                                        pfConstants, fX, 0.0, 0.0, vecReg.data());
                        for (int32_t y = nColY0; y <= nColY1; y++)
                        {
                            const double fY = (double) oVoxelSize.fToMM(y);
                            EvalTapeIndices(pnTape, vecLevel[2].data(), (int32_t) vecLevel[2].size(),
                                            pfConstants, fX, fY, 0.0, vecReg.data());

                            if (vecLevel[3].empty())
                            {
                                // z-independent tape: the SDF is final for the
                                // whole z-run, but the existing value is not —
                                // WriteVoxel composes per voxel.
                                const float fSdf = (float) vecReg[nTapeCount - 1];
                                for (int32_t z = nSlabZ0; z <= nSlabZ1; z++)
                                    WriteVoxel(x, y, z, fSdf);
                                continue;
                            }

                            int32_t z = nSlabZ0;
                            for (; z < nSlabZ1; z += 2)
                            {
                                const v128_t vZ = wasm_f64x2_make(  (double) oVoxelSize.fToMM(z),
                                                                    (double) oVoxelSize.fToMM(z + 1));
                                EvalTapeIndicesV(pnTape, vecLevel[3].data(), (int32_t) vecLevel[3].size(),
                                                 vecAxisMask.data(), vecReg.data(), vZ, vecRegV.data());
                                WriteVoxel(x, y, z,     (float) wasm_f64x2_extract_lane(vecRegV[nTapeCount - 1], 0));
                                WriteVoxel(x, y, z + 1, (float) wasm_f64x2_extract_lane(vecRegV[nTapeCount - 1], 1));
                            }
                            if (z == nSlabZ1)
                            {
                                const double fZ = (double) oVoxelSize.fToMM(z);
                                EvalTapeIndices(pnTape, vecLevel[3].data(), (int32_t) vecLevel[3].size(),
                                                pfConstants, fX, fY, fZ, vecReg.data());
                                WriteVoxel(x, y, z, (float) vecReg[nTapeCount - 1]);
                            }
                        }
                    }
                };

                // A slab proven solid interior: min(sdf <= -bg, existing) is
                // -background everywhere regardless of the existing content.
                const auto InteriorFill = [&](int32_t nCZ, int32_t nSlabZ0, int32_t nSlabZ1)
                {
                    if (bColFullX && bColFullY && nSlabZ0 == nCZ * 8 && nSlabZ1 == nCZ * 8 + 7)
                    {
                        vecInterior.push_back(openvdb::Coord(nCX * 8, nCY * 8, nCZ * 8));
                        return;
                    }
                    for (int32_t x = nColX0; x <= nColX1; x++)
                    for (int32_t y = nColY0; y <= nColY1; y++)
                    for (int32_t z = nSlabZ0; z <= nSlabZ1; z++)
                    {
                        const openvdb::Coord xyz(x, y, z);
                        oAccess.setValue(xyz, -fBackground);
                        oAccess.setValueOff(xyz);
                    }
                };

                const Interval oColZ = ivMake((double) oVoxelSize.fToMM(nZ0), (double) oVoxelSize.fToMM(nZ1));
                const Interval oCol  = oEvalTapeInterval(   pnInstructions, nInstructionCount, pfConstants,
                                                            oColX, oColY, oColZ,
                                                            vecIv.data(), vecChoice.data());

                if (!oCol.bNaN && oCol.fLo >= fBg)
                    continue; // min(sdf >= bg, existing) == existing — whole column is a no-op

                if (!oCol.bNaN && oCol.fHi <= -fBg)
                {
                    for (int32_t nCZ = nCZ0; nCZ <= nCZ1; nCZ++)
                        InteriorFill(nCZ, std::max(nZ0, nCZ * 8), std::min(nZ1, nCZ * 8 + 7));
                    continue;
                }

                const int32_t nColCount = nShortenTape( pnInstructions, nInstructionCount, vecChoice.data(),
                                                        vecColTape.data(), vecRemap.data(), vecLive.data());

                for (int32_t nCZ = nCZ0; nCZ <= nCZ1; nCZ++)
                {
                    const int32_t nSlabZ0 = std::max(nZ0, nCZ * 8), nSlabZ1 = std::min(nZ1, nCZ * 8 + 7);
                    const Interval oSlabZ = ivMake((double) oVoxelSize.fToMM(nSlabZ0), (double) oVoxelSize.fToMM(nSlabZ1));
                    const Interval oSlab  = oEvalTapeInterval(  vecColTape.data(), nColCount, pfConstants,
                                                                oColX, oColY, oSlabZ,
                                                                vecIv.data(), vecChoice.data());

                    if (!oSlab.bNaN && oSlab.fLo >= fBg)
                        continue;

                    if (!oSlab.bNaN && oSlab.fHi <= -fBg)
                    {
                        InteriorFill(nCZ, nSlabZ0, nSlabZ1);
                        continue;
                    }

                    const int32_t nSlabCount = nShortenTape(vecColTape.data(), nColCount, vecChoice.data(),
                                                            vecSlabTape.data(), vecRemap.data(), vecLive.data());
                    DenseFill(vecSlabTape.data(), nSlabCount, nSlabZ0, nSlabZ1);
                }
            }
        });

    // Serial application. A thread-local voxel is one of exactly three states:
    //   active            → the composed value |v| < background: write it.
    //   inactive, v < 0   → composed solid interior (-background): write it off.
    //   inactive, v >= 0  → either untouched local background, or a composed
    //                       +background — which only arises when the target was
    //                       already inactive background there (min >= bg needs
    //                       existing >= bg). Both mean: leave the target alone.
    {
        openvdb::FloatGrid::Accessor oWrite = roGrid->getAccessor();
        for (openvdb::FloatGrid::Ptr& roLocal : oLocalGrids)
        {
            for (auto itLeaf = roLocal->tree().cbeginLeaf(); itLeaf; ++itLeaf)
            {
                for (auto itVal = itLeaf->cbeginValueAll(); itVal; ++itVal)
                {
                    const float fValue = *itVal;
                    if (itVal.isValueOn())
                    {
                        oWrite.setValue(itVal.getCoord(), fValue);
                    }
                    else if (fValue < 0.0f)
                    {
                        const openvdb::Coord xyz = itVal.getCoord();
                        oWrite.setValue(xyz, fValue);
                        oWrite.setValueOff(xyz);
                    }
                }
            }
        }
    }

    // Interior tiles replace whatever the target held in those (disjoint)
    // leaf slots — the tape proved the composed value is -background there.
    for (std::vector<openvdb::Coord>& vecLeafs : oInteriorLeafs)
        for (const openvdb::Coord& xyz : vecLeafs)
            roGrid->tree().addTile(/*level=*/1, xyz, -fBackground, /*active=*/false);
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

    ParallelTapeFillGrid(   roGrid, roVoxels->fBackgroundMM(), roVoxels->oVoxelSize(),
                            *poBBox, pnInstructions, nInstructionCount, pfConstants);
}

/// R9 — tape counterpart of Voxels_RenderImplicit into an EXISTING grid
/// (withImplicit on non-empty voxels): per-voxel min(sdf, existing) with
/// SetSdValue semantics over the expanded bounds. Slab-parallel evaluation,
/// TP6/TP7 carry over; see ParallelTapeComposeGrid.
PICOGK_API void Voxels_RenderImplicitTapeCompose(   PKINSTANCE      hLib,
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

    ParallelTapeComposeGrid(roVoxels->roVdbGrid(), roVoxels->fBackgroundMM(), roVoxels->oVoxelSize(),
                            *poBBox, pnInstructions, nInstructionCount, pfConstants);
}

/// R9 — tape counterpart of Voxels_IntersectImplicit (upstream
/// PicoGKVdbVoxels.h:386-412): render the implicit into a FRESH grid over the
/// target's active bounds (mirroring upstream's float ops exactly), then
/// csg-intersect with the implicit grid as the surviving operand — the same
/// "keep the nice implicit grid" order upstream's swap produces. One deliberate
/// deviation: upstream swaps whole grids, so the callback path's result carries
/// the fresh grid's (empty) metadata; here only the TREE is reseated, so the
/// target's metadata survives. Geometry is identical.
PICOGK_API void Voxels_IntersectImplicitTape(   PKINSTANCE      hLib,
                                                PKVOXELS        hThis,
                                                const uint32_t* pnInstructions,
                                                int32_t         nInstructionCount,
                                                const double*   pfConstants,
                                                int32_t         nConstantCount)
{
    ValidateTape(pnInstructions, nInstructionCount, nConstantCount);

    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();
    // Empty target: upstream would render over a degenerate active bbox and
    // intersect with nothing — the result is empty, which it already is.
    if (roGrid->tree().empty())
        return;

    const float             fBackground = roVoxels->fBackgroundMM();
    const PicoGK::VoxelSize oVoxelSize  = roVoxels->oVoxelSize();

    // The active-voxel bounds in mm, with upstream's exact conversions
    // (PicoGKVdbVoxels.h:392-401).
    const openvdb::CoordBBox oActive = roGrid->evalActiveVoxelBoundingBox();
    PKBBox3 oBBoxMM;
    oBBoxMM.vecMin.X = oVoxelSize.fToMM(oActive.min().x());
    oBBoxMM.vecMin.Y = oVoxelSize.fToMM(oActive.min().y());
    oBBoxMM.vecMin.Z = oVoxelSize.fToMM(oActive.min().z());
    oBBoxMM.vecMax.X = oVoxelSize.fToMM(oActive.max().x());
    oBBoxMM.vecMax.Y = oVoxelSize.fToMM(oActive.max().y());
    oBBoxMM.vecMax.Z = oVoxelSize.fToMM(oActive.max().z());

    // A fresh grid exactly as upstream builds it — INCLUDING the quirk: the
    // call is `Voxels oVox(oVoxelSize(), fBackgroundMM())`, which passes
    // MILLIMETRES into the ctor's `int nNarrowBand` parameter. The implicit
    // float→int truncation narrows the band (1.5 mm → band 1 at 0.5 mm voxels;
    // band 0 below ⅓ mm). The callback path exercises this inside vendored
    // upstream, which this repo never patches — so the tape path replicates it
    // for bit-identity rather than silently diverging. (Candidate upstream
    // report; a facade-level fix would have to re-baseline the differential.)
    const int32_t nFreshBand       = (int32_t) fBackground;
    const float   fFreshBackground = oVoxelSize.fToMM(nFreshBand);

    openvdb::FloatGrid::Ptr roImplicit = openvdb::FloatGrid::create(fFreshBackground);
    roImplicit->setGridClass(openvdb::GRID_LEVEL_SET);
    roImplicit->setTransform(openvdb::math::Transform::createLinearTransform(oVoxelSize));

    ParallelTapeFillGrid(   roImplicit, fFreshBackground, oVoxelSize,
                            oBBoxMM, pnInstructions, nInstructionCount, pfConstants);

    // Upstream: swap grids, then BoolIntersect → csgIntersection(implicit,
    // original). Same operand order here; the implicit tree survives and is
    // reseated into the handle's grid.
    openvdb::tools::csgIntersection(*roImplicit, *roGrid);
    roGrid->setTree(roImplicit->baseTreePtr());
}
