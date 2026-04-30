import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbedWorkerRequest, EmbedWorkerSuccess } from '../src';

const workerEmitMock = vi.fn();
const transferMock = vi.fn(function TransferStub<T>(value: T) {
  return value;
});
const pipelineMock = vi.fn();
const transformersImportState = vi.hoisted(() => ({
  env: { allowRemoteModels: false } as {
    allowRemoteModels: boolean;
    backends?: { onnx?: { webgpu?: { device?: unknown } } };
  },
  error: null as Error | null,
}));
const registeredHandlers: {
  runEmbedding?: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess>;
} = {};

class MockTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];

  constructor(values: readonly number[], dims: readonly number[]) {
    this.data = Float32Array.from(values);
    this.dims = dims;
  }

  tolist() {
    return Array.from(this.data);
  }
}

class NestedMockTensor extends MockTensor {
  override tolist(): number[][][] {
    return [[[1, 2, 3]]];
  }
}

interface MockGpuCommandEncoder {
  finish: () => unknown;
}

interface MockGpuDevice {
  createCommandEncoder: () => MockGpuCommandEncoder;
  readonly lost: Promise<{ readonly reason?: string; readonly message: string }>;
  readonly queue: {
    submit: (buffers: unknown[]) => void;
  };
}

vi.mock('workerpool', () => ({
  worker: (handlers: {
    runEmbedding: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess>;
  }) => {
    registeredHandlers.runEmbedding = handlers.runEmbedding;
  },
  workerEmit: workerEmitMock,
  Transfer: transferMock,
}));

vi.mock('@huggingface/transformers', () => ({
  get env() {
    if (transformersImportState.error) {
      throw transformersImportState.error;
    }
    return transformersImportState.env;
  },
  pipeline: (...args: unknown[]) => {
    if (transformersImportState.error) {
      throw transformersImportState.error;
    }
    return pipelineMock(...args);
  },
  get Tensor() {
    if (transformersImportState.error) {
      throw transformersImportState.error;
    }
    return MockTensor;
  },
}));

