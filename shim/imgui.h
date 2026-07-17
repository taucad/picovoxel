#pragma once
// PicoGK core's ENTIRE ImGui dependency is ColorFloat::sToImVec4 (PicoGKTypes.h:67-70),
// which needs nothing but a 4-float aggregate. Satisfying it here keeps the upstream
// tree unpatched — no viewer, no GLFW, no real ImGui in the headless wasm build.
struct ImVec4 {
    float x, y, z, w;
    ImVec4() : x(0), y(0), z(0), w(0) {}
    ImVec4(float _x, float _y, float _z, float _w) : x(_x), y(_y), z(_z), w(_w) {}
};
