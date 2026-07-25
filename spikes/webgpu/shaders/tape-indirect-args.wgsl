// P2 V4 mechanics probe: GPU-generated two-dimensional indirect dispatch args.

override WORKGROUP_SIZE: u32 = 1u;

struct Params {
  elementCount: u32,
  evaluatedElementCount: u32,
  evalWorkgroupSize: u32,
  maxWorkgroupsPerDimension: u32,
}

@group(0) @binding(0) var<storage, read_write> indirectArguments: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let linearIndex = globalId.x;
  if (linearIndex >= params.elementCount) {
    return;
  }
  let workgroups =
    (params.evaluatedElementCount + params.evalWorkgroupSize - 1u) /
    params.evalWorkgroupSize;
  let dispatchX = min(workgroups, params.maxWorkgroupsPerDimension);
  indirectArguments[0] = dispatchX;
  indirectArguments[1] = (workgroups + dispatchX - 1u) / dispatchX;
  indirectArguments[2] = 1u;
}
