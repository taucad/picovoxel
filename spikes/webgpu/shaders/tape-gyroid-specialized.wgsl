// P2 V2: checked-in specialization input:
// abs(sin(x*s)*cos(y*s) + sin(y*s)*cos(z*s) + sin(z*s)*cos(x*s)) - threshold
// This file is generated/reviewed offline; no shader source is built at runtime.

override WORKGROUP_SIZE: u32 = 64u;

struct Slab {
  originX: i32,
  originY: i32,
  originZ: i32,
  minX: i32,
  minY: i32,
  minZ: i32,
  maxX: i32,
  maxY: i32,
  maxZ: i32,
}

struct Params {
  elementCount: u32,
  slabCount: u32,
  variant: u32,
  _padding0: u32,
  voxelSize: f32,
  background: f32,
  scale: f32,
  threshold: f32,
}

@group(0) @binding(0) var<storage, read> slabs: array<Slab>;
@group(0) @binding(1) var<storage, read_write> outputValues: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

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

  let slab = slabs[linearIndex >> 9u];
  let local = linearIndex & 511u;
  let coordinate = vec3<i32>(
    slab.originX + i32(local >> 6u),
    slab.originY + i32((local >> 3u) & 7u),
    slab.originZ + i32(local & 7u),
  );
  if (
    any(coordinate < vec3<i32>(slab.minX, slab.minY, slab.minZ)) ||
    any(coordinate > vec3<i32>(slab.maxX, slab.maxY, slab.maxZ))
  ) {
    outputValues[linearIndex] = params.background;
    return;
  }

  let point = vec3<f32>(coordinate) * params.voxelSize * params.scale;
  let field =
    sin(point.x) * cos(point.y) +
    sin(point.y) * cos(point.z) +
    sin(point.z) * cos(point.x);
  outputValues[linearIndex] = abs(field) - params.threshold;
}
