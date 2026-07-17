// R3: Is PicoGK's native mesh output thread-count-dependent?
//
// Drives the PicoGK C ABI directly against the prebuilt dylib, pinning TBB's
// max_allowed_parallelism to N via tbb::global_control (the dylib exports the
// r1::create/destroy entry points its header-only ctor needs), then hashes the
// resulting mesh. If hashes differ across N, mesh output is scheduling-dependent
// and WASM-vs-native bit-comparison is off the table.

#include <tbb/global_control.h>

#include <chrono>
#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <vector>

#pragma pack(1)
struct PKVector3 { float X, Y, Z; };
struct PKTriangle { int32_t A, B, C; };
#pragma pack()

using PKINSTANCE = uint64_t;
using PKVOXELS = uint64_t;
using PKMESH = uint64_t;

extern "C" {
PKINSTANCE Library_hCreateInstance(float fVoxelSizeMM);
void       Library_DestroyInstance(PKINSTANCE hThis);
int64_t    Library_nTotalMemUsage(PKINSTANCE hThis);
int64_t    Library_nVoxelsAllocated(PKINSTANCE hThis);
int64_t    Library_nMeshesAllocated(PKINSTANCE hThis);

PKVOXELS   Voxels_hCreateSphere(PKINSTANCE, const PKVector3* pvecCenter, float fRadius);
PKVOXELS   Voxels_hCreateCapsule(PKINSTANCE, const PKVector3* pvecA, const PKVector3* pvecB,
                                 float fRadiusA, float fRadiusB);
void       Voxels_BoolAdd(PKINSTANCE, PKVOXELS hThis, PKVOXELS hOther);
void       Voxels_BoolSubtract(PKINSTANCE, PKVOXELS hThis, PKVOXELS hOther);
void       Voxels_Offset(PKINSTANCE, PKVOXELS hThis, float fDist);
float      Voxels_fCalculateVolume(PKINSTANCE, PKVOXELS hThis);
void       Voxels_Destroy(PKINSTANCE, PKVOXELS hThis);

PKMESH     Mesh_hCreateFromVoxels(PKINSTANCE, PKVOXELS hVoxels);
int32_t    Mesh_nVertexCount(PKINSTANCE, PKMESH hThis);
int32_t    Mesh_nTriangleCount(PKINSTANCE, PKMESH hThis);
void       Mesh_GetVertex(PKINSTANCE, PKMESH hThis, int32_t nVertex, PKVector3* pvecVertex);
void       Mesh_GetTriangle(PKINSTANCE, PKMESH hThis, int32_t nTriangle, PKTriangle* psTri);
void       Mesh_Destroy(PKINSTANCE, PKMESH hThis);
}

// FNV-1a over raw bytes.
struct Hasher {
    uint64_t h = 1469598103934665603ULL;
    void add(const void* p, size_t n) {
        const uint8_t* b = static_cast<const uint8_t*>(p);
        for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
    }
};

struct Result {
    int32_t vertices = 0;
    int32_t triangles = 0;
    float volume = 0.f;
    uint64_t rawHash = 0;    // order-sensitive: raw buffer order
    uint64_t canonHash = 0;  // order-invariant: sorted, quantized
    double ms = 0;
};

