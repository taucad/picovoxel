// Numeric check for picogkruntime-roundcone-nested-spheres.patch: the sampled
// volume of round-capped beams whose end spheres nest, against the closed form.
//
// Build against a PicoGKRuntime checkout (run once before and once after
// applying the patch); imgui.h is stubbed because PicoGKTypes.h uses it only for
// a viewer colour helper:
//
//   mkdir -p inc && cp Source/PicoGKLattice.h Source/PicoGKTypes.h inc/
//   printf 'struct ImVec4 { float x, y, z, w; ImVec4(float a, float b, float c, float d) : x(a), y(b), z(c), w(d) {} };\n' > inc/imgui.h
//   clang++ -std=c++17 -O2 -Iinc -o roundcone-check picogkruntime-roundcone-nested-spheres-check.cpp && ./roundcone-check
#include "PicoGKLattice.h"
#include <cstdio>
#include <cmath>
using namespace PicoGK;
struct Probe : LatticeBeam {
    using LatticeBeam::LatticeBeam;
    float sd(const Vector3& p) const { return fSdValue(p); }
};
static double volume(const Probe& o, float h, float ext) {
    long n = 0; int m = (int)(2 * ext / h);
    for (int i = 0; i < m; i++) for (int j = 0; j < m; j++) for (int k = 0; k < m; k++) {
        Vector3 p(-ext + (i + 0.5f) * h, -ext + (j + 0.5f) * h, -ext + (k + 0.5f) * h);
        if (o.sd(p) < 0) n++;
    }
    return n * (double)h * h * h;
}
int main() {
    const double pi = 3.14159265358979;
    // nested: r 6 -> 1, length 2 (the documented case); larger sphere at a
    Probe nested(Vector3(0, 0, 0), Vector3(2, 0, 0), 6.0f, 1.0f, true);
    // nested, larger sphere at b
    Probe nestedB(Vector3(0, 0, 0), Vector3(2, 0, 0), 1.0f, 6.0f, true);
    // non-nested control: r 3 -> 1, length 6 (formula path unchanged)
    Probe tapered(Vector3(-3, 0, 0), Vector3(3, 0, 0), 3.0f, 1.0f, true);
    const double vBall = 4.0 / 3.0 * pi * 216.0;
    printf("nested a: %.2f mm3 (closed form %.2f, %+.2f%%)\n", volume(nested, 0.05f, 9), vBall, 100 * (volume(nested, 0.05f, 9) / vBall - 1));
    printf("nested b: %.2f mm3 (closed form %.2f)\n", volume(nestedB, 0.05f, 9), vBall);
    printf("tapered : %.4f mm3\n", volume(tapered, 0.05f, 7));
    printf("sd at centre of nested a: %.4f (expect -6)\n", nested.sd(Vector3(0, 0, 0)));
    return 0;
}
