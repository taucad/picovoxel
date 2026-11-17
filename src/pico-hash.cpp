// SKv2-0 V0.1 — the G0 canonical grid hash, in-module.
//
// Normalize representation first, then hash the depth-first (coord, canonical
// value bits) stream over active voxels plus the post-prune sign classification of everything inactive. The whole point is the
// `bIsEqual` lesson made structural: tile and dense-leaf encodings of ONE field
// must hash equal, and only a *normalized* tree gives a canonical stream.
//
// Normalization (on a deep copy — the caller's grid is never mutated):
//   1. voxelizeActiveTiles() — active tiles (pathological for level sets, but
//      possible) expand to voxels, so the active stream is voxels-only.
//   2. Voxels::PruneSignUniform(), serial — the fills' own prune (patch
//      0002): inactive nodes whose values share one sign collapse to
//      ±background tiles, bottom-up and maximally, which is a canonical form:
//      two trees with the same voxel-level content reach the same topology
//      regardless of how they were built. Serial because an oracle should be
//      boring; prune is O(nodes). Plain pruneLevelSet would sign a mixed-sign
//      inactive node by its first value and hash two different inside sets
//      equal (a fill clipped through solid interior has such nodes).
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
// Negative inactive voxels in mixed-sign (uncollapsible) nodes DO carry
// geometry — they are the voxel-granular inside classification — so they are
// in the stream, not just tiles.
//
// Canonicalization (§14.5, both streams): -0.0 -> +0.0, any NaN -> 0x7fc00000.
// A NaN can never hide behind it: the mesh-side oracle carries
// `nonFiniteRecords` independently (bench/stl-identity.mjs).
//
// The hash covers index-space content only — the transform (voxel size) is
// deliberately outside it; the G0 tuple carries volume/counts alongside, which
// pin world scale. Wall cost is O(active + leaves·512 + tiles) serial.
//
// Streaming (Voxels_GetGridHash). The definition above is written against a
// normalized deep copy, and Voxels_GetGridHashCopy still computes it that way:
// it is the oracle. The export the facade calls reads the live tree instead
// and normalizes on the fly, so hashing needs no second grid (the copy was
// the largest transient left after streamed export: research run 2026-11-16,
// lane K6, measured about 92 MiB at the proxy's 31 units). Both walks visit
// entries in the order OpenVDB's tree iterators do — depth first, each node's
// tiles and children interleaved by table position — so normalizing a node
// where it stands, instead of in a copy, changes no record and no position:
//   - an active tile is the dense run of active voxels voxelizeActiveTiles
//     would put in its slot, enumerated in table order (HashActiveTile);
//   - PruneSignUniform turns a child into a ±background tile when, after its
//     own children were pruned, it holds no active value and every value is
//     signed alike; nSignUniform decides that bottom-up without touching the
//     tree, and the OFF walk emits the tile where the copy would hold it.

// Include order is load-bearing — see the note at the top of pico-bulk.cpp.
#include "PicoGKTypes.h"
#include "PicoGK.h"
#include "PicoGKLibraryMgr.h"

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

using FloatTree = openvdb::FloatTree;
using RootNode  = FloatTree::RootNodeType;
using Level2    = RootNode::ChildNodeType;
using Level1    = Level2::ChildNodeType;
using Leaf      = Level1::ChildNodeType;

