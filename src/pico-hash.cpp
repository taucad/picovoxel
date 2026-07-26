// SKv2-0 V0.1 — the G0 canonical grid hash, in-module.
//
// NON-DETERMINISM.md §14.5: normalize representation first, then hash the
// depth-first (coord, canonical value bits) stream over active voxels plus the
// post-prune sign classification of everything inactive. The whole point is the
// `bIsEqual` lesson made structural: tile and dense-leaf encodings of ONE field
// must hash equal, and only a *normalized* tree gives a canonical stream.
//
// Normalization (on a deep copy — the caller's grid is never mutated):
//   1. voxelizeActiveTiles() — active tiles (pathological for level sets, but
//      possible) expand to voxels, so the active stream is voxels-only.
//   2. pruneLevelSet(), serial — uniform inactive leaves collapse to tiles,
//      bottom-up and maximally, which is a canonical form: two trees with the
//      same voxel-level content reach the same topology regardless of how they
//      were built. Serial because an oracle should be boring; prune is O(nodes).
//
// The hash is XXH3-128 (vendor/xxhash, pinned by scripts/fetch-deps.sh) over
// three tagged, deterministically ordered streams:
//   "PVGH0001"                                    version/domain tag
//   per active voxel  (depth-first):  x,y,z i32 + canonical f32 bits
//   "OFFS"                                        separator
//   per negative inactive entry (depth-first):  dim i32 (0 = leaf voxel,
//      else tile edge length) + x,y,z i32 (bbox min) + canonical f32 bits
//
// Negative-only for the inactive stream: an absent region and a +background
// tile both mean "outside" — hashing positive tiles would split one geometry
// into two hashes on a representation detail prune does not canonicalize.
// Negative inactive voxels in mixed (uncollapsible) leaves DO carry geometry —
// they are the voxel-granular inside classification — so they are in the
// stream, not just tiles.
//
// Canonicalization (§14.5, both streams): -0.0 -> +0.0, any NaN -> 0x7fc00000.
// A NaN can never hide behind it: the mesh-side oracle carries
// `nonFiniteRecords` independently (bench/stl-identity.mjs).
//
// The hash covers index-space content only — the transform (voxel size) is
// deliberately outside it; the G0 tuple carries volume/counts alongside, which
// pin world scale. Wall cost is O(active + leaves·512 + tiles) serial, plus a
// transient deep copy of the tree (2x grid memory while hashing).

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

#include <openvdb/tools/Prune.h>

#define XXH_INLINE_ALL
#include "xxhash.h"

#include <cstring>
#include <vector>

namespace {

/// -0.0 -> +0.0, any NaN -> 0x7fc00000, everything else raw f32 bits (§14.5).
inline uint32_t nCanonicalBits(float f)
{
    uint32_t nBits;
    std::memcpy(&nBits, &f, sizeof(nBits));
    if ((nBits & 0x7f800000u) == 0x7f800000u && (nBits & 0x007fffffu) != 0u)
        return 0x7fc00000u;
    return nBits == 0x80000000u ? 0u : nBits;
}

/// Little-endian record writer batching XXH3 updates. Wasm is little-endian;
/// the explicit byte writes keep the stream definition host-independent.
class StreamHasher
{
public:
    StreamHasher()
    {
        m_oBuffer.reserve(nFlushAt + 32);
        XXH3_128bits_reset(&m_oState);
    }

    void PutU32(uint32_t n)
    {
        m_oBuffer.push_back((uint8_t) (n));
        m_oBuffer.push_back((uint8_t) (n >> 8));
        m_oBuffer.push_back((uint8_t) (n >> 16));
        m_oBuffer.push_back((uint8_t) (n >> 24));
        if (m_oBuffer.size() >= nFlushAt)
            Flush();
    }

    void PutI32(int32_t n)             { PutU32((uint32_t) n); }
    void PutTag(const char psz[8])
    {
        Flush();
        XXH3_128bits_update(&m_oState, psz, 8);
    }

    XXH128_hash_t oDigest()
    {
        Flush();
        return XXH3_128bits_digest(&m_oState);
    }

private:
    void Flush()
    {
        if (!m_oBuffer.empty())
        {
            XXH3_128bits_update(&m_oState, m_oBuffer.data(), m_oBuffer.size());
            m_oBuffer.clear();
        }
    }

    static constexpr size_t nFlushAt = 1u << 16;
    XXH3_state_t            m_oState;
    std::vector<uint8_t>    m_oBuffer;
};

} // namespace