// Build a voxel model that actually exercises OpenVDB/TBB:
// sphere + capsule union, minus a smaller sphere, then an offset (LevelSetFilter),
// then volumeToMesh.
static Result run(float voxelSize) {
    auto t0 = std::chrono::steady_clock::now();

    PKINSTANCE lib = Library_hCreateInstance(voxelSize);

    PKVector3 c0{0, 0, 0};
    PKVOXELS body = Voxels_hCreateSphere(lib, &c0, 20.f);

    PKVector3 a{-25, 0, 0}, b{25, 0, 0};
    PKVOXELS rod = Voxels_hCreateCapsule(lib, &a, &b, 6.f, 6.f);
    Voxels_BoolAdd(lib, body, rod);

    PKVector3 c1{0, 0, 12};
    PKVOXELS hole = Voxels_hCreateSphere(lib, &c1, 9.f);
    Voxels_BoolSubtract(lib, body, hole);

    Voxels_Offset(lib, body, 1.5f);

    float volume = Voxels_fCalculateVolume(lib, body);
    PKMESH mesh = Mesh_hCreateFromVoxels(lib, body);

    int32_t nv = Mesh_nVertexCount(lib, mesh);
    int32_t nt = Mesh_nTriangleCount(lib, mesh);

    std::vector<PKVector3> verts(nv);
    std::vector<PKTriangle> tris(nt);
    for (int32_t i = 0; i < nv; i++) Mesh_GetVertex(lib, mesh, i, &verts[i]);
    for (int32_t i = 0; i < nt; i++) Mesh_GetTriangle(lib, mesh, i, &tris[i]);

    Result r;
    r.vertices = nv;
    r.triangles = nt;
    r.volume = volume;

    // Raw, order-sensitive hash.
    Hasher raw;
    raw.add(verts.data(), verts.size() * sizeof(PKVector3));
    raw.add(tris.data(), tris.size() * sizeof(PKTriangle));
    r.rawHash = raw.h;

    // Canonical, order-invariant: quantize each triangle's 3 world-space vertices
    // to 1e-4 mm, sort the corners within a triangle, sort triangles, then hash.
    std::vector<std::array<int64_t, 9>> canon;
    canon.reserve(nt);
    auto q = [](float f) { return static_cast<int64_t>(f * 10000.0f + (f >= 0 ? 0.5f : -0.5f)); };
    for (const auto& t : tris) {
        std::array<std::array<int64_t, 3>, 3> corners{};
        const int32_t idx[3] = {t.A, t.B, t.C};
        for (int k = 0; k < 3; k++) {
            const PKVector3& v = verts[idx[k]];
            corners[k] = {q(v.X), q(v.Y), q(v.Z)};
        }
        std::sort(corners.begin(), corners.end());
        std::array<int64_t, 9> flat{};
        for (int k = 0; k < 3; k++)
            for (int j = 0; j < 3; j++) flat[k * 3 + j] = corners[k][j];
        canon.push_back(flat);
    }
    std::sort(canon.begin(), canon.end());
    Hasher ch;
    for (const auto& f : canon) ch.add(f.data(), f.size() * sizeof(int64_t));
    r.canonHash = ch.h;

    Mesh_Destroy(lib, mesh);
    Voxels_Destroy(lib, body);
    Voxels_Destroy(lib, rod);
    Voxels_Destroy(lib, hole);
    Library_DestroyInstance(lib);

    r.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return r;
}

int main(int argc, char** argv) {
    const float voxelSize = argc > 1 ? atof(argv[1]) : 0.25f;
    const int threads[] = {1, 2, 4, 12};
    const int repeats = 3;

    printf("# R3: PicoGK native mesh determinism vs TBB thread count\n");
    printf("# voxelSize=%.3f mm  hw_concurrency=%d  tbb_default=%d\n",
           voxelSize, (int)std::thread::hardware_concurrency(),
           (int)tbb::global_control::active_value(tbb::global_control::max_allowed_parallelism));
    printf("%-8s %-6s %10s %10s %14s %18s %18s %9s\n",
           "threads", "run", "verts", "tris", "volume", "rawHash", "canonHash", "ms");

    for (int n : threads) {
        for (int r = 0; r < repeats; r++) {
            tbb::global_control gc(tbb::global_control::max_allowed_parallelism, n);
            int active = (int)tbb::global_control::active_value(
                tbb::global_control::max_allowed_parallelism);
            Result res = run(voxelSize);
            printf("%-8d %-6d %10d %10d %16a %18" PRIu64 " %18" PRIu64 " %9.1f%s\n",
                   n, r, res.vertices, res.triangles, res.volume,
                   res.rawHash, res.canonHash, res.ms,
                   active == n ? "" : "  <-- GC NOT APPLIED");
        }
    }
    return 0;
}
