// Park-frame codec. See k7codec.h. LZ4 is vendor/lz4 (lz4.c), pinned by
// scripts/fetch-deps.sh; built with K7_ONLY_LZ4 there is no other codec.
#include "k7codec.h"

#include <stdlib.h>
#include <string.h>
#include <wasm_simd128.h>

#include "lz4.h"

#define LEAF 512u
#define AUX_PER_LEAF (1u + 2048u) /* worst case: tag + a whole leaf kept raw */

struct K7Ctx {
  uint32_t maxLeaves;
  int codec, level;
  float bg;
  uint32_t bgBits, negBits;
  uint8_t* vals;    // unshuffled value stream
  uint8_t* aux;     // per-leaf tags, sign masks, whole leaves
  uint8_t* payload; // [u32 valBytes][u32 auxBytes][shuffled values][aux]
  size_t payloadCap;
  size_t nval, naux;
  // decode cursors and ends
  const uint8_t* dval;
  const uint8_t* dvalEnd;
  const uint8_t* daux;
  const uint8_t* dauxEnd;
};

static inline uint32_t ld32(const void* p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline void st32(void* p, uint32_t v) { memcpy(p, &v, 4); }
static inline uint32_t f2bits(float f) { uint32_t b; memcpy(&b, &f, 4); return b; }

// ── byte shuffle (stride 4) ─────────────────────────────────────────────────
static void shuffle4(const uint8_t* src, uint8_t* dst, size_t n /* elements */) {
  uint8_t* d0 = dst; uint8_t* d1 = dst + n; uint8_t* d2 = dst + 2 * n; uint8_t* d3 = dst + 3 * n;
  size_t i = 0;
  for (; i + 16 <= n; i += 16) {
    v128_t a = wasm_v128_load(src + 4 * i), b = wasm_v128_load(src + 4 * i + 16);
    v128_t c = wasm_v128_load(src + 4 * i + 32), d = wasm_v128_load(src + 4 * i + 48);
    v128_t p0 = wasm_i8x16_shuffle(a, b, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
    v128_t p1 = wasm_i8x16_shuffle(a, b, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
    v128_t q0 = wasm_i8x16_shuffle(c, d, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
    v128_t q1 = wasm_i8x16_shuffle(c, d, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
    wasm_v128_store(d0 + i, wasm_i8x16_shuffle(p0, q0, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30));
    wasm_v128_store(d2 + i, wasm_i8x16_shuffle(p0, q0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31));
    wasm_v128_store(d1 + i, wasm_i8x16_shuffle(p1, q1, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30));
    wasm_v128_store(d3 + i, wasm_i8x16_shuffle(p1, q1, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31));
  }
  for (; i < n; i++) { d0[i] = src[4 * i]; d1[i] = src[4 * i + 1]; d2[i] = src[4 * i + 2]; d3[i] = src[4 * i + 3]; }
}
static void unshuffle4(const uint8_t* src, uint8_t* dst, size_t n) {
  const uint8_t* s0 = src; const uint8_t* s1 = src + n; const uint8_t* s2 = src + 2 * n; const uint8_t* s3 = src + 3 * n;
  size_t i = 0;
  for (; i + 16 <= n; i += 16) {
    v128_t a = wasm_v128_load(s0 + i), b = wasm_v128_load(s1 + i), c = wasm_v128_load(s2 + i), d = wasm_v128_load(s3 + i);
    v128_t lo01 = wasm_i8x16_shuffle(a, b, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23);
    v128_t hi01 = wasm_i8x16_shuffle(a, b, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31);
    v128_t lo23 = wasm_i8x16_shuffle(c, d, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23);
    v128_t hi23 = wasm_i8x16_shuffle(c, d, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31);
    wasm_v128_store(dst + 4 * i, wasm_i16x8_shuffle(lo01, lo23, 0, 8, 1, 9, 2, 10, 3, 11));
    wasm_v128_store(dst + 4 * i + 16, wasm_i16x8_shuffle(lo01, lo23, 4, 12, 5, 13, 6, 14, 7, 15));
    wasm_v128_store(dst + 4 * i + 32, wasm_i16x8_shuffle(hi01, hi23, 0, 8, 1, 9, 2, 10, 3, 11));
    wasm_v128_store(dst + 4 * i + 48, wasm_i16x8_shuffle(hi01, hi23, 4, 12, 5, 13, 6, 14, 7, 15));
  }
  for (; i < n; i++) { dst[4 * i] = s0[i]; dst[4 * i + 1] = s1[i]; dst[4 * i + 2] = s2[i]; dst[4 * i + 3] = s3[i]; }
}

// ── context ─────────────────────────────────────────────────────────────────
K7Ctx* k7_create(uint32_t maxLeaves) {
  K7Ctx* c = (K7Ctx*)calloc(1, sizeof(K7Ctx));
  if (!c) return 0;
  c->maxLeaves = maxLeaves;
  const size_t v = (size_t)maxLeaves * LEAF * 4, a = (size_t)maxLeaves * AUX_PER_LEAF;
  c->payloadCap = 8 + v + a;
  c->vals = (uint8_t*)malloc(v + 64);
  c->aux = (uint8_t*)malloc(a + 64);
  c->payload = (uint8_t*)malloc(c->payloadCap + 64);
  if (!c->vals || !c->aux || !c->payload) { k7_destroy(c); return 0; }
  k7_config(c, K7T_COMPACT_SHUF, K7C_NONE, 0, 3.0f);
  return c;
}
void k7_destroy(K7Ctx* c) {
  if (!c) return;
  free(c->vals); free(c->aux); free(c->payload);
  free(c);
}
int k7_config(K7Ctx* c, int transform, int codec, int level, float background) {
  if (transform != K7T_COMPACT_SHUF || (codec != K7C_NONE && codec != K7C_LZ4)) return -1;
  c->codec = codec; c->level = level;
  c->bg = background; c->bgBits = f2bits(background); c->negBits = f2bits(-background);
  return 0;
}

size_t k7_bytes_bound(const K7Ctx* c, size_t n) {
  return c->codec == K7C_LZ4 ? (size_t)LZ4_compressBound((int)n) : n;
}
size_t k7_bound(const K7Ctx* c, uint32_t leaves) {
  return k7_bytes_bound(c, 8 + (size_t)leaves * (LEAF * 4 + AUX_PER_LEAF));
}
size_t k7_bytes_compress(K7Ctx* c, const uint8_t* src, size_t n, uint8_t* dst, size_t cap) {
  if (c->codec == K7C_LZ4) {
    const int r = LZ4_compress_fast((const char*)src, (char*)dst, (int)n, (int)cap, c->level > 0 ? c->level : 1);
    return r > 0 ? (size_t)r : 0;
  }
  if (cap < n) return 0;
  memcpy(dst, src, n);
  return n;
}
size_t k7_bytes_decompress(K7Ctx* c, const uint8_t* src, size_t n, uint8_t* dst, size_t cap) {
  if (c->codec == K7C_LZ4) {
    const int r = LZ4_decompress_safe((const char*)src, (char*)dst, (int)n, (int)cap);
    return r > 0 ? (size_t)r : 0;
  }
  if (cap < n) return 0;
  memcpy(dst, src, n);
  return n;
}

// ── leaf classification ─────────────────────────────────────────────────────
// eqPos/eqNeg: 512-bit masks of voxels whose bits equal +background / -background.
static void classify(const float* v, uint32_t bgBits, uint32_t negBits, uint64_t* eqPos, uint64_t* eqNeg) {
  const v128_t vp = wasm_i32x4_splat((int32_t)bgBits), vn = wasm_i32x4_splat((int32_t)negBits);
  for (uint32_t w = 0; w < 8; w++) {
    uint64_t p = 0, q = 0;
    for (uint32_t k = 0; k < 16; k++) {
      v128_t x = wasm_v128_load(v + w * 64 + k * 4);
      p |= (uint64_t)wasm_i32x4_bitmask(wasm_i32x4_eq(x, vp)) << (k * 4);
      q |= (uint64_t)wasm_i32x4_bitmask(wasm_i32x4_eq(x, vn)) << (k * 4);
    }
    eqPos[w] = p; eqNeg[w] = q;
  }
}

// ── encode ──────────────────────────────────────────────────────────────────
// Leaf tags: 0 whole leaf (2048 bytes in aux), 1 mixed inactive signs (64-byte
// negative mask in aux), 2 every inactive voxel +background, 3 every one -background.
void k7_begin(K7Ctx* c) { c->nval = 0; c->naux = 0; }

void k7_add_leaf(K7Ctx* c, const uint64_t* m, const float* v) {
  uint64_t eqPos[8], eqNeg[8], neg[8];
  classify(v, c->bgBits, c->negBits, eqPos, eqNeg);
  int packable = 1, anyNeg = 0, allNeg = 1;
  for (uint32_t w = 0; w < 8; w++) {
    const uint64_t off = ~m[w];
    if (off & ~(eqPos[w] | eqNeg[w])) packable = 0;
    neg[w] = eqNeg[w] & off;
    if (neg[w]) anyNeg = 1;
    if (neg[w] != off) allNeg = 0;
  }
  uint8_t* aux = c->aux + c->naux;
  if (!packable) {
    *aux = 0;
    memcpy(aux + 1, v, LEAF * 4);
    c->naux += 1 + LEAF * 4;
    return;
  }
  if (!anyNeg) { *aux = 2; c->naux += 1; }
  else if (allNeg) { *aux = 3; c->naux += 1; }
  else { *aux = 1; memcpy(aux + 1, neg, 64); c->naux += 65; }

  uint8_t* out = c->vals + c->nval;
  uint32_t k = 0;
  for (uint32_t w = 0; w < 8; w++) {
    uint64_t bits = m[w];
    if (bits == ~(uint64_t)0) { memcpy(out + 4 * k, v + w * 64, 256); k += 64; continue; }
    while (bits) {
      const uint32_t i = w * 64 + (uint32_t)__builtin_ctzll(bits);
      bits &= bits - 1;
      memcpy(out + 4 * k, v + i, 4);
      k++;
    }
  }
  c->nval += (size_t)k * 4;
}

size_t k7_finish(K7Ctx* c, uint8_t* dst, size_t cap) {
  uint8_t* p = c->payload;
  st32(p, (uint32_t)c->nval); st32(p + 4, (uint32_t)c->naux);
  shuffle4(c->vals, p + 8, c->nval / 4);
  memcpy(p + 8 + c->nval, c->aux, c->naux);
  return k7_bytes_compress(c, p, 8 + c->nval + c->naux, dst, cap);
}

// ── decode ──────────────────────────────────────────────────────────────────
int k7_decode_begin(K7Ctx* c, const uint8_t* src, size_t n) {
  const uint8_t* p;
  size_t length;
  if (c->codec == K7C_NONE) {
    p = src;
    length = n;
  } else {
    length = k7_bytes_decompress(c, src, n, c->payload, c->payloadCap);
    if (length == 0) return -1;
    p = c->payload;
  }
  if (length < 8) return -1;
  const size_t nval = ld32(p), naux = ld32(p + 4);
  if (nval % 4 != 0 || nval > (size_t)c->maxLeaves * LEAF * 4 || naux > (size_t)c->maxLeaves * AUX_PER_LEAF ||
      8 + nval + naux != length)
    return -1;
  unshuffle4(p + 8, c->vals, nval / 4);
  c->dval = c->vals;
  c->dvalEnd = c->vals + nval;
  c->daux = p + 8 + nval;
  c->dauxEnd = c->daux + naux;
  return 0;
}

static inline uint32_t popcount8(const uint64_t* m) {
  uint32_t n = 0;
  for (uint32_t w = 0; w < 8; w++) n += (uint32_t)__builtin_popcountll(m[w]);
  return n;
}

int k7_next_leaf(K7Ctx* c, const uint64_t* m, float* v) {
  if (c->daux >= c->dauxEnd) return -1;
  const uint8_t tag = *c->daux++;
  if (tag == 0) {
    if ((size_t)(c->dauxEnd - c->daux) < LEAF * 4) return -1;
    memcpy(v, c->daux, LEAF * 4);
    c->daux += LEAF * 4;
    return 0;
  }
  if (tag > 3) return -1;
  const size_t need = (size_t)popcount8(m) * 4;
  if ((size_t)(c->dvalEnd - c->dval) < need || (tag == 1 && (size_t)(c->dauxEnd - c->daux) < 64)) return -1;
  const v128_t vb = wasm_f32x4_splat(tag == 3 ? -c->bg : c->bg);
  for (uint32_t i = 0; i < LEAF; i += 4) wasm_v128_store(v + i, vb);
  if (tag == 1) {
    uint64_t neg[8];
    memcpy(neg, c->daux, 64);
    c->daux += 64;
    const float nb = -c->bg;
    for (uint32_t w = 0; w < 8; w++) {
      uint64_t bits = neg[w];
      while (bits) { v[w * 64 + (uint32_t)__builtin_ctzll(bits)] = nb; bits &= bits - 1; }
    }
  }
  const uint8_t* in = c->dval;
  uint32_t k = 0;
  for (uint32_t w = 0; w < 8; w++) {
    uint64_t bits = m[w];
    if (bits == ~(uint64_t)0) { memcpy(v + w * 64, in + 4 * k, 256); k += 64; continue; }
    while (bits) {
      const uint32_t i = w * 64 + (uint32_t)__builtin_ctzll(bits);
      bits &= bits - 1;
      memcpy(v + i, in + 4 * k, 4);
      k++;
    }
  }
  c->dval += need;
  return 0;
}

int k7_decode_end(const K7Ctx* c) {
  return c->dval == c->dvalEnd && c->daux == c->dauxEnd ? 0 : -1;
}
