// SK-0.4 — the lattice lane: openvdb's parallel tube-complex voxelizer in place of
// the serial dense-accessor loop.
//
// Voxels::RenderLattice (PicoGKVdbVoxels.h:343-358) walks every sphere and every beam
// in turn and, for each, walks its padded bounding box voxel by voxel through ONE
// FloatGrid::Accessor, taking min(element SDF, existing value). One thread, one
// accessor, one element at a time. On HelixHeatX the two largest creation stages are
// exactly this loop — `turning-fins.hot` (3.8 s) and `helical-void.hot` (5.2 s) — and
// both sat at 0.99-1.00x through a 12-thread allocator swap (SK-0.1 §"HeatX creation
// stage decomposition"), which is what a genuinely serial stage looks like from the
// outside. WORKLOAD-EXECUTORS.md marks the row ST and calls it the top serial wall.
//
// openvdb has shipped the parallel replacement since 12.1: tools::createLevelSetTubeComplex
// (LevelSetTubes.h — already #included by PicoGKVdbVoxels.h:49, unused) takes vertex,
// segment and radius ARRAYS and voxelizes them with a tbb reduce over spatially
// bucketed segments, each bucket driving ConvexVoxelizer's scanline walk over only the
// voxels the shape actually touches. Per-thread trees are combined with a node-stealing
// csg union.
//
// WHAT MAPS AND WHAT DOES NOT (the beam-case table; see SK-0.4.md for the measured
// per-fixture consequences):
//
//   * round-capped beam, r0 != r1  -> tapered capsule. Both PicoGK's fSdvRoundCone and
//     openvdb's TaperedCapsuleVoxelizer are the exact SDF of the convex hull of the two
//     end spheres. Same shape, same definition.
//   * round-capped beam, r0 == r1  -> capsule. openvdb dispatches this itself when
//     |r0-r1| < 0.001 voxel (LevelSetTubesImpl.h:1195), avoiding the tapered form's
//     degenerate algebra; PicoGK's round-cone formula handles it analytically. Same shape.
//   * round-capped beam whose end spheres nest ((p0-p1)^2 <= (r0-r1)^2) -> ball, the
//     larger sphere (LevelSetTubesImpl.h:1191). That IS the convex hull in that case, and
//     it is what fSdvRoundCone returns too.
//   * zero-length round-capped beam -> never reaches here: Lattice::AddBeam turns it into
//     a sphere (PicoGKLattice.h:213-218). Its ball branch would produce the same shape.
//   * sphere -> a zero-length segment with equal radii, which lands in the same ball
//     branch. Spheres therefore ride in the SAME complex as the beams; no second pass.
//   * FLAT-capped beam (bRoundCap == false) -> NO tube-complex expression. fSdvFlatCone is
//     a conical frustum with planar ends; the tube complex is built exclusively from
//     spherical-capped convex hulls, and there is no "open"/"flat" variant in the API.
//     These fall back to the serial lane, as a lattice of their own.
//
// The fallback is not hypothetical but it is small: of the HeatX lattices only the
// ScrewHole pair (2 beams each) and the ThreadCutter helix use roundCap: false, and the
// two dominant stages (turning-fins, helical-void) are round-capped throughout.
//
// DETERMINISM IS BY CONSTRUCTION, NOT BY LUCK. The 0.7 mm fine-cell single==multi
// identity gate is part of L0 (bench/results/webgpu-v2/SK-0-P0-finecell.md — a spike was
// reverted for breaking it), so a lane whose output depends on how tbb happened to
// schedule is not shippable. Upstream's own entry point uses tbb::parallel_reduce with
// the auto partitioner: the number of body splits, and therefore the shape of the join
// tree, depends on how many workers turn up. csg union is a min and min is exactly
// associative and commutative in IEEE, so the VALUES are order-free either way, but the
// resulting tree topology need not be, and a 1-thread build and a 12-thread build would
// not even take the same split tree. So this TU drives the voxelizer itself under
// tbb::parallel_deterministic_reduce with a grain size derived only from the bucket
// count: the split tree — hence the join order — is a pure function of the input, identical
// at 1 thread and at 12. That is the same discipline as the disjoint-slot mesh flatten
// (patches/PicoGKRuntime/0001-parallel-disjoint-mesh-flatten.patch).
//
// WHY A NEW TU. Same reason as src/pico-offset.cpp: everything needed is public
// (Voxels::roVdbGrid(), Voxels::RenderLattice(), Lattice::oBeams()/oSpheres()), so the
// vendored tree needs no behavioural change. The one thing it lacked was READ access to a
// beam's defining parameters — LatticeBeam exposed only fSdValue(), which forces exactly
// the per-sample shape we are replacing — and that is the whole of
// patches/PicoGKRuntime/0003-lattice-parameter-accessors.patch: seven inline getters,
// pure insertion, upstreamable verbatim.
//
// The old lane stays reachable and unmodified as Voxels_RenderLattice on the
// `picovoxel/raw` subpath (the A/B arm), and the facade routes back to it wholesale
// under createPico({ serialLattice: true }) (ctx.renderLatticeExport) — the
// escape hatch, and the arm the pre-SK-0.4 byte pins certify.

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/openvdb.h>
#include <openvdb/tools/Composite.h>
#include <openvdb/tools/LevelSetTubes.h>
#include <openvdb/tools/Prune.h>
#include <openvdb/util/NullInterrupter.h>

