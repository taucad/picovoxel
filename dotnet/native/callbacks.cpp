// SPDX-License-Identifier: Apache-2.0
// Context bridge for the four synchronous PicoGK callback operations. These
// operations invoke callbacks on the calling thread; parallel/tape operations
// do not use this bridge. Each nested call restores the previous thread state.
#include "PicoGK.h"
#include <cstdint>

namespace {
using Sdf = int32_t (*)(void*, const PKVector3*, float*);
using Scalar = int32_t (*)(void*, const PKVector3*, float);
using Vector = int32_t (*)(void*, const PKVector3*, const PKVector3*);
struct Frame { void* context; Sdf sdf; Scalar scalar; Vector vector; };
thread_local Frame* current = nullptr;
struct CallbackError {};
struct Scope {
    Frame* previous;
    explicit Scope(Frame& frame) : previous(current) { current = &frame; }
    ~Scope() { current = previous; }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
};
float sdf(const PKVector3* p) {
    float value = 0;
    if (current->sdf(current->context, p, &value) != 0) throw CallbackError{};
    return value;
}
void scalar(const PKVector3* p, float value) {
    if (current->scalar(current->context, p, value) != 0) throw CallbackError{};
}
void vector(const PKVector3* p, const PKVector3* value) {
    if (current->vector(current->context, p, value) != 0) throw CallbackError{};
}
template <typename Operation> int32_t invoke(Frame& frame, Operation operation) noexcept {
    Scope scope(frame);
    try { operation(); return 0; }
    catch (const CallbackError&) { return 1; }
    catch (...) { return 2; }
}
}

PICOGK_API int32_t PicoDotNet_RenderImplicit(PKINSTANCE lib, PKVOXELS vox,
    const PKBBox3* bounds, void* context, Sdf callback) noexcept {
    if (!context || !callback || !bounds) return 3;
    Frame frame{context, callback, nullptr, nullptr};
    return invoke(frame, [&] { Voxels_RenderImplicit(lib, vox, bounds, sdf); });
}
PICOGK_API int32_t PicoDotNet_IntersectImplicit(PKINSTANCE lib, PKVOXELS vox,
    void* context, Sdf callback) noexcept {
    if (!context || !callback) return 3;
    Frame frame{context, callback, nullptr, nullptr};
    return invoke(frame, [&] { Voxels_IntersectImplicit(lib, vox, sdf); });
}
PICOGK_API int32_t PicoDotNet_TraverseScalar(PKINSTANCE lib, PKSCALARFIELD field,
    void* context, Scalar callback) noexcept {
    if (!context || !callback) return 3;
    Frame frame{context, nullptr, callback, nullptr};
    return invoke(frame, [&] { ScalarField_TraverseActive(lib, field, scalar); });
}
PICOGK_API int32_t PicoDotNet_TraverseVector(PKINSTANCE lib, PKVECTORFIELD field,
    void* context, Vector callback) noexcept {
    if (!context || !callback) return 3;
    Frame frame{context, nullptr, nullptr, callback};
    return invoke(frame, [&] { VectorField_TraverseActive(lib, field, vector); });
}
