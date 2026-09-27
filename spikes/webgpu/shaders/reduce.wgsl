override WORKGROUP_SIZE: u32 = 64u;

struct Params {
  elementCount: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

@group(0) @binding(0) var<storage, read> inputValues: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputValues: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> partial: array<f32, WORKGROUP_SIZE>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(num_workgroups) workgroupCount: vec3<u32>,
) {
  let linearIndex =
    globalId.x + globalId.y * workgroupCount.x * WORKGROUP_SIZE;
  let linearWorkgroup =
    workgroupId.x + workgroupId.y * workgroupCount.x;
  var value = 0.0;
  if (linearIndex >= params.elementCount) {
    value = 0.0;
  } else {
    value = inputValues[linearIndex];
  }
  partial[localId.x] = value;
  workgroupBarrier();

  var stride = WORKGROUP_SIZE / 2u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (localId.x < stride) {
      partial[localId.x] += partial[localId.x + stride];
    }
    workgroupBarrier();
    stride /= 2u;
  }

  if (localId.x == 0u) {
    outputValues[linearWorkgroup] = partial[0];
  }
}