#include <tbb/blocked_range.h>
#include <tbb/parallel_reduce.h>

#include <cmath>
#include <vector>

namespace {

using TubeVoxelizer = openvdb::tools::lvlset::TubeComplexVoxelizer<
    openvdb::FloatGrid,
    float,
    openvdb::util::NullInterrupter,
    /* PerSegmentRadii = */ false>;   // per-VERTEX radii: PicoGK beams taper per endpoint

/// Leaf tasks the deterministic split tree is cut into. Only the ratio to the bucket
/// count matters, and only that it is a CONSTANT: it makes the split tree a function of
/// the input alone, which is what makes single == multi bit-exact. Swept 16/32/64 on the
/// extracted HeatX + quasicrystal fixtures (12T, 0.5 mm): 16 wins the beam-heavy stages
/// (turning-fins 1204 vs 1311 ms at 64) and concedes ~15% on helical-void; sum of tube-lane
/// medians 2156/2165/2253 ms. 16 keeps every one of 12 cores fed without paying for a
/// deeper join tree.
constexpr size_t SPLIT_TARGET = 16;

/// Builds the narrow-band level set of one tube complex. Mirrors upstream's
/// createLevelSetTubeComplex (LevelSetTubesImpl.h:1362-1372, TUBE_VERTEX_RADII branch)
/// exactly, except that the reduce is deterministic — see the header note.
openvdb::FloatGrid::Ptr roTubeComplex(   const std::vector<openvdb::Vec3s>&  oVertices,
                                         const std::vector<openvdb::Vec2I>&  oSegments,
                                         const std::vector<float>&           oRadii,
                                         float                               fVoxelSize,
                                         float                               fHalfWidth)
{
    TubeVoxelizer oOp(oVertices, oSegments, oRadii, fVoxelSize, fHalfWidth, nullptr);

    const size_t nBuckets = (size_t) oOp.bucketSize();
    if (nBuckets > 0)
    {
        const size_t nGrain = nBuckets <= SPLIT_TARGET
                                ? 1
                                : (nBuckets + SPLIT_TARGET - 1) / SPLIT_TARGET;

        tbb::parallel_deterministic_reduce(
            tbb::blocked_range<size_t>(0, nBuckets, nGrain), oOp);
    }

    openvdb::FloatGrid::Ptr roGrid = oOp.getGrid();
    openvdb::tools::pruneLevelSet(roGrid->tree());
    return roGrid;
}

} // namespace

