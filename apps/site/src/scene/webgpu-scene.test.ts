import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebGPUScene } from './webgpu-scene';

type Listener = (event: unknown) => void;

interface BrowserHarness {
  readonly cancelFrame: ReturnType<typeof vi.fn>;
  readonly destroyDevice: ReturnType<typeof vi.fn>;
  readonly dispatchDocument: (type: string, event?: unknown) => void;
  readonly dispatchWindow: (type: string, event?: unknown) => void;
  readonly runNextFrame: (now?: number) => void;
  readonly setVisibility: (visibility: DocumentVisibilityState) => void;
  readonly uniformWrites: number[][];
}

function addListener(registry: Map<string, Set<Listener>>, type: string, listener: Listener): void {
  const listeners = registry.get(type) ?? new Set<Listener>();
  listeners.add(listener);
  registry.set(type, listeners);
}

function removeListener(
  registry: Map<string, Set<Listener>>,
  type: string,
  listener: Listener
): void {
  registry.get(type)?.delete(listener);
}

function dispatch(registry: Map<string, Set<Listener>>, type: string, event: unknown): void {
  for (const listener of registry.get(type) ?? []) {
    listener(event);
  }
}

function createMediaQuery(matches: boolean): MediaQueryList {
  const listeners = new Set<Listener>();
  return {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.add(listener as Listener);
      }
    },
    addListener: () => undefined,
    dispatchEvent: () => true,
    matches,
    media: '',
    onchange: null,
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.delete(listener as Listener);
      }
    },
    removeListener: () => undefined,
  };
}

function installBrowserHarness(
  options: { readonly contextAvailable?: boolean; readonly failResourceCreation?: boolean } = {}
): {
  readonly canvas: HTMLCanvasElement;
  readonly harness: BrowserHarness;
} {
  const windowListeners = new Map<string, Set<Listener>>();
  const documentListeners = new Map<string, Set<Listener>>();
  const elementListeners = new Map<string, Set<Listener>>();
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const uniformWrites: number[][] = [];
  let frameSequence = 0;
  let visibility: DocumentVisibilityState = 'visible';

  const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
    frameSequence += 1;
    frameCallbacks.set(frameSequence, callback);
    return frameSequence;
  });
  const cancelFrame = vi.fn((frame: number): void => {
    frameCallbacks.delete(frame);
  });
  const destroyDevice = vi.fn();
  const computePass = {
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
    setBindGroup: vi.fn(),
    setPipeline: vi.fn(),
  };
  const renderPass = {
    draw: vi.fn(),
    end: vi.fn(),
    setBindGroup: vi.fn(),
    setPipeline: vi.fn(),
  };
  const commandEncoder = {
    beginComputePass: vi.fn(() => computePass),
    beginRenderPass: vi.fn(() => renderPass),
    finish: vi.fn(() => ({})),
  };
  const device = {
    addEventListener: vi.fn(),
    createBindGroup: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => commandEncoder),
    createComputePipeline: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    destroy: destroyDevice,
    lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    popErrorScope: vi.fn(async () => null),
    pushErrorScope: vi.fn(() => {
      if (options.failResourceCreation) {
        throw new Error('synthetic resource failure');
      }
    }),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(
        (
          _buffer: GPUBuffer,
          _bufferOffset: number,
          data: AllowSharedBufferSource,
          _dataOffset?: number,
          _size?: number
        ) => {
          if (data instanceof Float32Array && data.length === 16) {
            uniformWrites.push(Array.from(data));
          }
        }
      ),
    },
  };
  const context = {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
  };
  const canvas = {
    clientHeight: 600,
    clientWidth: 800,
    getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
    getContext: () => (options.contextAvailable === false ? null : context),
    height: 0,
    width: 0,
  } as unknown as HTMLCanvasElement;

  const windowMock = {
    addEventListener: (type: string, listener: Listener) =>
      addListener(windowListeners, type, listener),
    devicePixelRatio: 1,
    innerWidth: 1440,
    matchMedia: (query: string) => createMediaQuery(query === '(hover: hover) and (pointer: fine)'),
    removeEventListener: (type: string, listener: Listener) =>
      removeListener(windowListeners, type, listener),
  };
  const documentElement = {
    addEventListener: (type: string, listener: Listener) =>
      addListener(elementListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) =>
      removeListener(elementListeners, type, listener),
  };
  const documentMock = {
    addEventListener: (type: string, listener: Listener) =>
      addListener(documentListeners, type, listener),
    documentElement,
    removeEventListener: (type: string, listener: Listener) =>
      removeListener(documentListeners, type, listener),
    get visibilityState() {
      return visibility;
    },
  };
  const gpu = {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => ({ requestDevice: async () => device }),
  };

  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  vi.stubGlobal('document', documentMock);
  vi.stubGlobal('navigator', { gpu });
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect(): void {}
      observe(): void {}
    }
  );
  vi.stubGlobal('window', windowMock);

  return {
    canvas,
    harness: {
      cancelFrame,
      destroyDevice,
      dispatchDocument: (type, event = new Event(type)) => dispatch(documentListeners, type, event),
      dispatchWindow: (type, event = new Event(type)) => dispatch(windowListeners, type, event),
      runNextFrame: (now = 16) => {
        const next = frameCallbacks.entries().next().value;
        if (!next) {
          throw new Error('No WebGPU animation frame was scheduled.');
        }
        const [id, callback] = next;
        frameCallbacks.delete(id);
        callback(now);
      },
      setVisibility: (nextVisibility) => {
        visibility = nextVisibility;
      },
      uniformWrites,
    },
  };
}

