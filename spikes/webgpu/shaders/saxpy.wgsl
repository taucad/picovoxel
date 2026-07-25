override WORKGROUP_SIZE: u32 = 64u;

struct Params {
  coefficient: f32,
  elementCount: u32,
  _padding0: u32,
  _padding1: u32,
}

@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read_write> yValues: array<f32>;
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
  yValues[linearIndex] =
    params.coefficient * xValues[linearIndex] + yValues[linearIndex];
}
