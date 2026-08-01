import { computeSceneCamera } from './scene-camera';
import { SCENE_CHANGE_EVENT, type SceneTimelineState, settleSceneTimeline } from './scene-timeline';
import signalSpineShader from './signal-spine.wgsl?raw';
import signalSpineRenderShader from './signal-spine-render.wgsl?raw';
import { normalizePointerPosition, shouldTrackPointer } from './webgpu-interaction';

const FLOATS_PER_PARTICLE = 8;
const UNIFORM_FLOAT_COUNT = 16;
const BUFFER_USAGE_COPY_DST = 0x00_08;
const BUFFER_USAGE_UNIFORM = 0x00_40;
const BUFFER_USAGE_STORAGE = 0x00_80;
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_COMPUTE = 0x4;

export class WebGPUCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGPUCapabilityError';
  }
}

function deterministicUnit(index: number): number {
  const value = Math.sin(index * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}

export function resolveParticleCount(width: number): number {
  if (width < 720) {
    return 6144;
  }
  if (width < 1200) {
    return 9216;
  }
  return 12_288;
}

function initialParticleData(count: number): Float32Array {
  const data = new Float32Array(count * FLOATS_PER_PARTICLE);
  const columns = 64;
  const rows = Math.ceil(count / columns);
  for (let index = 0; index < count; index += 1) {
    const offset = index * FLOATS_PER_PARTICLE;
    const column = index % columns;
    const row = Math.floor(index / columns);
    data[offset] = (column - 31.5) * 0.145;
    data[offset + 1] = (row - rows * 0.5) * 0.054;
    data[offset + 2] = (deterministicUnit(index) - 0.5) * 0.18;
    data[offset + 3] = deterministicUnit(index + 911);
  }
  return data;
}

export interface WebGPUSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly getSceneState: () => SceneTimelineState;
  readonly onError: (error: Error) => void;
}