function createScene(canvas: HTMLCanvasElement): WebGPUScene {
  return new WebGPUScene({
    canvas,
    getSceneState: () => ({
      activeStage: 0,
      bloom: 0,
      fromStage: 0,
      morph: 0,
      toStage: 0,
    }),
    onError: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebGPUScene lifecycle', () => {
  it('destroys an acquired device when the canvas context is unavailable', async () => {
    const { canvas, harness } = installBrowserHarness({ contextAvailable: false });
    const scene = createScene(canvas);

    await expect(scene.initialize()).rejects.toThrow('could not create a WebGPU context');
    expect(harness.destroyDevice).toHaveBeenCalledOnce();
  });

  it('destroys a partially initialized device when resource creation fails', async () => {
    const { canvas, harness } = installBrowserHarness({ failResourceCreation: true });
    const scene = createScene(canvas);

    await expect(scene.initialize()).rejects.toThrow('synthetic resource failure');
    expect(harness.destroyDevice).toHaveBeenCalledOnce();
  });

  it('pauses pending work while hidden and resumes when visible', async () => {
    const { canvas, harness } = installBrowserHarness();
    const scene = createScene(canvas);
    await scene.initialize();

    harness.setVisibility('hidden');
    harness.dispatchDocument('visibilitychange');
    expect(harness.cancelFrame).toHaveBeenCalledOnce();

    harness.setVisibility('visible');
    harness.dispatchDocument('visibilitychange');
    harness.runNextFrame();
    expect(harness.uniformWrites).toHaveLength(1);
    scene.stop();
  });

  it('ignores touch, accepts fine-hover mouse, and resets on pointer cancellation', async () => {
    const { canvas, harness } = installBrowserHarness();
    const scene = createScene(canvas);
    await scene.initialize();

    harness.dispatchWindow('pointermove', {
      clientX: 700,
      clientY: 100,
      pointerType: 'touch',
    });
    harness.runNextFrame();
    expect(harness.uniformWrites.at(-1)?.[8]).toBe(0);

    harness.dispatchWindow('pointermove', {
      clientX: 700,
      clientY: 100,
      pointerType: 'mouse',
    });
    harness.runNextFrame(32);
    expect(harness.uniformWrites.at(-1)?.[8]).toBeGreaterThan(0);

    harness.dispatchWindow('pointercancel');
    harness.runNextFrame(48);
    expect(harness.uniformWrites.at(-1)?.[8]).toBe(0);
    scene.stop();
  });
});
