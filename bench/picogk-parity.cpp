// R7/S4 — drives the PicoGK C ABI in wasm, same workload as the R3 native harness,
// so the raw hash is directly comparable to the native numbers already on record:
//   0.5mm  -> 43,600 verts / 87,196 tris  / rawHash 12717048185319611917
//   0.25mm -> 174,288 verts / 348,572 tris / rawHash 18384843491335746099
// Builds for wasm and native from this one source; native links the dylib directly.

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <vector>

// Native pins PicoGK's TBB so serial-vs-parallel is comparable against serial wasm.
// The prebuilt dylib static-links TBB but exports the r1::create/destroy entry points,
// so a global_control compiled against oneTBB headers still drives it (see R3).
#ifndef __EMSCRIPTEN__
#include <tbb/global_control.h>
#endif

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

struct Hasher {
    uint64_t h = 1469598103934665603ULL;
    void add(const void* p, size_t n) {
        const uint8_t* b = static_cast<const uint8_t*>(p);
        for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
    }
};

int main(int argc, char** argv) {
    const float voxel = argc > 1 ? atof(argv[1]) : 0.5f;
    // argv[2] = 'd' keeps the vertex-dump mode; a number pins native thread count.
    const int threads = (argc > 2 && argv[2][0] >= '1' && argv[2][0] <= '9') ? atoi(argv[2]) : 0;

#ifndef __EMSCRIPTEN__
    std::unique_ptr<tbb::global_control> gc;
    if (threads > 0)
        gc = std::make_unique<tbb::global_control>(tbb::global_control::max_allowed_parallelism, threads);
#endif

    PKINSTANCE lib = Library_hCreateInstance(voxel);
    if (!lib) { printf("RESULT=FAIL Library_hCreateInstance returned 0\n"); return 1; }

    const auto t0 = std::chrono::steady_clock::now();

    PKVector3 c0{0, 0, 0};
    PKVOXELS body = Voxels_hCreateSphere(lib, &c0, 20.f);
    PKVector3 a{-25, 0, 0}, b{25, 0, 0};   // X axis — must match the R3 harness exactly
    PKVOXELS rod = Voxels_hCreateCapsule(lib, &a, &b, 6.f, 6.f);
    Voxels_BoolAdd(lib, body, rod);
    PKVector3 c1{0, 0, 12};
    PKVOXELS hole = Voxels_hCreateSphere(lib, &c1, 9.f);
    Voxels_BoolSubtract(lib, body, hole);
    Voxels_Offset(lib, body, 1.5f);

    const float vol = Voxels_fCalculateVolume(lib, body);
    const double msBuild = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();

    const auto t1 = std::chrono::steady_clock::now();
    PKMESH mesh = Mesh_hCreateFromVoxels(lib, body);
    const double msMesh = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t1).count();

    const int32_t nv = Mesh_nVertexCount(lib, mesh);
    const int32_t nt = Mesh_nTriangleCount(lib, mesh);

    // Readback is timed separately: inside this C harness these are ordinary calls,
    // NOT JS<->wasm crossings, so folding them into the total misattributes the cost.
    const auto t2 = std::chrono::steady_clock::now();
    Hasher hh;
    for (int32_t i = 0; i < nv; i++) { PKVector3 v; Mesh_GetVertex(lib, mesh, i, &v); hh.add(&v, sizeof(v)); }
    for (int32_t i = 0; i < nt; i++) { PKTriangle t; Mesh_GetTriangle(lib, mesh, i, &t); hh.add(&t, sizeof(t)); }
    const double msRead = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t2).count();

    const double ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();

    printf("voxel=%.3f threads=%d verts=%d tris=%d vol=%a rawHash=%llu build=%.0fms mesh=%.0fms read=%.0fms total=%.0fms\n",
           voxel, threads, nv, nt, (double)vol, (unsigned long long)hh.h, msBuild, msMesh, msRead, ms);

    // dump mode: emit every vertex as exact hex floats so wasm and native can be
    // diffed value-by-value, not just by hash. A hash says "different"; this says
    // "by how much", which is what decides whether a tolerance oracle is viable.
    if (argc > 2 && argv[2][0] == 'd') {
        FILE* f = fopen(argc > 3 ? argv[3] : "verts.txt", "w");
        for (int32_t i = 0; i < nv; i++) {
            PKVector3 v; Mesh_GetVertex(lib, mesh, i, &v);
            fprintf(f, "%a %a %a\n", (double)v.X, (double)v.Y, (double)v.Z);
        }
        fclose(f);
    }

    // S4 is the Phase-1 gate: a stub cannot fake a triangle count.
    if (nt <= 0) { printf("RESULT=FAIL S4 triangle count %d\n", nt); return 1; }

    Mesh_Destroy(lib, mesh);
    Voxels_Destroy(lib, body); Voxels_Destroy(lib, rod); Voxels_Destroy(lib, hole);
    const int64_t leakedV = Library_nVoxelsAllocated(lib), leakedM = Library_nMeshesAllocated(lib);
    Library_DestroyInstance(lib);

    printf("leaked: voxels=%lld meshes=%lld\n", (long long)leakedV, (long long)leakedM);
    printf("RESULT=OK\n");
    return 0;
}
