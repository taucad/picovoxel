// R17/R18 — differential conformance: one capability workload, compiled for BOTH
// native and wasm from this single source, printing a comparable line per operation.
// PASS = the two outputs are byte-identical (diff -q).
//
// The native side must be the parity-reference build (-ffp-contract=off): baseline
// wasm has no FMA instruction, so a default arm64 build diverges by 1-ULP class
// noise (see the blueprint's R7 finding). Volumes print as hex floats — exact, not
// rounded — and every mesh gets the raw order-sensitive FNV-1a hash.

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

#pragma pack(1)
struct PKVector3 { float X, Y, Z; };
struct PKTriangle { int32_t A, B, C; };
struct PKBBox3 { PKVector3 vecMin, vecMax; };
#pragma pack()

using PKINSTANCE = uint64_t;
using PKVOXELS = uint64_t;
using PKMESH = uint64_t;
using PKLATTICE = uint64_t;
using PKPFnfSdf = float (*)(const PKVector3*);

extern "C" {
PKINSTANCE Library_hCreateInstance(float);
void       Library_DestroyInstance(PKINSTANCE);
PKVOXELS   Voxels_hCreate(PKINSTANCE);
PKVOXELS   Voxels_hCreateCopy(PKINSTANCE, PKVOXELS);
PKVOXELS   Voxels_hCreateSphere(PKINSTANCE, const PKVector3*, float);
PKVOXELS   Voxels_hCreateCapsule(PKINSTANCE, const PKVector3*, const PKVector3*, float, float);
PKVOXELS   Voxels_hCreateMeshShell(PKINSTANCE, PKMESH, float);
void       Voxels_BoolAdd(PKINSTANCE, PKVOXELS, PKVOXELS);
void       Voxels_BoolSubtract(PKINSTANCE, PKVOXELS, PKVOXELS);
void       Voxels_BoolIntersect(PKINSTANCE, PKVOXELS, PKVOXELS);
void       Voxels_Offset(PKINSTANCE, PKVOXELS, float);
void       Voxels_DoubleOffset(PKINSTANCE, PKVOXELS, float, float);
void       Voxels_TripleOffset(PKINSTANCE, PKVOXELS, float);
void       Voxels_RenderImplicit(PKINSTANCE, PKVOXELS, const PKBBox3*, PKPFnfSdf);
void       Voxels_RenderLattice(PKINSTANCE, PKVOXELS, PKLATTICE);
float      Voxels_fCalculateVolume(PKINSTANCE, PKVOXELS);
bool       Voxels_bRayCastToSurface(PKINSTANCE, PKVOXELS, const PKVector3*, const PKVector3*, PKVector3*);
bool       Voxels_bClosestPointOnSurface(PKINSTANCE, PKVOXELS, const PKVector3*, PKVector3*);
void       Voxels_Destroy(PKINSTANCE, PKVOXELS);
PKLATTICE  Lattice_hCreate(PKINSTANCE);
void       Lattice_AddBeam(PKINSTANCE, PKLATTICE, const PKVector3*, const PKVector3*, float, float, bool);
void       Lattice_AddSphere(PKINSTANCE, PKLATTICE, const PKVector3*, float);
void       Lattice_Destroy(PKINSTANCE, PKLATTICE);
PKMESH     Mesh_hCreateFromVoxels(PKINSTANCE, PKVOXELS);
int32_t    Mesh_nVertexCount(PKINSTANCE, PKMESH);
int32_t    Mesh_nTriangleCount(PKINSTANCE, PKMESH);
void       Mesh_GetVertex(PKINSTANCE, PKMESH, int32_t, PKVector3*);
void       Mesh_GetTriangle(PKINSTANCE, PKMESH, int32_t, PKTriangle*);
void       Mesh_Destroy(PKINSTANCE, PKMESH);
}

struct Hasher {
    uint64_t h = 1469598103934665603ULL;
    void add(const void* p, size_t n) {
        const uint8_t* b = static_cast<const uint8_t*>(p);
        for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
    }
};

static PKINSTANCE g_lib;

// Report volume exactly, plus the mesh hash — topology AND geometry per op.
static void report(const char* op, PKVOXELS v) {
    const float volume = Voxels_fCalculateVolume(g_lib, v);
    PKMESH mesh = Mesh_hCreateFromVoxels(g_lib, v);
    const int32_t nv = Mesh_nVertexCount(g_lib, mesh);
    const int32_t nt = Mesh_nTriangleCount(g_lib, mesh);
    Hasher h;
    for (int32_t i = 0; i < nv; i++) { PKVector3 p; Mesh_GetVertex(g_lib, mesh, i, &p); h.add(&p, sizeof p); }
    for (int32_t i = 0; i < nt; i++) { PKTriangle t; Mesh_GetTriangle(g_lib, mesh, i, &t); h.add(&t, sizeof t); }
    printf("%-14s vol=%a verts=%d tris=%d hash=%llu\n", op, (double)volume, nv, nt, (unsigned long long)h.h);
    Mesh_Destroy(g_lib, mesh);
}

