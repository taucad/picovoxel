// R20 — the in-binary SDF baseline: RenderImplicit with a compiled C++ gyroid,
// timed. The JS side (r20-sdf-cost.mjs) runs the identical field through the
// addFunction trampoline; the difference divided by the sample count is the
// per-sample cost of crossing the wasm→JS boundary.

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

#pragma pack(1)
struct PKVector3 { float X, Y, Z; };
struct PKBBox3 { PKVector3 vecMin, vecMax; };
#pragma pack()

using PKINSTANCE = uint64_t;
using PKVOXELS = uint64_t;
using PKPFnfSdf = float (*)(const PKVector3*);

extern "C" {
PKINSTANCE Library_hCreateInstance(float);
void       Library_DestroyInstance(PKINSTANCE);
PKVOXELS   Voxels_hCreate(PKINSTANCE);
void       Voxels_RenderImplicit(PKINSTANCE, PKVOXELS, const PKBBox3*, PKPFnfSdf);
float      Voxels_fCalculateVolume(PKINSTANCE, PKVOXELS);
void       Voxels_Destroy(PKINSTANCE, PKVOXELS);
}

static uint64_t g_samples = 0;

static float gyroidSdf(const PKVector3* p) {
    ++g_samples; // same counter the JS side keeps, so overhead parity is fair
    const float s = 2.0f * 3.14159265358979f / 10.0f;
    const float g = sinf(p->X * s) * cosf(p->Y * s)
                  + sinf(p->Y * s) * cosf(p->Z * s)
                  + sinf(p->Z * s) * cosf(p->X * s);
    return fabsf(g) - 0.4f;
}

int main(int argc, char** argv) {
    const float voxel = argc > 1 ? (float)atof(argv[1]) : 0.5f;
    PKINSTANCE lib = Library_hCreateInstance(voxel);
    const PKBBox3 box{{-12, -12, -12}, {12, 12, 12}};

    for (int run = 0; run < 3; run++) {
        g_samples = 0;
        PKVOXELS v = Voxels_hCreate(lib);
        const auto t0 = std::chrono::steady_clock::now();
        Voxels_RenderImplicit(lib, v, &box, gyroidSdf);
        const double ms = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - t0).count();
        printf("cpp-sdf voxel=%.3f run=%d samples=%llu vol=%a %.1fms\n",
               voxel, run, (unsigned long long)g_samples,
               (double)Voxels_fCalculateVolume(lib, v), ms);
        Voxels_Destroy(lib, v);
    }
    Library_DestroyInstance(lib);
    return 0;
}
