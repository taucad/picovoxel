// P2 V1: static, general PicoGK SDF-tape interpreter.

override WORKGROUP_SIZE: u32 = 64u;
const REGISTER_CAP: u32 = 64u;

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
  tapeCount: u32,
  slabCount: u32,
  variant: u32,
  voxelSize: f32,
  background: f32,
  _padding0: vec2<u32>,
}

@group(0) @binding(0) var<storage, read> slabs: array<Slab>;
@group(0) @binding(1) var<storage, read> tape: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> constants: array<f32>;
@group(0) @binding(3) var<storage, read_write> outputValues: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

fn evaluateTape(position: vec3<f32>) -> f32 {
  var registers: array<f32, 64>;
  for (var index = 0u; index < params.tapeCount; index += 1u) {
    let instruction = tape[index];
    let operandA = instruction.y & 0xffffu;
    let operandB = instruction.y >> 16u;
    var value = 0.0;
    switch instruction.x {
      case 0u: { value = constants[operandA]; }
      case 1u: { value = position.x; }
      case 2u: { value = position.y; }
      case 3u: { value = position.z; }
      case 4u: { value = registers[operandA] + registers[operandB]; }
      case 5u: { value = registers[operandA] - registers[operandB]; }
      case 6u: { value = registers[operandA] * registers[operandB]; }
      case 7u: { value = registers[operandA] / registers[operandB]; }
      case 8u: { value = -registers[operandA]; }
      case 9u: { value = abs(registers[operandA]); }
      case 10u: { value = sqrt(registers[operandA]); }
      case 11u: { value = sin(registers[operandA]); }
      case 12u: { value = cos(registers[operandA]); }
      case 13u: { value = floor(registers[operandA]); }
      case 14u: {
        let left = registers[operandA];
        let right = registers[operandB];
        value = left - right * floor(left / right);
      }
      case 15u: { value = min(registers[operandA], registers[operandB]); }
      case 16u: { value = max(registers[operandA], registers[operandB]); }
      case 17u: { value = pow(registers[operandA], registers[operandB]); }
      case 18u: { value = exp(registers[operandA]); }
      case 19u: { value = log(registers[operandA]); }
      default: { value = 0.0; }
    }
    registers[index] = value;
  }
  return registers[params.tapeCount - 1u];
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
  outputValues[linearIndex] =
    evaluateTape(vec3<f32>(coordinate) * params.voxelSize);
}