/// The G0 canonical grid hash (16 bytes) + the counts the tuple carries.
/// Any out-parameter may be null.
PICOGK_API void Voxels_GetGridHash( PKINSTANCE  hLib,
                                    PKVOXELS    hThis,
                                    uint8_t*    pnHash16,
                                    uint64_t*   pnActiveVoxels,
                                    uint64_t*   pnInsideTiles,
                                    uint64_t*   pnInsideOffVoxels)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    // Normalized deep copy; the live grid is untouched.
    openvdb::FloatTree oTree(roVoxels->roVdbGrid()->tree());
    oTree.voxelizeActiveTiles();
    openvdb::tools::pruneLevelSet(oTree, /* threaded: */ false);

    StreamHasher oHasher;
    oHasher.PutTag("PVGH0001");

    uint64_t nActive = 0;
    for (auto it = oTree.cbeginValueOn(); it; ++it)
    {
        const openvdb::Coord oCoord = it.getCoord();
        oHasher.PutI32(oCoord.x());
        oHasher.PutI32(oCoord.y());
        oHasher.PutI32(oCoord.z());
        oHasher.PutU32(nCanonicalBits(it.getValue()));
        nActive++;
    }

    oHasher.PutTag("OFFS\0\0\0\0");

    uint64_t nTiles = 0;
    uint64_t nOffVoxels = 0;
    for (auto it = oTree.cbeginValueOff(); it; ++it)
    {
        const float fValue = it.getValue();
        if (!(fValue < 0.0f))
            continue; // outside (or NaN) — absence and +background are one class

        openvdb::CoordBBox oBBox;
        it.getBoundingBox(oBBox);
        const bool bTile = it.isTileValue();
        oHasher.PutI32(bTile ? oBBox.dim().x() : 0);
        oHasher.PutI32(oBBox.min().x());
        oHasher.PutI32(oBBox.min().y());
        oHasher.PutI32(oBBox.min().z());
        oHasher.PutU32(nCanonicalBits(fValue));
        (bTile ? nTiles : nOffVoxels)++;
    }

    const XXH128_hash_t oDigest = oHasher.oDigest();
    if (pnHash16 != nullptr)
    {
        // Big-endian limbs so the hex string TS renders reads high-to-low.
        for (int i = 0; i < 8; i++)
        {
            pnHash16[i]     = (uint8_t) (oDigest.high64 >> (56 - 8 * i));
            pnHash16[8 + i] = (uint8_t) (oDigest.low64  >> (56 - 8 * i));
        }
    }
    if (pnActiveVoxels != nullptr)      *pnActiveVoxels     = nActive;
    if (pnInsideTiles != nullptr)       *pnInsideTiles      = nTiles;
    if (pnInsideOffVoxels != nullptr)   *pnInsideOffVoxels  = nOffVoxels;
}

/// Oracle test tooling: rewrite the grid as fully dense leaves across its
/// active bounding box — same field, maximally different representation. The
/// grid-hash self-test densifies a copy and asserts the hash does not move
/// (§14.5's tile-vs-dense pair) while Voxels_nMemUsage proves the
/// representation really changed. O(bbox volume): meant for small fixtures.
PICOGK_API void Voxels_DensifyInterior( PKINSTANCE  hLib,
                                        PKVOXELS    hThis)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);

    const openvdb::FloatGrid::Ptr roGrid = roVoxels->roVdbGrid();
    const openvdb::FloatTree& oSource = roGrid->tree();
    const openvdb::CoordBBox oBBox = roGrid->evalActiveVoxelBoundingBox();

    auto roDense = openvdb::SharedPtr<openvdb::FloatTree>(
        new openvdb::FloatTree(oSource.background()));
    {
        openvdb::tree::ValueAccessor<const openvdb::FloatTree> oRead(oSource);
        openvdb::tree::ValueAccessor<openvdb::FloatTree> oWrite(*roDense);
        for (int z = oBBox.min().z(); z <= oBBox.max().z(); z++)
        for (int y = oBBox.min().y(); y <= oBBox.max().y(); y++)
        for (int x = oBBox.min().x(); x <= oBBox.max().x(); x++)
        {
            const openvdb::Coord oCoord(x, y, z);
            float fValue;
            if (oRead.probeValue(oCoord, fValue))
                oWrite.setValueOn(oCoord, fValue);
            else
                oWrite.setValueOff(oCoord, fValue);
        }
    }
    roGrid->setTree(roDense);
}