/// Writes the digest and counts to whichever out-parameters are present.
void WriteHashResult(   StreamHasher&   oHasher,
                        uint64_t        nActive,
                        uint64_t        nTiles,
                        uint64_t        nOffVoxels,
                        uint8_t*        pnHash16,
                        uint64_t*       pnActiveVoxels,
                        uint64_t*       pnInsideTiles,
                        uint64_t*       pnInsideOffVoxels)
{
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

/// One active-stream record.
void PutActive(StreamHasher& oHasher, const openvdb::Coord& oCoord, float fValue)
{
    oHasher.PutI32(oCoord.x());
    oHasher.PutI32(oCoord.y());
    oHasher.PutI32(oCoord.z());
    oHasher.PutU32(nCanonicalBits(fValue));
}

/// One OFF-stream record: dim 0 for a leaf voxel, else the tile's edge length.
void PutInside(StreamHasher& oHasher, int32_t nDim, const openvdb::Coord& oMin, float fValue)
{
    oHasher.PutI32(nDim);
    oHasher.PutI32(oMin.x());
    oHasher.PutI32(oMin.y());
    oHasher.PutI32(oMin.z());
    oHasher.PutU32(nCanonicalBits(fValue));
}

/// The active voxels voxelizeActiveTiles makes of one active tile: a node of
/// level nLevel (0 = a leaf) whose every entry is active and holds fValue,
/// enumerated depth first in table order, which is x-major at every level.
/// A root tile is a level-2 node, a level-2 node's tile a level-1 node, and
/// so on down.
void HashActiveTile(StreamHasher& oHasher, const openvdb::Coord& oOrigin, int nLevel, float fValue, uint64_t& nActive)
{
    static constexpr int anLog2Dim[]    = {int(Leaf::LOG2DIM), int(Level1::LOG2DIM), int(Level2::LOG2DIM)};
    static constexpr int anChildTotal[] = {0, int(Leaf::TOTAL), int(Level1::TOTAL)};
    const int nLog2 = anLog2Dim[nLevel];
    const int nShift = anChildTotal[nLevel];
    const int32_t nMask = (1 << nLog2) - 1;
    for (int32_t n = 0; n < (1 << (3 * nLog2)); n++)
    {
        const openvdb::Coord oAt(oOrigin.x() + ((n >> (2 * nLog2)) << nShift),
                                 oOrigin.y() + (((n >> nLog2) & nMask) << nShift),
                                 oOrigin.z() + ((n & nMask) << nShift));
        if (nLevel == 0)
        {
            PutActive(oHasher, oAt, fValue);
            nActive++;
        }
        else
        {
            HashActiveTile(oHasher, oAt, nLevel - 1, fValue, nActive);
        }
    }
}

/// What PruneSignUniform makes of a node: -1 when it stays a node, else 1 when
/// it collapses to an inside (−background) tile and 0 for an outside one.
/// Bottom-up like the prune: a child is judged after its own children.
int nSignUniform(const Leaf& oLeaf)
{
    if (!oLeaf.isInactive())
        return -1;
    const bool bInside = openvdb::math::isNegative(oLeaf.getFirstValue());
    for (openvdb::Index n = 1; n < Leaf::SIZE; n++)
        if (openvdb::math::isNegative(oLeaf.getValue(n)) != bInside)
            return -1;
    return bInside ? 1 : 0;
}

template<typename NodeT>
int nSignUniform(const NodeT& oNode)
{
    // An active tile becomes a voxelized child of active voxels: never
    // inactive, so neither this node nor any ancestor collapses.
    if (!oNode.getValueMask().isOff())
        return -1;
    int nSign = -1;
    for (openvdb::Index n = 0; n < NodeT::NUM_VALUES; n++)
    {
        int nEntry = 0;
        if (oNode.isChildMaskOn(n))
        {
            nEntry = nSignUniform(*oNode.getTable()[n].getChild());
            if (nEntry < 0)
                return -1;
        }
        else
        {
            nEntry = openvdb::math::isNegative(oNode.getTable()[n].getValue()) ? 1 : 0;
        }
        if (nSign < 0)
            nSign = nEntry;
        else if (nEntry != nSign)
            return -1;
    }
    return nSign;
}

/// The OFF stream of one leaf that stays a leaf.
void HashInside(StreamHasher& oHasher, const Leaf& oLeaf, uint64_t& nOffVoxels)
{
    for (auto it = oLeaf.cbeginValueOff(); it; ++it)
    {
        const float fValue = it.getValue();
        if (!(fValue < 0.0f))
            continue; // outside (or NaN) — absence and +background are one class
        PutInside(oHasher, 0, it.getCoord(), fValue);
        nOffVoxels++;
    }
}

/// The OFF stream of one internal node that stays a node, its children
/// normalized first: a sign-uniform child is the ±background tile the prune
/// leaves in its slot.
template<typename NodeT>
void HashInside(StreamHasher& oHasher, const NodeT& oNode, float fInside, uint64_t& nTiles, uint64_t& nOffVoxels)
{
    using ChildT = typename NodeT::ChildNodeType;
    for (openvdb::Index n = 0; n < NodeT::NUM_VALUES; n++)
    {
        if (oNode.isChildMaskOn(n))
        {
            const ChildT& oChild = *oNode.getTable()[n].getChild();
            const int nSign = nSignUniform(oChild);
            if (nSign == 1)
            {
                PutInside(oHasher, int32_t(ChildT::DIM), oChild.origin(), fInside);
                nTiles++;
            }
            else if (nSign < 0)
            {
                if constexpr (ChildT::LEVEL == 0)
                    HashInside(oHasher, oChild, nOffVoxels);
                else
                    HashInside(oHasher, oChild, fInside, nTiles, nOffVoxels);
            }
            continue;
        }
        const float fValue = oNode.getTable()[n].getValue();
        // An active tile voxelizes into active voxels only: nothing inactive.
        if (oNode.isValueMaskOn(n) || !(fValue < 0.0f))
            continue;
        PutInside(oHasher, int32_t(ChildT::DIM), oNode.offsetToGlobalCoord(n), fValue);
        nTiles++;
    }
}

} // namespace

