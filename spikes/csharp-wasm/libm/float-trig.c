// Float trigonometry through the double functions, for both builds of the spike.
//
// .NET's MathF.Sin and friends call the platform C library's sinf: glibc natively, the
// Emscripten musl port in wasm. The two disagree in the last bit for about 1 in 150
// inputs, which moves vertices in programs that use MathF trigonometry (the double
// functions already agree; see `gyroid-native 0.5 1 math`). Linked into the wasm module
// and LD_PRELOADed natively, this file gives both sides the same float functions:
// (float)f((double)x), which is correctly rounded except in rare double-rounding cases.
#include <math.h>

float sinf(float x) { return (float)sin((double)x); }
float cosf(float x) { return (float)cos((double)x); }
float tanf(float x) { return (float)tan((double)x); }
float asinf(float x) { return (float)asin((double)x); }
float acosf(float x) { return (float)acos((double)x); }
float atanf(float x) { return (float)atan((double)x); }
float atan2f(float y, float x) { return (float)atan2((double)y, (double)x); }
