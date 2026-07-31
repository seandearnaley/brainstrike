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
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

fn hash11(value: f32) -> f32 {
  return fract(sin(value * 127.1) * 43758.5453123);
}

fn signal_pop(index: u32, time: f32) -> f32 {
  let group = floor(f32(index) / 24.0);
  let phase = fract(time * 0.065 + hash11(group * 1.913));
  return smoothstep(0.925, 0.955, phase) * (1.0 - smoothstep(0.955, 1.0, phase));
}

struct VertexOutput {
  @builtin(position) clip_position: vec4f,
  @location(0) color: vec4f,
  @location(1) corner: vec2f,
}

@vertex
fn vertex_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let source = particles[instance_index].position;
  let yaw = uniforms.camera.x + uniforms.pointer.x * 0.12;
  let pitch = uniforms.camera.y + uniforms.pointer.y * 0.07;
  let cy = cos(yaw);
  let sy = sin(yaw);
  let cp = cos(pitch);
  let sp = sin(pitch);
  let yawed = vec3f(
    source.x * cy - source.z * sy,
    source.y,
    source.x * sy + source.z * cy
  );
  var viewed = vec3f(
    yawed.x,
    yawed.y * cp - yawed.z * sp,
    yawed.y * sp + yawed.z * cp
  );
  viewed.x += uniforms.camera.w;
  let distance = max(3.0, 12.0 + uniforms.camera.z - viewed.z);
  let projected = vec2f(
    viewed.x / (distance * 0.57 * uniforms.pointer.z),
    viewed.y / (distance * 0.57)
  );

  let render_time = select(uniforms.frame.x, 0.0, uniforms.scene.w > 0.5);
  let pop = signal_pop(instance_index, render_time);
  let seed = source.w;
  let size_ndc = (1.3 + seed * 2.4 + pop * 4.2) * uniforms.pointer.w;
  let corner = corners[vertex_index];
  let offset = corner * size_ndc;

  let accent = instance_index % 31u == 0u || pop > 0.1;
  let is_diagnostic = instance_index % 47u == 0u && !accent;
  var rgb = vec3f(0.82, 0.84, 0.78);
  if (accent) {
    rgb = vec3f(1.0, 0.19, 0.07);
  } else if (is_diagnostic) {
    rgb = vec3f(0.27, 0.82, 0.58);
  }

  var output: VertexOutput;
  output.clip_position = vec4f(projected + offset, clamp(viewed.z / 24.0, 0.0, 0.98), 1.0);
  output.color = vec4f(rgb, 0.26 + seed * 0.46 + pop * 0.28);
  output.corner = corner;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let radius = length(input.corner);
  if (radius > 1.0) {
    discard;
  }
  let core = 1.0 - smoothstep(0.05, 1.0, radius);
  let glow = 1.0 - smoothstep(0.0, 1.0, radius);
  return vec4f(input.color.rgb * (0.75 + core * 0.65), input.color.a * glow);
}
