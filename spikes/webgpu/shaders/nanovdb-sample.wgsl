// Float-only PNanoVDB reader and trilinear sampler for P1.
//
// Derived from Edward McFarlane's WGSL port of PNanoVDB.h.
// Original work: Copyright Contributors to the OpenVDB Project
// SPDX-License-Identifier: Apache-2.0
//
// Unlike the prior port, every address and signed relative child offset stays
// as a two-word integer. add64 performs explicit low-word carry; truncation to
// a WebGPU array index happens only after the final address is known to lie in
// the negotiated (<4 GiB) binding.

override WORKGROUP_SIZE: u32 = 64u;

alias Address64 = vec2<u32>;

struct Params {
  elementCount: u32,
  bufferByteLength: u32,
  _padding0: vec2<u32>,
}

struct RootTile {
  address: Address64,
  found: u32,
}

@group(0) @binding(0) var<storage, read> nanovdbBuffer: array<u32>;
@group(0) @binding(1) var<storage, read> samplePoints: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> sampleValues: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn add64(left: Address64, right: Address64) -> Address64 {
  let low = left.x + right.x;
  let carry = select(0u, 1u, low < left.x);
  return Address64(low, left.y + right.y + carry);
}

fn offset64(address: Address64, byteOffset: u32) -> Address64 {
  return add64(address, Address64(byteOffset, 0u));
}

fn wordIndex(address: Address64) -> u32 {
  return address.x >> 2u;
}

fn readU32(address: Address64) -> u32 {
  return nanovdbBuffer[wordIndex(address)];
}

fn readU64(address: Address64) -> Address64 {
  return Address64(readU32(address), readU32(offset64(address, 4u)));
}

fn readF32(address: Address64) -> f32 {
  return bitcast<f32>(readU32(address));
}

fn equal64(left: Address64, right: Address64) -> bool {
  return all(left == right);
}

fn isZero64(value: Address64) -> bool {
  return all(value == Address64(0u));
}

fn treeRoot() -> Address64 {
  let tree = Address64(672u, 0u);
  return add64(tree, readU64(offset64(tree, 24u)));
}

fn coordinateKey(ijk: vec3<i32>) -> Address64 {
  let i = u32(ijk.x) >> 12u;
  let j = u32(ijk.y) >> 12u;
  let k = u32(ijk.z) >> 12u;
  return Address64(k | (j << 21u), (i << 10u) | (j >> 11u));
}

fn findRootTile(root: Address64, ijk: vec3<i32>) -> RootTile {
  let tileCount = readU32(offset64(root, 24u));
  let key = coordinateKey(ijk);
  var tile = offset64(root, 64u);
  for (var index = 0u; index < tileCount; index += 1u) {
    if (equal64(readU64(tile), key)) {
      return RootTile(tile, 1u);
    }
    tile = offset64(tile, 32u);
  }
  return RootTile(Address64(0u), 0u);
}

fn upperOffset(ijk: vec3<i32>) -> u32 {
  return
    (((u32(ijk.x) & 4095u) >> 7u) << 10u) +
    (((u32(ijk.y) & 4095u) >> 7u) << 5u) +
    ((u32(ijk.z) & 4095u) >> 7u);
}

fn lowerOffset(ijk: vec3<i32>) -> u32 {
  return
    (((u32(ijk.x) & 127u) >> 3u) << 8u) +
    (((u32(ijk.y) & 127u) >> 3u) << 4u) +
    ((u32(ijk.z) & 127u) >> 3u);
}

fn leafOffset(ijk: vec3<i32>) -> u32 {
  return
    ((u32(ijk.x) & 7u) << 6u) +
    ((u32(ijk.y) & 7u) << 3u) +
    (u32(ijk.z) & 7u);
}

fn maskBit(address: Address64, bitIndex: u32) -> bool {
  let word = readU32(offset64(address, 4u * (bitIndex >> 5u)));
  return ((word >> (bitIndex & 31u)) & 1u) != 0u;
}

fn readValue(root: Address64, ijk: vec3<i32>) -> f32 {
  let tile = findRootTile(root, ijk);
  if (tile.found == 0u) {
    return readF32(offset64(root, 28u));
  }

  let upperRelative = readU64(offset64(tile.address, 8u));
  if (isZero64(upperRelative)) {
    return readF32(offset64(tile.address, 20u));
  }
  let upper = add64(root, upperRelative);
  let upperIndex = upperOffset(ijk);
  let upperTable = offset64(upper, 8256u + 8u * upperIndex);
  if (!maskBit(offset64(upper, 4128u), upperIndex)) {
    return readF32(upperTable);
  }

  let lower = add64(upper, readU64(upperTable));
  let lowerIndex = lowerOffset(ijk);
  let lowerTable = offset64(lower, 1088u + 8u * lowerIndex);
  if (!maskBit(offset64(lower, 544u), lowerIndex)) {
    return readF32(lowerTable);
  }

  let leaf = add64(lower, readU64(lowerTable));
  return readF32(offset64(leaf, 96u + 4u * leafOffset(ijk)));
}

fn trilinear(root: Address64, point: vec3<f32>) -> f32 {
  let base = vec3<i32>(floor(point));
  let fraction = fract(point);
  let v000 = readValue(root, base);
  let v001 = readValue(root, base + vec3<i32>(0, 0, 1));
  let v010 = readValue(root, base + vec3<i32>(0, 1, 0));
  let v011 = readValue(root, base + vec3<i32>(0, 1, 1));
  let v100 = readValue(root, base + vec3<i32>(1, 0, 0));
  let v101 = readValue(root, base + vec3<i32>(1, 0, 1));
  let v110 = readValue(root, base + vec3<i32>(1, 1, 0));
  let v111 = readValue(root, base + vec3<i32>(1, 1, 1));
  let x00 = mix(v000, v100, fraction.x);
  let x01 = mix(v001, v101, fraction.x);
  let x10 = mix(v010, v110, fraction.x);
  let x11 = mix(v011, v111, fraction.x);
  return mix(mix(x00, x10, fraction.y), mix(x01, x11, fraction.y), fraction.z);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) workgroupCount: vec3<u32>,
) {
  let linearIndex =
    globalId.x + globalId.y * workgroupCount.x * WORKGROUP_SIZE;
  if (linearIndex >= params.elementCount) {
    return;
  }
  sampleValues[linearIndex] =
    trilinear(treeRoot(), samplePoints[linearIndex].xyz);
}
