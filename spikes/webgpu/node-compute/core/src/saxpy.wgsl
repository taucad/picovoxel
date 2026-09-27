struct Params {
  alpha: f32,
  element_count: u32,
  _padding: vec2<u32>,
}

@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> y: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.element_count) {
    return;
  }

  output[id.x] = params.alpha * x[id.x] + y[id.x];
}