// Same TPMS the JS suite uses; C++ on both sides so the comparison isolates the
// ENGINE, not the trampoline (the JS-callback path is covered by Tier-2).
static float gyroidSdf(const PKVector3* p) {
    const float s = 2.0f * 3.14159265358979f / 10.0f;
    const float g = sinf(p->X * s) * cosf(p->Y * s)
                  + sinf(p->Y * s) * cosf(p->Z * s)
                  + sinf(p->Z * s) * cosf(p->X * s);
    return fabsf(g) - 0.4f;
}

int main(int argc, char** argv) {
    const float voxel = argc > 1 ? (float)atof(argv[1]) : 0.5f;
    g_lib = Library_hCreateInstance(voxel);

    const PKVector3 origin{0, 0, 0};
    PKVOXELS sphere = Voxels_hCreateSphere(g_lib, &origin, 10.f);
    report("sphere", sphere);

    const PKVector3 a{-12, 0, 0}, b{12, 0, 0};
    PKVOXELS capsule = Voxels_hCreateCapsule(g_lib, &a, &b, 4.f, 4.f);
    report("capsule", capsule);

    PKVOXELS boolean = Voxels_hCreateCopy(g_lib, sphere);
    Voxels_BoolAdd(g_lib, boolean, capsule);
    report("union", boolean);
    const PKVector3 up{0, 0, 6};
    PKVOXELS bite = Voxels_hCreateSphere(g_lib, &up, 5.f);
    Voxels_BoolSubtract(g_lib, boolean, bite);
    report("subtract", boolean);
    PKVOXELS overlap = Voxels_hCreateCopy(g_lib, sphere);
    Voxels_BoolIntersect(g_lib, overlap, capsule);
    report("intersect", overlap);

    PKVOXELS offset = Voxels_hCreateCopy(g_lib, sphere);
    Voxels_Offset(g_lib, offset, 2.f);
    report("offset+2", offset);
    PKVOXELS closing = Voxels_hCreateCopy(g_lib, sphere);
    Voxels_DoubleOffset(g_lib, closing, 2.f, -2.f);
    report("doubleOffset", closing);
    PKVOXELS triple = Voxels_hCreateCopy(g_lib, sphere);
    Voxels_TripleOffset(g_lib, triple, 1.f);
    report("tripleOffset", triple);

    PKVOXELS gyroid = Voxels_hCreate(g_lib);
    const PKBBox3 box{{-12, -12, -12}, {12, 12, 12}};
    Voxels_RenderImplicit(g_lib, gyroid, &box, gyroidSdf);
    report("implicit", gyroid);

    PKLATTICE lattice = Lattice_hCreate(g_lib);
    Lattice_AddBeam(g_lib, lattice, &a, &b, 2.f, 2.f, true);
    Lattice_AddSphere(g_lib, lattice, &up, 3.f);
    PKVOXELS rendered = Voxels_hCreate(g_lib);
    Voxels_RenderLattice(g_lib, rendered, lattice);
    report("lattice", rendered);

    PKMESH sphereMesh = Mesh_hCreateFromVoxels(g_lib, sphere);
    PKVOXELS shell = Voxels_hCreateMeshShell(g_lib, sphereMesh, voxel);
    report("meshShell", shell);
    Mesh_Destroy(g_lib, sphereMesh);

    // Query results are geometry too — print them exactly.
    const PKVector3 rayFrom{-50, 0, 0}, rayDir{1, 0, 0}, probe{30, 0, 0};
    PKVector3 hit{}, closest{};
    const bool didHit = Voxels_bRayCastToSurface(g_lib, sphere, &rayFrom, &rayDir, &hit);
    const bool didFind = Voxels_bClosestPointOnSurface(g_lib, sphere, &probe, &closest);
    printf("raycast        hit=%d p=(%a,%a,%a)\n", didHit ? 1 : 0, (double)hit.X, (double)hit.Y, (double)hit.Z);
    printf("closestPoint   ok=%d p=(%a,%a,%a)\n", didFind ? 1 : 0, (double)closest.X, (double)closest.Y, (double)closest.Z);

    for (PKVOXELS v : {sphere, capsule, boolean, bite, overlap, offset, closing, triple, gyroid, rendered, shell})
        Voxels_Destroy(g_lib, v);
    Lattice_Destroy(g_lib, lattice);
    Library_DestroyInstance(g_lib);
    printf("RESULT=OK\n");
    return 0;
}