/// The G0 canonical grid hash (16 bytes) + the counts the tuple carries, read
/// from the live tree with no copy (see "Streaming" above): record for record
/// the stream Voxels_GetGridHashCopy hashes. Any out-parameter may be null.
PICOGK_API void Voxels_GetGridHash( PKINSTANCE  hLib,
                                    PKVOXELS    hThis,
                                    uint8_t*    pnHash16,
                                    uint64_t*   pnActiveVoxels,
                                    uint64_t*   pnInsideTiles,
                                    uint64_t*   pnInsideOffVoxels)
{
    PicoGK::Library::Instance::Ptr roLib = PicoGK::Library::oLib().roGetInstance(hLib);
    PicoGK::Voxels::Ptr roVoxels = roLib->m_oVoxels.roGet(hThis);
    const FloatTree& oTree = roVoxels->roVdbGrid()->tree();
    const float fInside = openvdb::math::negative(oTree.background());

    StreamHasher oHasher;
    oHasher.PutTag("PVGH0001");

    uint64_t nActive = 0;
    for (auto it = oTree.cbeginValueOn(); it; ++it)
    {
        if (it.isVoxelValue())
        {
            PutActive(oHasher, it.getCoord(), it.getValue());
            nActive++;
            continue;
        }
        // A tile of a level-L node is a level L-1 node voxelized.
        openvdb::CoordBBox oBBox;
        it.getBoundingBox(oBBox);
        HashActiveTile(oHasher, oBBox.min(), int(it.getLevel()) - 1, it.getValue(), nActive);
    }

    oHasher.PutTag("OFFS\0\0\0\0");

    uint64_t nTiles = 0;
    uint64_t nOffVoxels = 0;
    for (auto it = oTree.root().cbeginChildAll(); it; ++it)
    {
        const Level2* pChild = nullptr;
        float fValue = 0.0f;
        if (it.probeChild(pChild, fValue))
        {
            const int nSign = nSignUniform(*pChild);
            if (nSign == 1)
            {
                PutInside(oHasher, int32_t(Level2::DIM), pChild->origin(), fInside);
                nTiles++;
            }
            else if (nSign < 0)
            {
                HashInside(oHasher, *pChild, fInside, nTiles, nOffVoxels);
            }
            continue;
        }
        if (it.isValueOn() || !(fValue < 0.0f))
            continue;
        PutInside(oHasher, int32_t(Level2::DIM), it.getCoord(), fValue);
        nTiles++;
    }

    WriteHashResult(oHasher, nActive, nTiles, nOffVoxels,
                    pnHash16, pnActiveVoxels, pnInsideTiles, pnInsideOffVoxels);
}

/// The same hash computed as the definition reads, over a normalized deep copy
/// of the tree (2x grid memory while hashing): the oracle Voxels_GetGridHash
/// is tested against. The facade never calls it. Any out-parameter may be null.
PICOGK_API void Voxels_GetGridHashCopy( PKINSTANCE  hLib,
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
    PicoGK::Voxels::PruneSignUniform(oTree, /* threaded: */ false);

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

    WriteHashResult(oHasher, nActive, nTiles, nOffVoxels,
                    pnHash16, pnActiveVoxels, pnInsideTiles, pnInsideOffVoxels);
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