describe('embedding worker runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    workerEmitMock.mockReset();
    pipelineMock.mockReset();
    transferMock.mockClear();
    registeredHandlers.runEmbedding = undefined;
    transformersImportState.error = null;
    transformersImportState.env = { allowRemoteModels: false };
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setOrtWebGpuDevice(device: MockGpuDevice | Promise<MockGpuDevice> | null) {
    const transformers = await import('@huggingface/transformers');
    const mockedEnv = transformers.env as {
      allowRemoteModels: boolean;
      backends?: { onnx?: { webgpu?: { device?: Promise<MockGpuDevice> | MockGpuDevice } } };
    };

    if (!device) {
      mockedEnv.backends = undefined;
      return;
    }

    mockedEnv.backends = {
      onnx: {
        webgpu: {
          device,
        },
      },
    };
  }

  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForAssertion = async (assertion: () => void, timeoutMs = 2000): Promise<void> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        assertion();
        return;
      } catch {
        await flushMicrotasks();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    assertion();
  };

  describe('global error handlers', () => {
    it('sets up onerror handler in worker context', async () => {
      // Use null (not undefined) to simulate browser Worker where the property exists
      const mockSelf = {
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      await import('../src/embedding.worker');
      expect(typeof mockSelf.onerror).toBe('function');
      expect(typeof mockSelf.onunhandledrejection).toBe('function');

      // Exercise the onerror handler with a string event
      mockSelf.onerror?.('Test error message');
      const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
      expect(errorCall?.[0]).toMatchObject({
        type: 'error',
        id: 'global',
        message: 'Worker uncaught error: Test error message',
      });
    });

    it('handles ErrorEvent objects in onerror', async () => {
      const mockSelf = {
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      await import('../src/embedding.worker');

      // Exercise with ErrorEvent-like object
      const errorEvent = {
        message: 'Uncaught TypeError',
        filename: 'worker.js',
        lineno: 42,
      };
      mockSelf.onerror?.(errorEvent as unknown as ErrorEvent);
      const errorCall = workerEmitMock.mock.calls.find(
        ([event]) => event?.message === 'Worker uncaught error: Uncaught TypeError'
      );
      expect(errorCall?.[0]).toMatchObject({
        type: 'error',
        id: 'global',
        cause: 'worker.js:42',
      });
    });

    it('handles unhandled promise rejections', async () => {
      const mockSelf = {
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      await import('../src/embedding.worker');

      // Exercise with Error reason
      const rejectionEvent = {
        reason: new Error('Promise rejected'),
      };
      mockSelf.onunhandledrejection?.(rejectionEvent as unknown as PromiseRejectionEvent);
      const errorCall = workerEmitMock.mock.calls.find(
        ([event]) => event?.message === 'Worker unhandled rejection: Promise rejected'
      );
      expect(errorCall?.[0]).toMatchObject({
        type: 'error',
        id: 'global',
      });
      expect(errorCall?.[0].cause).toContain('Promise rejected');
    });

    it('handles non-Error rejection reasons', async () => {
      const mockSelf = {
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      await import('../src/embedding.worker');

      // Exercise with string reason
      const rejectionEvent = {
        reason: 'Simple string rejection',
      };
      mockSelf.onunhandledrejection?.(rejectionEvent as unknown as PromiseRejectionEvent);
      const errorCall = workerEmitMock.mock.calls.find(
        ([event]) => event?.message === 'Worker unhandled rejection: Simple string rejection'
      );
      expect(errorCall?.[0]).toMatchObject({
        type: 'error',
        id: 'global',
      });
    });
  });

  it('streams embedding batches through the worker message channel', async () => {
    const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
    const postMessage = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          messageListeners.add(listener);
        }
      }),
      postMessage,
      onerror: undefined,
      onunhandledrejection: undefined,
    });
    pipelineMock.mockResolvedValue(async () => Float32Array.from([0.2, 0.8]));
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        type: 'stream-embed',
        request: {
          type: 'embed',
          id: 'stream-1',
          model: 'bge-m3',
          texts: ['hello'],
          targetDimension: 2,
          deviceHint: 'wasm',
        },
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'progress',
        id: 'stream-1',
        phase: 'initializing',
        progress: 0,
      },
      []
    );
    await waitForAssertion(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'batch',
          id: 'stream-1',
          batchIndex: 0,
          startIndex: 0,
          endIndex: 1,
        }),
        expect.any(Array)
      )
    );

    handleMessage({
      data: {
        type: 'stream-ack',
        id: 'stream-1',
        batchIndex: 0,
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'complete',
        id: 'stream-1',
        metadata: expect.objectContaining({
          batchSize: 1,
          dimensions: 2,
        }),
      }),
      []
    );
  });

  it('fails fast when streaming requests are malformed', async () => {
    const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
    const postMessage = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          messageListeners.add(listener);
        }
      }),
      postMessage,
      onerror: undefined,
      onunhandledrejection: undefined,
    });
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        type: 'stream-embed',
        request: null,
      },
    } as MessageEvent<unknown>);

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'error',
        id: 'unknown',
        message: 'Streaming request payload must be an object.',
      },
      []
    );
  });

  async function loadWorker() {
    await import('../src/embedding.worker');
    if (!registeredHandlers.runEmbedding) {
      throw new Error('Embedding worker was not registered');
    }
    return registeredHandlers.runEmbedding;
  }

  it('retries worker bootstrap after a transformers import failure', async () => {
    const runEmbedding = await loadWorker();

    transformersImportState.error = new Error('transformers import failed');
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'retry-import-first',
        model: 'bge-m3',
        texts: ['hello'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('transformers import failed');

    transformersImportState.error = null;
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'retry-import-second',
        model: 'bge-m3',
        texts: ['hello'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).resolves.toMatchObject({
      type: 'result',
      id: 'retry-import-second',
    });
  });

  it('short-circuits when no texts are provided', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.1, 0.2]));
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'empty',
      model: 'bge-m3',
      texts: [],
      deviceHint: 'wasm',
    });
    expect(result.vectors).toHaveLength(0);
    expect(result.metadata.batchSize).toBe(0);
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(workerEmitMock).not.toHaveBeenCalled();
  });

  it('throws when the webgpu pipeline creation fails', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockRejectedValueOnce(new Error('webgpu unavailable'));
    pipelineMock.mockResolvedValueOnce(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'doc-1',
        model: 'bge-m3',
        texts: ['hello world'],
        truncateDim: 2,
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('webgpu unavailable');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('activates WebGPU guard, ticks keep-alive, and recovers after device loss', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    const closeMock = vi.fn();
    vi.stubGlobal('self', {
      close: closeMock,
      onerror: undefined,
      onunhandledrejection: undefined,
    });

    let resolveLost:
      | ((info: { readonly reason?: string; readonly message: string }) => void)
      | undefined;
    const lost = new Promise<{ readonly reason?: string; readonly message: string }>((resolve) => {
      resolveLost = resolve;
    });

    const submitMock = vi.fn();
    const finishMock = vi.fn<() => unknown>(() => ({ kind: 'command-buffer' }));
    const createCommandEncoderMock = vi.fn<() => MockGpuCommandEncoder>(() => ({
      finish: finishMock,
    }));

    await setOrtWebGpuDevice({
      lost,
      queue: {
        submit: submitMock,
      },
      createCommandEncoder: createCommandEncoderMock,
    });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'webgpu-guard',
      model: 'bge-m3',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(createCommandEncoderMock).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalled();

    resolveLost?.({ message: 'device was lost', reason: 'destroyed' });
    await flushMicrotasks();
    expect(closeMock).toHaveBeenCalled();

    const deviceLostCall = workerEmitMock.mock.calls.find(
      ([event]) => event?.type === 'error' && event?.id === 'device-lost'
    );
    expect(deviceLostCall?.[0]).toMatchObject({
      type: 'error',
      id: 'device-lost',
      message: 'WebGPU device lost: device was lost',
    });

    await runEmbedding({
      type: 'embed',
      id: 'webgpu-guard-reload',
      model: 'bge-m3',
      texts: ['hello again'],
      deviceHint: 'webgpu',
    });
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('handles keep-alive tick failures by stopping the timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    await setOrtWebGpuDevice({
      lost: new Promise(() => {}),
      queue: {
        submit: vi.fn(),
      },
      createCommandEncoder: () => {
        throw new Error('encoder unavailable');
      },
    });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();
    await runEmbedding({
      type: 'embed',
      id: 'webgpu-tick-failure',
      model: 'bge-m3',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(15_000);

    // Additional elapsed time should not invoke another tick because stopKeepAlive() clears the interval.
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it('rejects WebGPU embedding when ORT WebGPU device is unavailable', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await setOrtWebGpuDevice(null);

    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'guard-missing-env',
        model: 'bge-m3',
        texts: ['hello'],
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('WebGPU pipeline loaded without a usable ORT WebGPU device');
  });

  it('rejects WebGPU embedding when ORT returns an invalid device object', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await setOrtWebGpuDevice(
      Promise.resolve({ lost: Promise.resolve({ message: 'ok' }) } as MockGpuDevice)
    );

    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'guard-invalid-device',
        model: 'bge-m3',
        texts: ['hello'],
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('WebGPU pipeline loaded without a usable ORT WebGPU device');
  });

  it('rejects WebGPU embedding when ORT device promise rejects and retries cleanly', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const rejectedDevice = Promise.reject(new Error('device unavailable'));
    void rejectedDevice.catch(() => {});
    await setOrtWebGpuDevice(rejectedDevice);

    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'guard-device-reject',
        model: 'bge-m3',
        texts: ['hello'],
        deviceHint: 'webgpu',
      })
    ).rejects.toThrow('WebGPU pipeline loaded without a usable ORT WebGPU device');

    await setOrtWebGpuDevice({
      lost: new Promise(() => {}),
      queue: {
        submit: vi.fn(),
      },
      createCommandEncoder: () => ({ finish: () => ({}) }),
    });
    const result = await runEmbedding({
      type: 'embed',
      id: 'guard-device-retry',
      model: 'bge-m3',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });

    expect(result.metadata).toMatchObject({
      device: 'webgpu',
      fallbackApplied: false,
    });
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('supports tasks requesting non-default embedding dimensions', async () => {
    const vector = new Float32Array(1024).fill(0.25);
    pipelineMock.mockResolvedValue(async () => vector);
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'custom-dim',
      model: 'bge-m3',
      texts: ['hello'],
      targetDimension: 1024,
      dimensionParameter: 'dimensions',
      provider: 'openai',
      deviceHint: 'wasm',
    });
    expect(result.metadata.dimensions).toBe(1024);
    expect(Array.from(result.vectors[0])).toHaveLength(1024);
  });

  it('validates dimension parameter hints for provider-specific requests', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();

    await expect(
      runEmbedding({
        type: 'embed',
        id: 'invalid-output-dimensionality',
        model: 'bge-m3',
        texts: ['test'],
        targetDimension: 0,
        dimensionParameter: 'output_dimensionality',
        provider: 'google',
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('output_dimensionality');

    await expect(
      runEmbedding({
        type: 'embed',
        id: 'invalid-output-dimension',
        model: 'bge-m3',
        texts: ['test'],
        targetDimension: Number.POSITIVE_INFINITY,
        dimensionParameter: 'output_dimension',
        provider: 'cohere',
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('output_dimension');

    await expect(
      runEmbedding({
        type: 'embed',
        id: 'invalid-dimensions',
        model: 'bge-m3',
        texts: ['test'],
        targetDimension: -1,
        dimensionParameter: 'dimensions',
        provider: 'openai',
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('dimensions');
  });

  it('rejects non-integer and oversized target dimensions', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();

    await expect(
      runEmbedding({
        type: 'embed',
        id: 'invalid-non-integer-dimension',
        model: 'bge-m3',
        texts: ['test'],
        targetDimension: 2.5,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('must be an integer');

    await expect(
      runEmbedding({
        type: 'embed',
        id: 'invalid-large-dimension',
        model: 'bge-m3',
        texts: ['test'],
        targetDimension: 20_001,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('supported maximum');
  });

  it('surfaces pipeline errors without retry', async () => {
    const failingExtractor = vi.fn(async () => {
      throw new Error('batch failed');
    });
    pipelineMock.mockResolvedValueOnce(failingExtractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'bulk',
        model: 'bge-m3',
        texts: Array.from({ length: 32 }, (_, index) => `text-${index}`),
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('batch failed');
    expect(failingExtractor).toHaveBeenCalled();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('emits an error event when the pipeline returns no tensors', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const emptyExtractor = vi.fn(async () => []);
    pipelineMock.mockResolvedValue(emptyExtractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'empty-output',
        model: 'bge-m3',
        texts: ['nope'],
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('Embedding pipeline returned no tensors');
    const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
    expect(errorCall?.[0]).toMatchObject({
      type: 'error',
      id: 'empty-output',
      message: 'Embedding pipeline returned no tensors',
    });
  });

  it('normalizes numeric error codes from ONNX runtime', async () => {
    // ONNX/WASM can throw raw numeric error codes instead of Error objects
    const failingExtractor = vi.fn(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Testing ONNX runtime behavior that throws numeric codes
      throw 42;
    });
    pipelineMock.mockResolvedValueOnce(failingExtractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'numeric-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('Embedding failed with error code: 42');
    const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
    expect(errorCall?.[0]).toMatchObject({
      type: 'error',
      id: 'numeric-error',
      cause: 'Error code: 42 (0x2a)',
    });
  });

  it('normalizes string error values from pipeline failures', async () => {
    // Some pipelines throw raw string messages instead of Error objects
    const failingExtractor = vi.fn(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Testing pipeline behavior that throws raw strings
      throw 'pipeline initialization failed';
    });
    pipelineMock.mockResolvedValueOnce(failingExtractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'string-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('pipeline initialization failed');
  });

  it('normalizes undefined and null failures from runtime backends', async () => {
    const runEmbedding = await loadWorker();

    pipelineMock.mockResolvedValueOnce(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Exercising unknown backend failure shape
      throw undefined;
    });
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'undefined-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('unknown error');

    pipelineMock.mockResolvedValueOnce(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Exercising unknown backend failure shape
      throw null;
    });
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'null-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('unknown error');
  });

  it('normalizes object failures including circular references', async () => {
    const circular: { self?: unknown; code: string } = { code: 'E_CIRCULAR' };
    circular.self = circular;
    const runEmbedding = await loadWorker();

    pipelineMock.mockResolvedValueOnce(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Exercising object failure serialization
      throw { code: 'E_OBJECT', detail: 'oops' };
    });
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'object-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('Embedding failed:');

    pipelineMock.mockResolvedValueOnce(async () => {
      throw circular;
    });
    await expect(
      runEmbedding({
        type: 'embed',
        id: 'circular-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        deviceHint: 'wasm',
      })
    ).rejects.toThrow('Embedding failed:');
  });

  it('skips GPU command submission when keepAlivePaused is true via BroadcastChannel', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    const submitMock = vi.fn();
    const finishMock = vi.fn<() => unknown>(() => ({ kind: 'command-buffer' }));
    const createCommandEncoderMock = vi.fn<() => MockGpuCommandEncoder>(() => ({
      finish: finishMock,
    }));

    await setOrtWebGpuDevice({
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
      createCommandEncoder: createCommandEncoderMock,
    });

    // Set up BroadcastChannel mock to capture onmessage handlers
    const channelInstances: { onmessage?: ((e: { data: string }) => void) | null }[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      vi.fn().mockImplementation(function (this: {
        onmessage?: ((e: { data: string }) => void) | null;
      }) {
        channelInstances.push(this);
      })
    );

    const mockSelf = {
      onerror: null as ((event: ErrorEvent | string) => void) | null,
      onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
    };
    vi.stubGlobal('self', mockSelf);

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      type: 'embed',
      id: 'pause-test',
      model: 'bge-m3',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });
    await flushMicrotasks();

    // Verify keep-alive ticks normally
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).toHaveBeenCalledTimes(1);
    submitMock.mockClear();

    // Simulate suspend via BroadcastChannel
    const powerChannel = channelInstances.find((c) => c.onmessage);
    powerChannel?.onmessage?.({ data: 'suspend' });

    // Keep-alive tick should be skipped because paused
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).not.toHaveBeenCalled();

    // Resume
    powerChannel?.onmessage?.({ data: 'resume' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('skips GPU command submission when isInferenceActive is true', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    const submitMock = vi.fn();
    const finishMock = vi.fn<() => unknown>(() => ({ kind: 'command-buffer' }));

    await setOrtWebGpuDevice({
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
      createCommandEncoder: vi.fn<() => MockGpuCommandEncoder>(() => ({ finish: finishMock })),
    });

    // Create a slow extractor that we can control
    let resolveInference!: (v: Float32Array) => void;
    const slowExtractor = vi.fn(
      () =>
        new Promise<Float32Array>((resolve) => {
          resolveInference = resolve;
        })
    );
    pipelineMock.mockResolvedValue(slowExtractor);
    const runEmbedding = await loadWorker();

    // Start inference (won't resolve until we call resolveInference)
    const embeddingPromise = runEmbedding({
      type: 'embed',
      id: 'active-guard',
      model: 'bge-m3',
      texts: ['hello'],
      deviceHint: 'webgpu',
    });
    await flushMicrotasks();

    // Keep-alive tick fires while inference is still in progress
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).not.toHaveBeenCalled();

    // Complete the inference
    resolveInference(new Float32Array([1, 0, 0]));
    await embeddingPromise;
    await flushMicrotasks();

    // Now keep-alive should fire normally
    await vi.advanceTimersByTimeAsync(15_000);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('handles 1D and nested tensors from transformers output', async () => {
    const runEmbedding = await loadWorker();

    pipelineMock.mockResolvedValueOnce(async () => new MockTensor([1, 2, 3], [3]));
    const oneDimensional = await runEmbedding({
      type: 'embed',
      id: 'tensor-1d',
      model: 'bge-m3',
      texts: ['single'],
      truncateDim: 3,
      deviceHint: 'wasm',
    });
    expect(oneDimensional.vectors).toHaveLength(1);
    expect(oneDimensional.vectors[0]).toHaveLength(3);

    pipelineMock.mockResolvedValueOnce(async () => new NestedMockTensor([1, 2, 3], [1, 1, 3]));
    const nested = await runEmbedding({
      type: 'embed',
      id: 'tensor-nested',
      model: 'bge-m3',
      texts: ['nested'],
      truncateDim: 3,
      deviceHint: 'wasm',
    });
    expect(nested.vectors).toHaveLength(1);
    expect(nested.vectors[0]).toHaveLength(3);
  });

  it('normalizes batched tensors returned by transformers', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    pipelineMock.mockResolvedValue(async (texts: string | readonly string[]) => {
      const inputs = Array.isArray(texts) ? texts : [texts];
      const values = inputs.flatMap((_, index) => [index + 1, index + 2, index + 3]);
      return new MockTensor(values, [inputs.length, 3]);
    });
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      type: 'embed',
      id: 'tensor',
      model: 'bge-m3',
      texts: Array.from({ length: 9 }, (_, index) => `item-${index}`),
      truncateDim: 3,
      deviceHint: 'wasm',
    });
    expect(result.vectors).toHaveLength(9);
    expect(Array.from(result.vectors[0])).toHaveLength(3);
    const length = Math.sqrt(result.vectors[0].reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeCloseTo(1, 5);
  });
});
