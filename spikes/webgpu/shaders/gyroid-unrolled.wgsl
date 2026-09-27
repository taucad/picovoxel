override WORKGROUP_SIZE: u32 = 64u;

struct Params {
  elementCount: u32,
  width: u32,
  height: u32,
  _padding0: u32,
  originX: f32,
  originY: f32,
  originZ: f32,
  spacing: f32,
  scale: f32,
  threshold: f32,
  _padding1: f32,
  _padding2: f32,
}

@group(0) @binding(0) var<storage, read_write> outputValues: array<f32>;
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

  let plane = params.width * params.height;
  let xIndex = linearIndex % params.width;
  let yIndex = (linearIndex / params.width) % params.height;
  let zIndex = linearIndex / plane;
  let x = params.originX + f32(xIndex) * params.spacing;
  let y = params.originY + f32(yIndex) * params.spacing;
  let z = params.originZ + f32(zIndex) * params.spacing;
  let scaledX = x * params.scale;
  let scaledY = y * params.scale;
  let scaledZ = z * params.scale;
  let field =
    sin(scaledX) * cos(scaledY) +
    sin(scaledY) * cos(scaledZ) +
    sin(scaledZ) * cos(scaledX);
  outputValues[linearIndex] = abs(field) - params.threshold;
}
