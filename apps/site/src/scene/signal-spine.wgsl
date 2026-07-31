struct Particle {
  position: vec4f,
  velocity: vec4f,
}

struct Uniforms {
  frame: vec4f,
  scene: vec4f,
  pointer: vec4f,
  camera: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

const TAU: f32 = 6.28318530718;

fn hash11(value: f32) -> f32 {
  return fract(sin(value * 127.1) * 43758.5453123);
}

fn signal_pop(index: u32, time: f32) -> f32 {
  let group = floor(f32(index) / 24.0);
  let phase = fract(time * 0.065 + hash11(group * 1.913));
  return smoothstep(0.925, 0.955, phase) * (1.0 - smoothstep(0.955, 1.0, phase));
}

fn signal_lattice(index: u32, count: u32, time: f32) -> vec3f {
  let columns = 64u;
  let column = f32(index % columns);
  let row = f32(index / columns);
  let rows = ceil(f32(count) / f32(columns));
  let x = (column - 31.5) * 0.145;
  let y = (row - rows * 0.5) * 0.054;
  let wave = sin(column * 0.31 + time * 0.42) * 0.16 + cos(row * 0.17 - time * 0.3) * 0.11;
  return vec3f(x, y, wave + sin((x + y) * 0.7) * 0.22);
}

fn ingestion_funnel(index: u32, _count: u32, time: f32) -> vec3f {
  let seed = hash11(f32(index) * 0.731);
  let lane = f32(index % 7u);
  let speed = 0.035 + hash11(f32(index % 37u)) * 0.028;
  let u = fract(seed + time * speed);
  let radius = mix(4.5, 0.42, pow(u, 0.72));
  let angle = u * TAU * 2.8 + lane * 0.39;
  return vec3f(cos(angle) * radius, 4.3 - u * 8.6, sin(angle) * radius * 0.52);
}

fn context_stack(index: u32, _count: u32, time: f32) -> vec3f {
  let slot = f32(index % 256u) / 256.0;
  let ring = f32((index / 256u) % 21u);
  let speed = 0.055 + hash11(ring * 4.7) * 0.035;
  let angle = slot * TAU + time * speed * select(-1.0, 1.0, u32(ring) % 2u == 0u);
  let radius = 2.35 + f32(u32(ring) % 3u) * 0.22;
  return vec3f(cos(angle) * radius, (ring - 10.0) * 0.39, sin(angle) * radius);
}

fn agent_routes(index: u32, _count: u32, time: f32) -> vec3f {
  let seed = hash11(f32(index) * 1.371);
  let branch = f32(index % 5u) - 2.0;
  let speed = 0.048 + hash11(f32(index % 43u)) * 0.03;
  let u = fract(seed + time * speed);
  let split = smoothstep(0.24, 0.62, u);
  let x = branch * 1.48 * pow(split, 1.25);
  let y = 4.2 - u * 8.4;
  let z = sin(u * TAU + branch * 0.8) * (0.18 + split * 1.05);
  return vec3f(x, y, z);
}

fn execution_helix(index: u32, _count: u32, time: f32) -> vec3f {
  let seed = hash11(f32(index) * 0.927);
  let strand = f32(index % 2u);
  let speed = 0.03 + hash11(f32(index % 31u)) * 0.021;
  let u = fract(seed + time * speed);
  let angle = u * TAU * 4.0 + strand * 3.14159265;
  let radius = 2.15 + sin(u * TAU * 2.0) * 0.18;
  return vec3f(cos(angle) * radius, 4.4 - u * 8.8, sin(angle) * radius);
}

fn memory_archive(index: u32, _count: u32, time: f32) -> vec3f {
  let seed = hash11(f32(index) * 1.117);
  let shelf = f32(index % 9u) - 4.0;
  let depth = f32((index / 9u) % 5u) - 2.0;
  let speed = 0.025 + hash11(f32(index % 29u)) * 0.018;
  let u = fract(seed + time * speed);
  return vec3f(mix(-4.35, 4.35, u), shelf * 0.82, depth * 0.62 + sin(u * TAU) * 0.08);
}

fn system_matrix(index: u32, _count: u32, time: f32) -> vec3f {
  let width = 24u;
  let plane = width * width;
  let x = f32(index % width) - 11.5;
  let y = f32((index / width) % width) - 11.5;
  let z = f32((index / plane) % width) - 11.5;
  let scan = sin(time * 0.48 + y * 0.31) * 0.09;
  return vec3f(x * 0.34 + scan, y * 0.34, z * 0.34);
}

fn final_aperture(index: u32, _count: u32, time: f32) -> vec3f {
  let slot = f32(index % 320u) / 320.0;
  let ring = f32((index / 320u) % 16u);
  let angle = slot * TAU + time * (0.018 + ring * 0.0015);
  let radius = 3.0 + ring * 0.14;
  let depth = (ring - 7.5) * 0.22;
  return vec3f(cos(angle) * radius, sin(angle) * radius, depth);
}

fn formation(stage: u32, index: u32, count: u32, time: f32) -> vec3f {
  switch stage {
    case 0u: { return signal_lattice(index, count, time); }
    case 1u: { return ingestion_funnel(index, count, time); }
    case 2u: { return context_stack(index, count, time); }
    case 3u: { return agent_routes(index, count, time); }
    case 4u: { return execution_helix(index, count, time); }
    case 5u: { return memory_archive(index, count, time); }
    case 6u: { return system_matrix(index, count, time); }
    default: { return final_aperture(index, count, time); }
  }
}

@compute @workgroup_size(64)
fn update_particles(@builtin(global_invocation_id) global_id: vec3u) {
  let index = global_id.x;
  let count = u32(uniforms.scene.z + 0.5);
  if (index >= count) {
    return;
  }

  let reduced_motion = uniforms.scene.w > 0.5;
  let active_time = select(uniforms.frame.x, 0.0, reduced_motion);
  let from_stage = u32(uniforms.scene.x + 0.5);
  let to_stage = u32(uniforms.scene.y + 0.5);
  let morph = uniforms.frame.z;
  let from_position = formation(from_stage, index, count, active_time);
  let to_position = formation(to_stage, index, count, active_time);
  var desired_position = mix(from_position, to_position, morph);

  let bloom = select(uniforms.frame.w, 0.0, reduced_motion);
  let radial = normalize(desired_position + vec3f(0.0001));
  desired_position += radial * bloom * (0.34 + hash11(f32(index) * 0.77) * 0.72);
  desired_position.y += signal_pop(index, active_time) * 0.34;
  desired_position.x += uniforms.pointer.x * (0.12 + abs(desired_position.z) * 0.016);
  desired_position.y += uniforms.pointer.y * 0.08;

  if (reduced_motion) {
    particles[index].position = vec4f(desired_position, particles[index].position.w);
    particles[index].velocity = vec4f(0.0);
    return;
  }

  let dt = min(uniforms.frame.y, 0.034);
  var velocity = particles[index].velocity.xyz;
  let displacement = desired_position - particles[index].position.xyz;
  velocity += displacement * (7.8 * dt);
  velocity *= exp(-4.6 * dt);
  let next_position = particles[index].position.xyz + velocity * dt;
  particles[index].position = vec4f(next_position, particles[index].position.w);
  particles[index].velocity = vec4f(velocity, 0.0);
}
