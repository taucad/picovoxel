// OpenVDB wasm-vs-native: parity + cost. Same source both targets.
// argv[1] = voxel size mm (default 0.5), argv[2] = native thread cap (ignored under wasm).

#include <openvdb/openvdb.h>
#include <openvdb/tools/Composite.h>
#include <openvdb/tools/LevelSetSphere.h>
#include <openvdb/tools/VolumeToMesh.h>

#ifndef __EMSCRIPTEN__
#include <tbb/global_control.h>
#endif

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <vector>

struct Hasher {
    uint64_t h = 1469598103934665603ULL;
    void add(const void* p, size_t n) {
        const uint8_t* b = static_cast<const uint8_t*>(p);
        for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
    }
};

static double ms_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

int main(int argc, char** argv) {
    const float voxel = argc > 1 ? atof(argv[1]) : 0.5f;
    const int threads = argc > 2 ? atoi(argv[2]) : 0;

#ifndef __EMSCRIPTEN__
    std::unique_ptr<tbb::global_control> gc;
    if (threads > 0)
        gc = std::make_unique<tbb::global_control>(tbb::global_control::max_allowed_parallelism, threads);
#endif

    openvdb::initialize();

    auto t0 = std::chrono::steady_clock::now();

    // sphere ∪ sphere − sphere: the same CSG shape R2/R3 used, driven straight at OpenVDB.
    auto a = openvdb::tools::createLevelSetSphere<openvdb::FloatGrid>(20.f, openvdb::Vec3f(0, 0, 0), voxel);
    auto b = openvdb::tools::createLevelSetSphere<openvdb::FloatGrid>(12.f, openvdb::Vec3f(14, 0, 0), voxel);
    auto c = openvdb::tools::createLevelSetSphere<openvdb::FloatGrid>(9.f, openvdb::Vec3f(0, 0, 12), voxel);
    const double tBuild = ms_since(t0);

    auto t1 = std::chrono::steady_clock::now();
    openvdb::tools::csgUnion(*a, *b);
    openvdb::tools::csgDifference(*a, *c);
    const double tCsg = ms_since(t1);

    auto t2 = std::chrono::steady_clock::now();
    std::vector<openvdb::Vec3s> points;
    std::vector<openvdb::Vec3I> tris;
    std::vector<openvdb::Vec4I> quads;
    openvdb::tools::volumeToMesh(*a, points, tris, quads, 0.0);
    const double tMesh = ms_since(t2);
    const double tAll = ms_since(t0);

    Hasher h;
    h.add(points.data(), points.size() * sizeof(openvdb::Vec3s));
    h.add(tris.data(), tris.size() * sizeof(openvdb::Vec3I));
    h.add(quads.data(), quads.size() * sizeof(openvdb::Vec4I));

    printf("voxel=%.3f threads=%d active=%llu pts=%zu quads=%zu hash=%llu "
           "build=%.0fms csg=%.0fms mesh=%.0fms total=%.0fms\n",
           voxel, threads, (unsigned long long)a->activeVoxelCount(), points.size(), quads.size(),
           (unsigned long long)h.h, tBuild, tCsg, tMesh, tAll);
    return 0;
}