/// Renders a lattice into a voxel field through openvdb's parallel tube complex, falling
/// back to Voxels::RenderLattice for the flat-capped beams it cannot express. Drop-in
/// replacement for Voxels_RenderLattice: same handles, same union-into-existing-grid
/// semantics, same result up to the narrow-band construction difference documented in
/// bench/results/webgpu-v2/SK-0.4.md.
PICOGK_API void Voxels_RenderLatticeTubes(  PKINSTANCE  hLib,
                                            PKVOXELS    hThis,
                                            PKLATTICE   hLattice)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr  roVoxels  = roLib->m_oVoxels.roGet(hThis);
    PicoGK::Lattice::Ptr roLattice = roLib->m_oLattices.roGet(hLattice);

    openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();

    // The complex builds its own grid, so that grid's voxel size AND background have to
    // match this one bit-for-bit or the csgUnion below would splice two different narrow
    // bands together. Both are the same float product (voxel size x half width) — PicoGK
    // spells it `nNarrowBand * m_fVoxelSizeMM` (PicoGKTypes.h:420-423), openvdb spells it
    // `voxelSize * halfWidth` in double and rounds once (Grid.h createLevelSet); for float
    // operands those agree exactly, because a float x float product is always exact in
    // double. Recover the half width by rounding, then VERIFY the product reproduces the
    // background rather than assuming it: PicoGK's narrow band is an int32, but Voxels has
    // a constructor that takes a millimetre value there (PicoGKVdbVoxels.h:393), so a grid
    // whose band is not an integer number of voxels is reachable. Such a grid goes down the
    // serial lane, unchanged.
    const float fVoxelSize = (float) roGrid->voxelSize().x();
    const float fHalfWidth = (float) std::round(roGrid->background() / fVoxelSize);

    if (!(fVoxelSize > 0.0f)
        || !(fHalfWidth >= 1.0f)
        || fVoxelSize * fHalfWidth != roGrid->background())
    {
        roVoxels->RenderLattice(*roLattice);
        return;
    }

    const std::vector<PicoGK::LatticeSphere::Ptr>& oSpheres = roLattice->oSpheres();
    const std::vector<PicoGK::LatticeBeam>&        oBeams   = roLattice->oBeams(); // by value since patches/PicoGKRuntime/0003 (U18)

    std::vector<openvdb::Vec3s> oVertices;
    std::vector<openvdb::Vec2I> oSegments;
    std::vector<float>          oRadii;
    oVertices.reserve(oSpheres.size() + 2 * oBeams.size());
    oRadii.reserve(oSpheres.size() + 2 * oBeams.size());
    oSegments.reserve(oSpheres.size() + oBeams.size());

    // The flat-capped subset, re-authored as a lattice of its own so the serial lane can
    // render exactly those beams and nothing else. AddBeam is given bRoundCap = false, so
    // its zero-length-beam-becomes-a-sphere rule cannot fire and the subset stays a subset.
    PicoGK::Lattice oFlatCapped;
    bool bHasFlatCapped = false;

    // A sphere is a zero-length segment with equal end radii: openvdb's per-vertex-radii
    // dispatch sends (p1-p2)^2 <= (r1-r2)^2 to its ball branch, which is that sphere.
    // Reusing the one vertex for both segment ends keeps the radius array in step.
    for (const PicoGK::LatticeSphere::Ptr& roSphere : oSpheres)
    {
        const PicoGK::Vector3& vecCentre = roSphere->vecCenter();
        const openvdb::Index32 nAt = (openvdb::Index32) oVertices.size();

        oVertices.push_back(openvdb::Vec3s(vecCentre.X, vecCentre.Y, vecCentre.Z));
        oRadii.push_back(roSphere->fRadius());
        oSegments.push_back(openvdb::Vec2I(nAt, nAt));
    }

    for (const PicoGK::LatticeBeam& oBeam : oBeams)
    {
        if (!oBeam.bRoundCap())
        {
            oFlatCapped.AddBeam(    oBeam.vecStart(),
                                    oBeam.vecEnd(),
                                    oBeam.fRadStart(),
                                    oBeam.fRadEnd(),
                                    false);
            bHasFlatCapped = true;
            continue;
        }

        const PicoGK::Vector3& vecStart = oBeam.vecStart();
        const PicoGK::Vector3& vecEnd   = oBeam.vecEnd();
        const openvdb::Index32 nAt = (openvdb::Index32) oVertices.size();

        oVertices.push_back(openvdb::Vec3s(vecStart.X, vecStart.Y, vecStart.Z));
        oVertices.push_back(openvdb::Vec3s(vecEnd.X,   vecEnd.Y,   vecEnd.Z));
        oRadii.push_back(oBeam.fRadStart());
        oRadii.push_back(oBeam.fRadEnd());
        oSegments.push_back(openvdb::Vec2I(nAt, nAt + 1));
    }

    if (!oSegments.empty())
    {
        openvdb::FloatGrid::Ptr roTubes = roTubeComplex( oVertices,
                                                        oSegments,
                                                        oRadii,
                                                        fVoxelSize,
                                                        fHalfWidth);

        // Boolean-add into the target, exactly as RenderMesh does (PicoGKVdbVoxels.h:340).
        // csgUnion prunes on exit, which is what PruneFill did for the serial fill.
        openvdb::tools::csgUnion(*roGrid, *roTubes);
    }

    if (bHasFlatCapped)
        roVoxels->RenderLattice(oFlatCapped);
}
