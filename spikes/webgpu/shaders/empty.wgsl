override WORKGROUP_SIZE: u32 = 64u;
override ELEMENT_COUNT: u32 = 1u;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  if (globalId.x >= ELEMENT_COUNT) {
    return;
  }
}
