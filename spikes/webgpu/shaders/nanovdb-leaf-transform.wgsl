// NanoVDB FloatGrid leaf-value transform.
//
// The layout constants are from NanoVDB 32.8 PNanoVDB.h. The storage binding
// may be a 256-byte-aligned slice of a larger grid; params.leafOffsetBytes is
// relative to that binding, which is how the host chunks grids past the
// storage-binding limit without rewriting the format.

override WORKGROUP_SIZE: u32 = 64u;

struct Params {
  elementCount: u32,
  leafOffsetBytes: u32,
  leafStrideBytes: u32,
  operation: u32,
  operand: f32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

@group(0) @binding(0) var<storage, read_write> nanovdbBuffer: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;

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

  let leafIndex = linearIndex >> 9u;
  let voxelIndex = linearIndex & 511u;
  let leafByteOffset =
    params.leafOffsetBytes + leafIndex * params.leafStrideBytes;
  let maskWord = nanovdbBuffer[
    (leafByteOffset + 16u + 4u * (voxelIndex >> 5u)) >> 2u
  ];
  if (((maskWord >> (voxelIndex & 31u)) & 1u) == 0u) {
    return;
  }

  let valueWord = (leafByteOffset + 96u + 4u * voxelIndex) >> 2u;
  let value = bitcast<f32>(nanovdbBuffer[valueWord]);
  let transformed =
    select(
      select(value, value * params.operand, params.operation == 1u),
      value + params.operand,
      params.operation == 2u,
    );
  nanovdbBuffer[valueWord] = bitcast<u32>(transformed);
}
