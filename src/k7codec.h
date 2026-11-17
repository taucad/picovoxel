// Park-frame codec for OpenVDB float leaf buffers (src/pico-park.cpp).
//
// A block is a run of leaves. Each leaf is 512 floats plus its 512-bit value
// mask; the mask is topology, given to both the encoder and the decoder and never
// part of the payload. Encode: compact (active floats plus an inactive-sign mask,
// lossless for any leaf: a leaf with other inactive values is kept whole) ->
// byte shuffle -> codec (none or LZ4). Park images are process-local scratch,
// not an interchange format, so the layout makes no stability promise.
#ifndef K7CODEC_H
#define K7CODEC_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/** The one transform: compact + byte shuffle (stride 4). */
enum { K7T_COMPACT_SHUF = 4 };
enum { K7C_NONE = 0, K7C_LZ4 = 1 /* level = acceleration, 1 default */ };

typedef struct K7Ctx K7Ctx;
K7Ctx* k7_create(uint32_t maxLeaves);
void   k7_destroy(K7Ctx*);
/** 0 ok; -1 for a transform or codec this build does not have. */
int    k7_config(K7Ctx*, int transform, int codec, int level, float background);
size_t k7_bound(const K7Ctx*, uint32_t leaves);

void   k7_begin(K7Ctx*);
void   k7_add_leaf(K7Ctx*, const uint64_t* mask8, const float* values512);
size_t k7_finish(K7Ctx*, uint8_t* dst, size_t cap);          // 0 on failure

/** Every decode step checks its input against what the block holds: 0 ok, -1 corrupt. */
int    k7_decode_begin(K7Ctx*, const uint8_t* src, size_t n);
int    k7_next_leaf(K7Ctx*, const uint64_t* mask8, float* values512);
/** 0 when the block was consumed exactly. */
int    k7_decode_end(const K7Ctx*);

// Plain byte ranges (topology streams) through the configured codec.
size_t k7_bytes_bound(const K7Ctx*, size_t n);
size_t k7_bytes_compress(K7Ctx*, const uint8_t* src, size_t n, uint8_t* dst, size_t cap);
size_t k7_bytes_decompress(K7Ctx*, const uint8_t* src, size_t n, uint8_t* dst, size_t cap);

#ifdef __cplusplus
}
#endif
#endif