export class WebGPUScene {
  private animationFrame: number | null = null;
  private computeBindGroup: GPUBindGroup | null = null;
  private computePipeline: GPUComputePipeline | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat | null = null;
  private readonly getSceneState: () => SceneTimelineState;
  private lastFrameTime = 0;
  private readonly motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly onError: (error: Error) => void;
  private particleCount = 0;
  private pointerTarget = { x: 0, y: 0 };
  private readonly pointer = { x: 0, y: 0 };
  private readonly canvas: HTMLCanvasElement;
  private readonly pointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  private renderPipeline: GPURenderPipeline | null = null;
  private renderBindGroup: GPUBindGroup | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private startTime = 0;
  private stopped = false;
  private terminalError: Error | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private readonly uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);

  constructor(options: WebGPUSceneOptions) {
    this.canvas = options.canvas;
    this.getSceneState = options.getSceneState;
    this.onError = options.onError;
  }

  async initialize(): Promise<void> {
    try {
      if (!navigator.gpu) {
        throw new WebGPUCapabilityError('This browser does not expose WebGPU.');
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        throw new WebGPUCapabilityError('No compatible GPU adapter was available.');
      }

      const device = await adapter.requestDevice({ label: 'Brainstrike signal spine device' });
      if (this.stopped) {
        device.destroy();
        throw this.terminalError ?? new Error('WebGPU scene initialization was stopped.');
      }
      this.device = device;
      const context = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) {
        throw new WebGPUCapabilityError('The canvas could not create a WebGPU context.');
      }

      this.context = context;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.particleCount = resolveParticleCount(window.innerWidth);
      await this.createResources();
      this.startRendering();
      await Promise.resolve();
      if (this.terminalError) {
        throw this.terminalError;
      }
      if (this.stopped) {
        throw new Error('WebGPU scene initialization was stopped.');
      }
    } catch (error: unknown) {
      this.stop();
      throw error;
    }
  }

  private startRendering(): void {
    if (this.stopped) {
      return;
    }
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.installLifecycleListeners();
    this.resize();
    this.requestFrame();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.resizeObserver?.disconnect();
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointercancel', this.handlePointerLoss);
    window.removeEventListener('blur', this.handlePointerLoss);
    window.removeEventListener(SCENE_CHANGE_EVENT, this.handleSceneInput);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.documentElement.removeEventListener('pointerleave', this.handlePointerLoss);
    this.motionQuery.removeEventListener('change', this.handleMotionPreferenceChange);
    this.pointerQuery.removeEventListener('change', this.handlePointerCapabilityChange);
    this.device?.destroy();
  }

  private async createResources(): Promise<void> {
    const device = this.device;
    const format = this.format;
    if (!(device && format)) {
      throw new Error('WebGPU resources cannot be created before device initialization.');
    }

    device.pushErrorScope('validation');
    const particleData = initialParticleData(this.particleCount);
    const particleBuffer = device.createBuffer({
      label: 'Signal spine particles',
      size: particleData.byteLength,
      usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_STORAGE,
    });
    device.queue.writeBuffer(particleBuffer, 0, particleData);

    this.uniformBuffer = device.createBuffer({
      label: 'Signal spine uniforms',
      size: this.uniformData.byteLength,
      usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_UNIFORM,
    });

    const computeBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { type: 'uniform' },
          visibility: SHADER_STAGE_COMPUTE,
        },
        {
          binding: 1,
          buffer: { type: 'storage' },
          visibility: SHADER_STAGE_COMPUTE,
        },
      ],
      label: 'Signal spine bind group layout',
    });
    const renderBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { type: 'uniform' },
          visibility: SHADER_STAGE_VERTEX,
        },
        {
          binding: 1,
          buffer: { type: 'read-only-storage' },
          visibility: SHADER_STAGE_VERTEX,
        },
      ],
      label: 'Signal spine render bind group layout',
    });
    const computePipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [computeBindGroupLayout],
    });
    const renderPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout],
    });
    const shaderModule = device.createShaderModule({
      code: signalSpineShader,
      label: 'Signal spine WGSL',
    });

    this.computePipeline = device.createComputePipeline({
      compute: { entryPoint: 'update_particles', module: shaderModule },
      label: 'Signal spine compute pipeline',
      layout: computePipelineLayout,
    });
    const renderShaderModule = device.createShaderModule({
      code: signalSpineRenderShader,
      label: 'Signal spine render WGSL',
    });
    this.renderPipeline = device.createRenderPipeline({
      fragment: {
        entryPoint: 'fragment_main',
        module: renderShaderModule,
        targets: [
          {
            blend: {
              alpha: { dstFactor: 'one', operation: 'add', srcFactor: 'one' },
              color: { dstFactor: 'one', operation: 'add', srcFactor: 'src-alpha' },
            },
            format,
          },
        ],
      },
      label: 'Signal spine render pipeline',
      layout: renderPipelineLayout,
      primitive: { topology: 'triangle-list' },
      vertex: { entryPoint: 'vertex_main', module: renderShaderModule },
    });
    this.computeBindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
      ],
      label: 'Signal spine bind group',
      layout: computeBindGroupLayout,
    });
    this.renderBindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
      ],
      label: 'Signal spine render bind group',
      layout: renderBindGroupLayout,
    });

    const validationError = await device.popErrorScope();
    if (validationError) {
      throw new Error(`WebGPU validation failed: ${validationError.message}`);
    }
  }

  private installLifecycleListeners(): void {
    const device = this.device;
    if (!device) {
      return;
    }
    window.addEventListener('pointermove', this.handlePointerMove, { passive: true });
    window.addEventListener('pointercancel', this.handlePointerLoss);
    window.addEventListener('blur', this.handlePointerLoss);
    window.addEventListener(SCENE_CHANGE_EVENT, this.handleSceneInput);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    document.documentElement.addEventListener('pointerleave', this.handlePointerLoss);
    this.motionQuery.addEventListener('change', this.handleMotionPreferenceChange);
    this.pointerQuery.addEventListener('change', this.handlePointerCapabilityChange);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
      this.fail(new Error(`WebGPU runtime error: ${event.error.message}`));
    });
    void device.lost.then((info) => {
      if (!this.stopped) {
        this.fail(new Error(`WebGPU device lost (${info.reason}): ${info.message}`));
      }
    });
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (
      this.motionQuery.matches ||
      !shouldTrackPointer({ fineHover: this.pointerQuery.matches, pointerType: event.pointerType })
    ) {
      this.resetPointer();
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.resetPointer();
      return;
    }
    try {
      this.pointerTarget = normalizePointerPosition(event, bounds);
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handlePointerLoss = (): void => {
    this.resetPointer();
  };

  private readonly handleSceneInput = (): void => {
    if (this.motionQuery.matches) {
      this.requestFrame();
    }
  };

  private readonly handleMotionPreferenceChange = (): void => {
    this.resetPointer();
    this.requestFrame();
  };

  private readonly handlePointerCapabilityChange = (): void => {
    if (!this.pointerQuery.matches) {
      this.resetPointer();
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      this.resetPointer();
      if (this.animationFrame !== null) {
        cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
      }
      return;
    }
    this.lastFrameTime = performance.now();
    this.requestFrame();
  };

  private resetPointer(): void {
    this.pointerTarget = { x: 0, y: 0 };
    this.pointer.x = 0;
    this.pointer.y = 0;
  }

  private requestFrame(): void {
    if (this.animationFrame === null && !this.stopped && document.visibilityState === 'visible') {
      this.animationFrame = requestAnimationFrame(this.renderFrame);
    }
  }

  private resize(): void {
    const context = this.context;
    const device = this.device;
    const format = this.format;
    if (!(context && device && format)) {
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    context.configure({
      alphaMode: 'premultiplied',
      device,
      format,
    });
    this.handleSceneInput();
  }

  private readonly renderFrame = (now: number): void => {
    this.animationFrame = null;
    if (this.stopped) {
      return;
    }
    if (document.visibilityState !== 'visible') {
      return;
    }
    const reducedMotion = this.motionQuery.matches;

    const device = this.device;
    const context = this.context;
    const computePipeline = this.computePipeline;
    const renderPipeline = this.renderPipeline;
    const computeBindGroup = this.computeBindGroup;
    const renderBindGroup = this.renderBindGroup;
    const uniformBuffer = this.uniformBuffer;
    if (
      !(
        device &&
        context &&
        computePipeline &&
        renderPipeline &&
        computeBindGroup &&
        renderBindGroup &&
        uniformBuffer
      )
    ) {
      this.fail(new Error('WebGPU render resources became unavailable.'));
      return;
    }

    const elapsed = (now - this.startTime) / 1000;
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.034);
    this.lastFrameTime = now;
    this.pointer.x += (this.pointerTarget.x - this.pointer.x) * 0.045;
    this.pointer.y += (this.pointerTarget.y - this.pointer.y) * 0.045;
    const sceneState = this.getSceneState();
    const scene = reducedMotion ? settleSceneTimeline(sceneState) : sceneState;
    const camera = computeSceneCamera(scene);
    const physicalPointScale = 2 / Math.max(1, this.canvas.height);

    this.uniformData.set([
      elapsed,
      delta,
      scene.morph,
      scene.bloom,
      scene.fromStage,
      scene.toStage,
      this.particleCount,
      reducedMotion ? 1 : 0,
      this.pointer.x,
      this.pointer.y,
      this.canvas.width / Math.max(1, this.canvas.height),
      physicalPointScale,
      camera.yaw,
      camera.pitch,
      camera.depth,
      camera.offsetX,
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, this.uniformData);

    try {
      const encoder = device.createCommandEncoder({ label: 'Signal spine frame encoder' });
      const computePass = encoder.beginComputePass({ label: 'Signal spine simulation' });
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));
      computePass.end();

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            clearValue: { a: 1, b: 0.035, g: 0.031, r: 0.027 },
            loadOp: 'clear',
            storeOp: 'store',
            view: context.getCurrentTexture().createView(),
          },
        ],
        label: 'Signal spine render pass',
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setBindGroup(0, renderBindGroup);
      renderPass.draw(6, this.particleCount);
      renderPass.end();
      device.queue.submit([encoder.finish()]);
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!reducedMotion) {
      this.requestFrame();
    }
  };

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.terminalError = error;
    try {
      this.onError(error);
    } finally {
      this.stop();
    }
  }
}
