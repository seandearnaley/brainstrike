import {
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
  withOnnxWasmPathsFragment,
} from '@brainstrike/indexing-contract';
import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
} from '../src';
import {
  EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
  EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY,
} from '../src/test-runtime-bootstrap';
import { attachStandInTokenizer } from './helpers/stand-in-tokenizer';

const workerEmitMock = vi.fn();
const transferMock = vi.fn(function TransferStub<T>(value: T) {
  return value;
});
const pipelineMock = vi.fn();
const transformersImportState = vi.hoisted(() => ({
  env: { allowRemoteModels: false } as {
    allowRemoteModels: boolean;
    backends?: {
      onnx?: {
        versions?: { web?: string };
        wasm?: { wasmPaths?: unknown };
        webgpu?: { device?: unknown };
      };
    };
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
  Transfer: transferMock,
  worker: (handlers: {
    runEmbedding: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess>;
  }) => {
    registeredHandlers.runEmbedding = handlers.runEmbedding;
  },
  workerEmit: workerEmitMock,
}));

vi.mock('@huggingface/transformers', () => ({
  get env() {
    if (transformersImportState.error) {
      throw transformersImportState.error;
    }
    return transformersImportState.env;
  },
  pipeline: async (...args: unknown[]) => {
    if (transformersImportState.error) {
      throw transformersImportState.error;
    }
    return attachStandInTokenizer(await pipelineMock(...args));
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
    Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY);
    Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY);
    workerEmitMock.mockReset();
    pipelineMock.mockReset();
    transferMock.mockClear();
    registeredHandlers.runEmbedding = undefined;
    transformersImportState.error = null;
    transformersImportState.env = { allowRemoteModels: false };
    vi.unstubAllGlobals();
    vi.stubGlobal('reportError', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setWebGpuDevice(device: MockGpuDevice | Promise<MockGpuDevice> | null): void {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () =>
          device === null
            ? null
            : {
                features: new Set<string>(),
                limits: {},
                requestDevice: async () => await device,
              },
      },
    });
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

  function installTestRuntime(runtime: Record<string, unknown>): void {
    Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
      configurable: true,
      value: {
        automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
        marker: EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
        takeRuntime: () => ({ runtime, webGpuClassProxy: true }),
      },
    });
  }

  describe('webdriver test runtime validation', () => {
    it('boots the production worker from a valid fixed runtime without importing Transformers', async () => {
      transformersImportState.error = new Error('Transformers import must remain unused');
      const extractor = attachStandInTokenizer(vi.fn(async () => Float32Array.from([0.25, 0.75])));
      const injectedPipeline = vi.fn(async () => extractor);
      installTestRuntime({
        env: { allowRemoteModels: false },
        pipeline: injectedPipeline,
        tensorConstructor: MockTensor,
      });

      await expect(import('../src/embedding.worker')).resolves.toBeDefined();
      const runEmbedding = registeredHandlers.runEmbedding;
      if (!runEmbedding) {
        throw new Error('Expected the production worker to register its embedding handler.');
      }
      await expect(
        runEmbedding({
          deviceHint: 'wasm',
          id: 'injected-runtime-proof',
          model: 'bge-m3',
          texts: ['offline probe'],
          truncateDim: 2,
          type: 'embed',
        })
      ).resolves.toMatchObject({ id: 'injected-runtime-proof', type: 'result' });
      expect(injectedPipeline).toHaveBeenCalledOnce();
      expect(extractor).toHaveBeenCalledOnce();
    });

    it.each([
      {
        error: 'Embedding worker test runtime is missing env, pipeline, or Tensor.',
        name: 'a missing environment',
        runtime: { pipeline: vi.fn(), tensorConstructor: MockTensor },
      },
      {
        error: 'Embedding worker test runtime is missing env, pipeline, or Tensor.',
        name: 'a missing pipeline loader',
        runtime: { env: { allowRemoteModels: false }, tensorConstructor: MockTensor },
      },
      {
        error: 'Embedding worker test runtime is missing env, pipeline, or Tensor.',
        name: 'a missing Tensor constructor',
        runtime: { env: { allowRemoteModels: false }, pipeline: vi.fn() },
      },
      {
        error: 'Embedding worker test runtime must disable remote models.',
        name: 'remote model loading',
        runtime: {
          env: { allowRemoteModels: true },
          pipeline: vi.fn(),
          tensorConstructor: MockTensor,
        },
      },
    ])('rejects $name before registering the worker', async ({ error, runtime }) => {
      installTestRuntime(runtime);

      await expect(import('../src/embedding.worker')).rejects.toThrow(error);
      expect(registeredHandlers.runEmbedding).toBeUndefined();
    });
  });

  describe('global error handlers', () => {
    it('sets up onerror handler in worker context', async () => {
      // Use null (not undefined) to simulate browser Worker where the property exists
      const close = vi.fn();
      const mockSelf = {
        close,
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
        id: 'global',
        message: 'Worker uncaught error: Test error message',
        type: 'error',
      });
      expect(close).not.toHaveBeenCalled();
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
        filename: 'worker.js',
        lineno: 42,
        message: 'Uncaught TypeError',
      };
      mockSelf.onerror?.(errorEvent as unknown as ErrorEvent);
      const errorCall = workerEmitMock.mock.calls.find(
        ([event]) => event?.message === 'Worker uncaught error: Uncaught TypeError'
      );
      expect(errorCall?.[0]).toMatchObject({
        cause: 'worker.js:42',
        id: 'global',
        type: 'error',
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
        id: 'global',
        type: 'error',
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
        id: 'global',
        type: 'error',
      });
    });

    it('reports an idle unhandled rejection through the owner-visible worker error channel', async () => {
      const close = vi.fn();
      const reportError = vi.fn(() => {
        expect(mockSelf.onerror).toBeNull();
      });
      const mockSelf = {
        close,
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      vi.stubGlobal('reportError', reportError);
      await import('../src/embedding.worker');
      const rejection = new Error('idle rejection');

      mockSelf.onunhandledrejection?.({ reason: rejection } as PromiseRejectionEvent);

      expect(reportError).toHaveBeenCalledWith(rejection);
      expect(close).not.toHaveBeenCalled();
    });

    it('requests adapter recovery for an idle workerpool rejection', async () => {
      const telemetryPostMessage = vi.fn();
      vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}idle-failed-worker`);
      vi.stubGlobal('location', {
        hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=idle-failure-channel`,
      });
      vi.stubGlobal(
        'BroadcastChannel',
        class {
          readonly close = vi.fn();
          readonly postMessage = telemetryPostMessage;
        } as unknown as typeof BroadcastChannel
      );
      const close = vi.fn();
      const mockSelf = {
        close,
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      const reportError = vi.fn();
      vi.stubGlobal('reportError', reportError);
      await import('../src/embedding.worker');

      mockSelf.onunhandledrejection?.({
        reason: new Error('idle pool rejection'),
      } as PromiseRejectionEvent);

      expect(telemetryPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Worker unhandled rejection: idle pool rejection',
          type: 'worker-lifetime-error',
          workerInstanceId: 'idle-failed-worker',
        })
      );
      expect(reportError).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('quarantines an idle failed worker before adapter recovery is delivered', async () => {
      vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}quarantined-worker`);
      vi.stubGlobal('location', {
        hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=quarantine-channel`,
      });
      vi.stubGlobal(
        'BroadcastChannel',
        class {
          readonly close = vi.fn();
          readonly postMessage = vi.fn();
        } as unknown as typeof BroadcastChannel
      );
      const mockSelf = {
        close: vi.fn(),
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      const runEmbedding = await loadWorker();

      mockSelf.onunhandledrejection?.({
        reason: new Error('idle pool rejection'),
      } as PromiseRejectionEvent);

      await expect(
        runEmbedding({
          deviceHint: 'wasm',
          id: 'task-before-recovery-delivery',
          model: 'bge-m3',
          texts: ['must not run'],
          type: 'embed',
        })
      ).rejects.toThrow('cannot accept work after an idle global failure');
      expect(pipelineMock).not.toHaveBeenCalled();
    });

    it('scopes global failures to the active workerpool request', async () => {
      const close = vi.fn();
      const mockSelf = {
        close,
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
      };
      vi.stubGlobal('self', mockSelf);
      let resolveInference!: (value: Float32Array) => void;
      pipelineMock.mockResolvedValue(
        () =>
          new Promise<Float32Array>((resolve) => {
            resolveInference = resolve;
          })
      );
      const runEmbedding = await loadWorker();
      const embeddingPromise = runEmbedding({
        deviceHint: 'wasm',
        id: 'active-global-failure',
        model: 'bge-m3',
        texts: ['hello'],
        type: 'embed',
      });
      await flushMicrotasks();
      await waitForAssertion(() => expect(resolveInference).toBeTypeOf('function'));

      mockSelf.onerror?.('active request failed globally');

      expect(workerEmitMock).toHaveBeenCalledWith({
        cause: undefined,
        id: 'active-global-failure',
        message: 'Worker uncaught error: active request failed globally',
        type: 'error',
      });
      expect(close).toHaveBeenCalledTimes(1);
      mockSelf.onunhandledrejection?.({
        reason: new Error('active request rejected globally'),
      } as PromiseRejectionEvent);
      expect(workerEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'active-global-failure',
          message: 'Worker unhandled rejection: active request rejected globally',
          type: 'error',
        })
      );
      expect(close).toHaveBeenCalledTimes(2);
      resolveInference(new Float32Array([1, 0, 0]));
      await embeddingPromise;
    });

    it('notifies an active direct stream before closing on a global failure', async () => {
      const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
      const postMessage = vi.fn();
      const close = vi.fn();
      const mockSelf = {
        addEventListener: vi.fn(
          (type: string, listener: (event: MessageEvent<unknown>) => void) => {
            if (type === 'message') {
              messageListeners.add(listener);
            }
          }
        ),
        close,
        onerror: null as ((event: ErrorEvent | string) => void) | null,
        onunhandledrejection: null as ((event: PromiseRejectionEvent) => void) | null,
        postMessage,
      };
      vi.stubGlobal('self', mockSelf);
      let resolveInference!: (value: Float32Array) => void;
      pipelineMock.mockResolvedValue(
        () =>
          new Promise<Float32Array>((resolve) => {
            resolveInference = resolve;
          })
      );
      await import('../src/embedding.worker');
      const [handleMessage] = [...messageListeners];
      if (!handleMessage) {
        throw new Error('Expected worker message handler to be registered');
      }
      handleMessage({
        data: {
          request: {
            deviceHint: 'wasm',
            id: 'active-stream-global-failure',
            model: 'bge-m3',
            texts: ['hello'],
            type: 'embed',
          },
          type: 'stream-embed',
        },
      } as MessageEvent<unknown>);
      await waitForAssertion(() => expect(resolveInference).toBeTypeOf('function'));

      mockSelf.onunhandledrejection?.({
        reason: new Error('stream rejected globally'),
      } as PromiseRejectionEvent);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'active-stream-global-failure',
          message: 'Worker unhandled rejection: stream rejected globally',
          type: 'error',
        }),
        []
      );
      expect(close).toHaveBeenCalledTimes(1);
      resolveInference(new Float32Array([1, 0, 0]));
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
      onerror: undefined,
      onunhandledrejection: undefined,
      postMessage,
    });
    pipelineMock.mockResolvedValue(async () => Float32Array.from([0.2, 0.8]));
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        request: {
          deviceHint: 'wasm',
          id: 'stream-1',
          model: 'bge-m3',
          targetDimension: 2,
          texts: ['hello'],
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith(
      {
        id: 'stream-1',
        phase: 'initializing',
        progress: 0,
        type: 'progress',
      },
      []
    );
    await waitForAssertion(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          batchIndex: 0,
          endIndex: 1,
          id: 'stream-1',
          startIndex: 0,
          type: 'batch',
        }),
        expect.any(Array)
      )
    );

    handleMessage({
      data: {
        batchIndex: 0,
        id: 'stream-1',
        type: 'stream-ack',
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stream-1',
        metadata: expect.objectContaining({
          batchSize: 1,
          dimensions: 2,
        }),
        type: 'complete',
      }),
      []
    );
  });

  it('bounds a long maximum-dimension stream to one acknowledged batch and exact bytes', async () => {
    const batchSize = 8;
    const dimensions = MAX_EMBEDDING_DIMENSION;
    const requestId = 'stream-max-dimension-stress';
    const texts = Array.from({ length: 64 }, (_, index) => `document-${index}`);
    const expectedBatchCount = texts.length / batchSize;
    const expectedBytesPerBatch = batchSize * dimensions * Float32Array.BYTES_PER_ELEMENT;
    const expectedTotalBytes = texts.length * dimensions * Float32Array.BYTES_PER_ELEMENT;
    const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
    const postMessage = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          messageListeners.add(listener);
        }
      }),
      onerror: undefined,
      onunhandledrejection: undefined,
      postMessage,
    });

    let inferenceBatchCount = 0;
    pipelineMock.mockResolvedValue(async (slice: readonly string[]) => {
      inferenceBatchCount += 1;
      return slice.map(() => new Float32Array(dimensions).fill(1));
    });
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        request: {
          deviceHint: 'wasm',
          id: requestId,
          maxBatchSize: batchSize,
          model: 'bge-m3',
          targetDimension: dimensions,
          texts,
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);

    let observedTotalBytes = 0;
    for (let batchIndex = 0; batchIndex < expectedBatchCount; batchIndex += 1) {
      await waitForAssertion(() =>
        expect(
          postMessage.mock.calls.some(
            ([message]) => (message as { readonly type?: unknown }).type === 'batch'
          )
        ).toBe(true)
      );
      const batchCall = postMessage.mock.calls.find(
        ([message]) => (message as { readonly type?: unknown }).type === 'batch'
      );
      if (!batchCall) {
        throw new Error(`Expected streamed batch ${batchIndex}`);
      }
      const batch = batchCall[0] as EmbedWorkerBatch;
      const transferList = batchCall[1] as readonly ArrayBuffer[];

      expect(batch).toMatchObject({
        batchIndex,
        endIndex: (batchIndex + 1) * batchSize,
        id: requestId,
        peakVectorsInFlight: batchSize,
        startIndex: batchIndex * batchSize,
        transferBytes: expectedBytesPerBatch,
        type: 'batch',
        vectorsInFlight: batchSize,
      });
      expect(batch.vectors).toHaveLength(batchSize);
      expect(batch.vectors.every((vector) => vector.length === dimensions)).toBe(true);
      const uniqueVectorBuffers = new Set(batch.vectors.map((vector) => vector.buffer));
      // Identity (===) rather than deep equality: the mock vectors are
      // byte-identical, so a deep compare is satisfied by COPIES of the
      // buffers — the double-allocation topology this assertion forbids.
      // Together these two force transferList to be exactly a permutation of
      // the vectors' actual backing stores.
      expect(transferList).toHaveLength(uniqueVectorBuffers.size);
      expect(batch.vectors.every((vector) => transferList.includes(vector.buffer))).toBe(true);
      expect(transferList.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(
        expectedBytesPerBatch
      );

      observedTotalBytes += batch.transferBytes;
      await flushMicrotasks();
      expect(inferenceBatchCount).toBe(batchIndex + 1);
      expect(
        postMessage.mock.calls.filter(
          ([message]) => (message as { readonly type?: unknown }).type === 'batch'
        )
      ).toHaveLength(1);

      postMessage.mockClear();
      handleMessage({
        data: {
          batchIndex,
          id: requestId,
          type: 'stream-ack',
        },
      } as MessageEvent<unknown>);
    }

    await waitForAssertion(() =>
      expect(
        postMessage.mock.calls.some(
          ([message]) => (message as { readonly type?: unknown }).type === 'complete'
        )
      ).toBe(true)
    );
    const completeCall = postMessage.mock.calls.find(
      ([message]) => (message as { readonly type?: unknown }).type === 'complete'
    );
    if (!completeCall) {
      throw new Error('Expected stream completion');
    }
    const complete = completeCall[0] as EmbedWorkerComplete;
    expect(complete).toMatchObject({
      id: requestId,
      metadata: {
        batchSize,
        dimensions,
      },
      type: 'complete',
    });
    expect(inferenceBatchCount).toBe(expectedBatchCount);
    expect(observedTotalBytes).toBe(expectedTotalBytes);
  });

  it('reports typed streaming device loss after the outstanding batch is acknowledged without closing', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const telemetryPostMessage = vi.fn();
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}worker-device-loss`);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=device-loss-channel`,
    });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        readonly close = vi.fn();
        readonly postMessage = telemetryPostMessage;
      } as unknown as typeof BroadcastChannel
    );
    const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
    const postMessage = vi.fn();
    const closeMock = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          messageListeners.add(listener);
        }
      }),
      close: closeMock,
      onerror: undefined,
      onunhandledrejection: undefined,
      postMessage,
    });

    let resolveLost: ((info: { message: string; reason?: string }) => void) | null = null;
    await setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise((resolve) => {
        resolveLost = resolve;
      }),
      queue: {
        submit: vi.fn(),
      },
    });
    pipelineMock.mockResolvedValue(async () => Float32Array.from([0.2, 0.8]));
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        request: {
          deviceHint: 'webgpu',
          id: 'stream-device-loss',
          model: 'bge-m3',
          targetDimension: 2,
          texts: ['hello'],
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);

    await waitForAssertion(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stream-device-loss',
          type: 'batch',
        }),
        expect.any(Array)
      )
    );

    resolveLost?.({ message: 'device was lost', reason: 'destroyed' });
    await flushMicrotasks();
    expect(telemetryPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'worker-lifetime-error' })
    );
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
      expect.any(Array)
    );

    handleMessage({
      data: { batchIndex: 0, id: 'stream-device-loss', type: 'stream-ack' },
    } as MessageEvent<unknown>);
    await waitForAssertion(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'EMBEDDING_DEVICE_LOST',
          id: 'stream-device-loss',
          type: 'error',
        }),
        []
      )
    );
    expect(telemetryPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'telemetry-source-closed' })
    );
    expect(telemetryPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST', type: 'worker-lifetime-error' })
    );
    expect(closeMock).not.toHaveBeenCalled();
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
      onerror: undefined,
      onunhandledrejection: undefined,
      postMessage,
    });
    await import('../src/embedding.worker');

    const [handleMessage] = [...messageListeners];
    if (!handleMessage) {
      throw new Error('Expected worker message handler to be registered');
    }

    handleMessage({
      data: {
        request: null,
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);

    expect(postMessage).toHaveBeenCalledWith(
      {
        id: 'unknown',
        message: 'Streaming request payload must be an object.',
        type: 'error',
      },
      []
    );

    handleMessage({
      data: {
        request: {
          deviceHint: 'wasm',
          estimatedModelBytes: 0,
          id: 'invalid-model-size',
          model: 'bge-m3',
          texts: ['hello'],
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);
    handleMessage({
      data: {
        request: {
          deviceHint: 'wasm',
          id: 'invalid-dimension',
          model: 'bge-m3',
          targetDimension: 0,
          texts: ['hello'],
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'invalid-model-size',
        message: expect.stringContaining('estimatedModelBytes must be a positive safe integer'),
        type: 'error',
      }),
      []
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'invalid-dimension',
        message: expect.stringContaining('invalid target dimension'),
        type: 'error',
      }),
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

  it('isolates request control from sibling worker telemetry', async () => {
    const channels = new Map<string, Set<PeerBroadcastChannel>>();
    class PeerBroadcastChannel {
      readonly name: string;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

      constructor(name: string) {
        this.name = name;
        const peers = channels.get(name) ?? new Set<PeerBroadcastChannel>();
        peers.add(this);
        channels.set(name, peers);
      }

      close(): void {
        channels.get(this.name)?.delete(this);
      }

      postMessage(data: unknown): void {
        for (const peer of channels.get(this.name) ?? []) {
          if (peer !== this) {
            peer.onmessage?.({ data } as MessageEvent<unknown>);
          }
        }
      }
    }
    vi.stubGlobal('BroadcastChannel', PeerBroadcastChannel as unknown as typeof BroadcastChannel);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=peer-telemetry`,
    });
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}peer-worker-a`);
    await import('../src/embedding.worker');
    expect(registeredHandlers.runEmbedding).toBeTypeOf('function');

    vi.resetModules();
    Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY);
    registeredHandlers.runEmbedding = undefined;
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}peer-worker-b`);
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0]));
    const runPeerEmbedding = await loadWorker();
    const telemetryPeers = [...(channels.get('peer-telemetry') ?? [])];
    expect(telemetryPeers).toHaveLength(2);

    telemetryPeers[0]?.postMessage({
      message: 'peer worker lifetime failure',
      type: 'worker-lifetime-error',
      workerInstanceId: 'peer-worker-a',
    });

    await expect(
      runPeerEmbedding({
        deviceHint: 'wasm',
        id: 'peer-worker-b-task',
        model: 'bge-m3',
        texts: ['healthy peer'],
        truncateDim: 2,
        type: 'embed',
      })
    ).resolves.toMatchObject({ id: 'peer-worker-b-task', type: 'result' });
    expect(
      channels.get(`peer-telemetry${EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX}`)
    ).toHaveLength(2);
  });

  it('clears a fast-path cancellation before a request id is reused', async () => {
    const channels = new Map<
      string,
      { onmessage: ((event: MessageEvent<unknown>) => void) | null }
    >();
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}fast-abort-worker`);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=fast-abort-channel`,
    });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        readonly postMessage = vi.fn();

        constructor(name: string) {
          channels.set(name, this);
        }

        readonly close = vi.fn();
      } as unknown as typeof BroadcastChannel
    );
    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0]));
    const runEmbedding = await loadWorker();
    const controlChannel = channels.get(
      `fast-abort-channel${EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX}`
    );
    controlChannel?.onmessage?.({
      data: { id: 'reused-request-id', type: 'cancel-request' },
    } as MessageEvent<unknown>);
    const request = {
      deviceHint: 'wasm' as const,
      id: 'reused-request-id',
      model: 'bge-m3',
      texts: ['request'],
      truncateDim: 2,
      type: 'embed' as const,
    };

    await expect(runEmbedding(request)).rejects.toMatchObject({
      code: 'EMBED_WORKER_REQUEST_CANCELED',
      name: 'AbortError',
      requestId: request.id,
    });
    await expect(runEmbedding(request)).resolves.toMatchObject({
      id: 'reused-request-id',
      type: 'result',
    });
  });

  it('stops between batches on request abort and reuses the warmed worker pipeline', async () => {
    let controlChannel: { onmessage: ((event: MessageEvent<unknown>) => void) | null } | undefined;
    vi.stubGlobal('name', `${EMBED_WORKER_INSTANCE_NAME_PREFIX}graceful-abort-worker`);
    vi.stubGlobal('location', {
      hash: `#${EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY}=graceful-abort-channel`,
    });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        readonly postMessage = vi.fn();

        constructor() {
          controlChannel = this;
        }
      } as unknown as typeof BroadcastChannel
    );

    const extractor = vi.fn(async () => {
      if (extractor.mock.calls.length === 1) {
        controlChannel?.onmessage?.({
          data: { id: 'graceful-abort', type: 'cancel-request' },
        } as MessageEvent<unknown>);
      }
      return new Float32Array([1, 0]);
    });
    pipelineMock.mockResolvedValue(extractor);
    const runEmbedding = await loadWorker();

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'graceful-abort',
        maxBatchSize: 1,
        model: 'bge-m3',
        texts: ['one', 'two', 'three'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(extractor).toHaveBeenCalledTimes(1);

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'after-graceful-abort',
        maxBatchSize: 1,
        model: 'bge-m3',
        texts: ['still warm'],
        truncateDim: 2,
        type: 'embed',
      })
    ).resolves.toMatchObject({ id: 'after-graceful-abort', type: 'result' });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('retries worker bootstrap after a transformers import failure', async () => {
    const runEmbedding = await loadWorker();

    transformersImportState.error = new Error('transformers import failed');
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'retry-import-first',
        model: 'bge-m3',
        texts: ['hello'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toThrow('transformers import failed');

    transformersImportState.error = null;
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'retry-import-second',
        model: 'bge-m3',
        texts: ['hello'],
        truncateDim: 2,
        type: 'embed',
      })
    ).resolves.toMatchObject({
      id: 'retry-import-second',
      type: 'result',
    });
  });

  describe('ONNX Runtime WASM source (BST-2003)', () => {
    const paths = {
      mjs: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-1a.mjs',
      wasm: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-2b.wasm',
    };
    const request = {
      deviceHint: 'wasm',
      id: 'ort-wasm-source',
      model: 'bge-m3',
      texts: ['hello'],
      truncateDim: 2,
      type: 'embed',
    } as const;

    it('points browser ONNX Runtime at the app-served WASM its worker URL names', async () => {
      const wasm: { wasmPaths?: unknown } = {};
      transformersImportState.env = {
        allowRemoteModels: false,
        backends: { onnx: { versions: { web: '1.31.0' }, wasm } },
      };
      vi.stubGlobal('location', {
        hash: new URL(withOnnxWasmPathsFragment('file:///app/worker.js', paths)).hash,
      });
      pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
      const runEmbedding = await loadWorker();
      await expect(runEmbedding(request)).resolves.toMatchObject({ type: 'result' });
      expect(wasm.wasmPaths).toEqual(paths);
    });

    it('refuses to load browser ONNX Runtime without app-served WASM URLs', async () => {
      transformersImportState.env = {
        allowRemoteModels: false,
        backends: { onnx: { versions: { web: '1.31.0' }, wasm: {} } },
      };
      vi.stubGlobal('location', { hash: '' });
      pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
      const runEmbedding = await loadWorker();
      await expect(runEmbedding(request)).rejects.toThrow('never loads ONNX Runtime from a CDN');
      expect(pipelineMock).not.toHaveBeenCalled();
    });
  });

  describe('contiguous output buffer (BST-90)', () => {
    it('packs all result vectors into a single shared ArrayBuffer', async () => {
      // Pipeline returns one vector per call (per text). With 4 texts we
      // should get 4 vectors all backed by the same underlying buffer.
      pipelineMock.mockResolvedValue(async (slice: readonly string[]) => {
        // Return one Float32Array per text in the slice — the pipeline
        // output normalizer flattens this into a vector list.
        return slice.map((_, i) => Float32Array.from([0.1 * (i + 1), 0.2 * (i + 1)]));
      });
      const runEmbedding = await loadWorker();

      const result = await runEmbedding({
        deviceHint: 'wasm',
        id: 'pack-1',
        model: 'bge-m3',
        texts: ['a', 'b', 'c', 'd'],
        truncateDim: 2,
        type: 'embed',
      });

      expect(result.vectors).toHaveLength(4);
      const firstBuffer = result.vectors[0]?.buffer;
      for (const vector of result.vectors) {
        expect(vector.buffer).toBe(firstBuffer);
      }
      // The total buffer length equals N * D — confirms a flat allocation.
      expect(firstBuffer.byteLength).toBe(4 * 2 * Float32Array.BYTES_PER_ELEMENT);
    });

    it('transfers exactly one ArrayBuffer regardless of batch count', async () => {
      pipelineMock.mockResolvedValue(async (slice: readonly string[]) =>
        slice.map(() => Float32Array.from([0.5, 0.5]))
      );
      const runEmbedding = await loadWorker();

      const result = await runEmbedding({
        deviceHint: 'wasm',
        id: 'pack-transfer',
        model: 'bge-m3',
        texts: ['a', 'b', 'c'],
        truncateDim: 2,
        type: 'embed',
      });

      // Transfer() is invoked once per non-empty processEmbeddings call.
      // The mock's typed signature only declares one arg, but Transfer is
      // called as `new Transfer(value, transferList)`, so we read the
      // second positional arg off the recorded call.
      expect(transferMock).toHaveBeenCalledTimes(1);
      const call = transferMock.mock.calls[0] as readonly unknown[];
      const transferList = call[1] as readonly ArrayBuffer[];
      expect(transferList).toHaveLength(1);
      expect(transferList[0]).toBeInstanceOf(ArrayBuffer);
      // Identity, not just shape: the single transferred buffer must BE the
      // packed backing store every returned vector is a view over — a copy
      // (`.slice(0)`) satisfies the two assertions above.
      expect(result.vectors.every((vector) => vector.buffer === transferList[0])).toBe(true);
    });

    it('transfers original vector buffers when uneven dimensions skip packing', async () => {
      const shortVector = Float32Array.from([0.5, 0.5]);
      const longVector = Float32Array.from([0.25, 0.25, 0.25]);
      pipelineMock.mockResolvedValue(async () => [shortVector, longVector]);
      const runEmbedding = await loadWorker();

      const result = await runEmbedding({
        deviceHint: 'wasm',
        id: 'pack-uneven-transfer',
        model: 'bge-m3',
        texts: ['a', 'b'],
        type: 'embed',
      });

      expect(result.vectors.map((vector) => vector.length)).toEqual([2, 3]);
      expect(result.vectors[0]?.buffer).not.toBe(result.vectors[1]?.buffer);
      expect(transferMock).toHaveBeenCalledTimes(1);
      const call = transferMock.mock.calls[0] as readonly unknown[];
      const transferList = call[1] as readonly ArrayBuffer[];
      // Positional identity (===), not toEqual: this test guards the
      // skip-packing fallback whose entire point is transferring the
      // ORIGINALS — deep equality would accept byte-identical copies.
      expect(transferList).toHaveLength(result.vectors.length);
      expect(result.vectors.every((vector, index) => transferList[index] === vector.buffer)).toBe(
        true
      );
    });

    it('does not invoke Transfer when there are no vectors to return', async () => {
      pipelineMock.mockResolvedValue(async () => new Float32Array([0.1, 0.2]));
      const runEmbedding = await loadWorker();
      await runEmbedding({
        deviceHint: 'wasm',
        id: 'pack-empty',
        model: 'bge-m3',
        texts: [],
        type: 'embed',
      });
      // Empty path returns success directly without packing.
      expect(transferMock).not.toHaveBeenCalled();
    });

    it('preserves vector values through packing', async () => {
      pipelineMock.mockResolvedValue(async (slice: readonly string[]) =>
        slice.map((_, i) => Float32Array.from([i + 1, (i + 1) * 10]))
      );
      const runEmbedding = await loadWorker();
      const result = await runEmbedding({
        deviceHint: 'wasm',
        id: 'pack-values',
        model: 'bge-m3',
        texts: ['a', 'b'],
        truncateDim: 2,
        type: 'embed',
      });

      // After L2-normalize: [1,10] / sqrt(101) ≈ [0.0995, 0.9950]
      // and [2,20] / sqrt(404) ≈ [0.0995, 0.9950] (same after normalize)
      expect(result.vectors[0]?.[0]).toBeCloseTo(1 / Math.sqrt(101), 4);
      expect(result.vectors[0]?.[1]).toBeCloseTo(10 / Math.sqrt(101), 4);
      expect(result.vectors[1]?.[0]).toBeCloseTo(2 / Math.sqrt(404), 4);
      expect(result.vectors[1]?.[1]).toBeCloseTo(20 / Math.sqrt(404), 4);
    });
  });

  it('short-circuits when no texts are provided', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.1, 0.2]));
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      deviceHint: 'wasm',
      id: 'empty',
      model: 'bge-m3',
      texts: [],
      type: 'embed',
    });
    expect(result.vectors).toHaveLength(0);
    expect(result.metadata.batchSize).toBe(0);
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(workerEmitMock).not.toHaveBeenCalled();
  });

  it('throws when the webgpu pipeline creation fails', async () => {
    setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise(() => {}),
      queue: { submit: vi.fn() },
    });
    pipelineMock.mockRejectedValueOnce(new Error('webgpu unavailable'));
    pipelineMock.mockResolvedValueOnce(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'doc-1',
        model: 'bge-m3',
        texts: ['hello world'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toThrow('webgpu unavailable');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('owns one device across WebGPU model switches and passes it to every vendor session', async () => {
    const device = {
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise(() => {}),
      queue: { submit: vi.fn() },
    };
    const requestDevice = vi.fn(async () => device);
    const limits = {};
    Object.setPrototypeOf(limits, { maxBufferSize: 1024 });
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({
          features: new Set(['shader-f16']),
          limits,
          requestDevice,
        })),
      },
    });
    const dispose = vi.fn(async () => {});
    pipelineMock.mockImplementation(async () =>
      Object.assign(async () => new Float32Array([1, 0, 0]), { dispose })
    );
    const runEmbedding = await loadWorker();
    for (const model of ['bge-small', 'minilm']) {
      await runEmbedding({
        deviceHint: 'webgpu',
        id: model,
        model,
        texts: ['hello'],
        type: 'embed',
      });
    }
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(requestDevice).toHaveBeenCalledWith({
      requiredFeatures: ['shader-f16'],
      requiredLimits: { maxBufferSize: 1024 },
    });
    expect(dispose).toHaveBeenCalledOnce();
    for (const [, , options] of pipelineMock.mock.calls) {
      expect(options.session_options.executionProviders).toEqual([{ device, name: 'webgpu' }]);
    }
  });

  it('fences both transports after idle GPU loss without fabricating an active error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    const closeMock = vi.fn();
    const postMessage = vi.fn();
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    vi.stubGlobal('self', {
      addEventListener: (type: string, handler: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') {
          receive = handler;
        }
      },
      close: closeMock,
      onerror: undefined,
      onunhandledrejection: undefined,
      postMessage,
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

    await setWebGpuDevice({
      createCommandEncoder: createCommandEncoderMock,
      lost,
      queue: {
        submit: submitMock,
      },
    });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();

    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'webgpu-guard',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(createCommandEncoderMock).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalled();

    resolveLost?.({ message: 'device was lost', reason: 'destroyed' });
    await flushMicrotasks();
    expect(closeMock).not.toHaveBeenCalled();

    const deviceLostCall = workerEmitMock.mock.calls.find(
      ([event]) => event?.type === 'error' && event?.id === 'device-lost'
    );
    expect(deviceLostCall).toBeUndefined();

    setWebGpuDevice({
      createCommandEncoder: createCommandEncoderMock,
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
    });
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'webgpu-guard-reload',
        model: 'bge-m3',
        texts: ['hello again'],
        type: 'embed',
      })
    ).rejects.toMatchObject({ code: 'EMBEDDING_DEVICE_LOST' });
    receive?.({
      data: {
        request: {
          deviceHint: 'webgpu',
          id: 'idle-stream',
          model: 'bge-m3',
          texts: ['not admitted'],
          type: 'embed',
        },
        type: 'stream-embed',
      },
    } as MessageEvent<unknown>);
    await flushMicrotasks();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST', type: 'worker-lifetime-error' }),
      []
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST', id: 'idle-stream', type: 'error' }),
      []
    );
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('scopes active WebGPU device loss to the workerpool request id', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('self', {
      close: vi.fn(),
      onerror: undefined,
      onunhandledrejection: undefined,
    });
    let resolveLost!: (info: { readonly reason?: string; readonly message: string }) => void;
    await setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise((resolve) => {
        resolveLost = resolve;
      }),
      queue: { submit: vi.fn() },
    });
    let resolveInference!: (value: Float32Array) => void;
    const dispose = vi.fn();
    pipelineMock.mockResolvedValue(
      Object.assign(
        () =>
          new Promise<Float32Array>((resolve) => {
            resolveInference = resolve;
          }),
        { dispose }
      )
    );
    const runEmbedding = await loadWorker();
    const embeddingPromise = runEmbedding({
      deviceHint: 'webgpu',
      id: 'active-device-loss',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });
    await flushMicrotasks();

    await waitForAssertion(() => expect(resolveInference).toBeTypeOf('function'));
    resolveLost({ message: 'device was lost', reason: 'destroyed' });
    await flushMicrotasks();
    expect(workerEmitMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(dispose).not.toHaveBeenCalled();
    const failed = expect(embeddingPromise).rejects.toMatchObject({
      code: 'EMBEDDING_DEVICE_LOST',
      name: 'DeviceLost',
    });
    resolveInference(new Float32Array([1, 0, 0]));
    await failed;
    expect(dispose).toHaveBeenCalledOnce();
    expect(workerEmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'EMBEDDING_DEVICE_LOST',
        id: 'active-device-loss',
        type: 'error',
      })
    );
  });

  it('joins cached GPU disposal before a finishing WASM request announces retirement', async () => {
    const lost = Promise.withResolvers<{ message: string; reason: string }>();
    const disposal = Promise.withResolvers<void>();
    const wasmInference = Promise.withResolvers<Float32Array>();
    const postMessage = vi.fn();
    vi.stubGlobal('self', { postMessage });
    await setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: lost.promise,
      queue: { submit: vi.fn() },
    });
    const dispose = vi.fn(() => disposal.promise);
    const wasmExtract = vi.fn(() => wasmInference.promise);
    pipelineMock
      .mockResolvedValueOnce(Object.assign(async () => new Float32Array([1, 0, 0]), { dispose }))
      .mockResolvedValueOnce(wasmExtract);
    const run = await loadWorker();
    await run({
      deviceHint: 'webgpu',
      id: 'warm-gpu',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });
    const wasm = run({
      deviceHint: 'wasm',
      id: 'active-wasm',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });
    await waitForAssertion(() => expect(wasmExtract).toHaveBeenCalledOnce());
    lost.resolve({ message: 'cached device destroyed', reason: 'destroyed' });
    await waitForAssertion(() => expect(dispose).toHaveBeenCalledOnce());
    wasmInference.resolve(new Float32Array([1, 0, 0]));
    await wasm;
    const prematureNotice = postMessage.mock.calls.some(
      ([event]) => event.type === 'worker-lifetime-error'
    );
    disposal.resolve();
    await flushMicrotasks();
    expect(prematureNotice).toBe(false);
    await waitForAssertion(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST', type: 'worker-lifetime-error' }),
        []
      )
    );
  });

  it('joins failed session disposal and preserves device loss plus the independent cleanup cause', async () => {
    const lost = Promise.withResolvers<{ message: string; reason: string }>();
    const inference = Promise.withResolvers<Float32Array>();
    const disposal = Promise.withResolvers<void>();
    const disposalError = new Error('session disposal rejected');
    await setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: lost.promise,
      queue: { submit: vi.fn() },
    });
    const dispose = vi.fn(() => disposal.promise);
    const extract = vi.fn(() => inference.promise);
    pipelineMock.mockResolvedValue(Object.assign(extract, { dispose }));
    const run = await loadWorker();
    const settled = vi.fn();
    const outcome = run({
      deviceHint: 'webgpu',
      id: 'loss-cleanup',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    }).catch((error: unknown) => {
      settled();
      return error;
    });
    await waitForAssertion(() => expect(extract).toHaveBeenCalledOnce());
    lost.resolve({ message: 'device1 destroyed', reason: 'destroyed' });
    await flushMicrotasks();
    expect(dispose).not.toHaveBeenCalled();
    inference.resolve(new Float32Array([1, 0, 0]));
    await waitForAssertion(() => expect(dispose).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    disposal.reject(disposalError);
    const failure = await outcome;
    expect(failure).toMatchObject({
      cause: expect.any(AggregateError),
      code: 'EMBEDDING_DEVICE_LOST',
    });
    expect((failure as Error).cause).toMatchObject({
      errors: [expect.objectContaining({ code: 'EMBEDDING_DEVICE_LOST' }), disposalError],
    });
    expect(workerEmitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: expect.stringContaining('session disposal rejected'),
        code: 'EMBEDDING_DEVICE_LOST',
        id: 'loss-cleanup',
      })
    );
  });

  it('handles keep-alive tick failures by stopping the timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { gpu: {} });

    await setWebGpuDevice({
      createCommandEncoder: () => {
        throw new Error('encoder unavailable');
      },
      lost: new Promise(() => {}),
      queue: {
        submit: vi.fn(),
      },
    });

    pipelineMock.mockResolvedValue(async () => new Float32Array([1, 0, 0]));
    const runEmbedding = await loadWorker();
    await runEmbedding({
      deviceHint: 'webgpu',
      id: 'webgpu-tick-failure',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(15_000);

    // Additional elapsed time should not invoke another tick because stopKeepAlive() clears the interval.
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it('rejects WebGPU embedding when no WebGPU adapter is available', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await setWebGpuDevice(null);

    const disposeCatchMock = vi.fn();
    const disposeMock = vi.fn(() => ({ catch: disposeCatchMock }));
    pipelineMock.mockResolvedValue(
      Object.assign(async () => new Float32Array([0.2, 0.8]), { dispose: disposeMock })
    );
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'guard-missing-env',
        model: 'bge-m3',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toThrow('WebGPU adapter is unavailable.');
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(disposeMock).not.toHaveBeenCalled();
    expect(disposeCatchMock).not.toHaveBeenCalled();
  });

  it('rejects WebGPU embedding when the adapter returns an invalid device object', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    await setWebGpuDevice(
      Promise.resolve({ lost: Promise.resolve({ message: 'ok' }) } as MockGpuDevice)
    );

    const extractor = async () => new Float32Array([0.2, 0.8]);
    pipelineMock.mockResolvedValue(extractor);
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'guard-invalid-device',
        model: 'bge-m3',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toThrow('WebGPU adapter returned an invalid device.');
    expect('dispose' in extractor).toBe(false);
  });

  it('rejects WebGPU embedding when the device request rejects and retries cleanly', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const rejectedDevice = Promise.reject(new Error('device unavailable'));
    void rejectedDevice.catch(() => {});
    await setWebGpuDevice(rejectedDevice);

    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();
    await expect(
      runEmbedding({
        deviceHint: 'webgpu',
        id: 'guard-device-reject',
        model: 'bge-m3',
        texts: ['hello'],
        type: 'embed',
      })
    ).rejects.toThrow('device unavailable');

    await setWebGpuDevice({
      createCommandEncoder: () => ({ finish: () => ({}) }),
      lost: new Promise(() => {}),
      queue: {
        submit: vi.fn(),
      },
    });
    const result = await runEmbedding({
      deviceHint: 'webgpu',
      id: 'guard-device-retry',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
    });

    expect(result.metadata).toMatchObject({
      device: 'webgpu',
      fallbackApplied: false,
    });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('supports tasks requesting non-default embedding dimensions', async () => {
    const vector = new Float32Array(1024).fill(0.25);
    pipelineMock.mockResolvedValue(async () => vector);
    const runEmbedding = await loadWorker();
    const result = await runEmbedding({
      deviceHint: 'wasm',
      dimensionParameter: 'dimensions',
      id: 'custom-dim',
      model: 'bge-m3',
      provider: 'openai',
      targetDimension: 1024,
      texts: ['hello'],
      type: 'embed',
    });
    expect(result.metadata.dimensions).toBe(1024);
    expect(Array.from(result.vectors[0])).toHaveLength(1024);
  });

  it('validates dimension parameter hints for provider-specific requests', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        dimensionParameter: 'output_dimensionality',
        id: 'invalid-output-dimensionality',
        model: 'bge-m3',
        provider: 'google',
        targetDimension: 0,
        texts: ['test'],
        type: 'embed',
      })
    ).rejects.toThrow('output_dimensionality');

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        dimensionParameter: 'output_dimension',
        id: 'invalid-output-dimension',
        model: 'bge-m3',
        provider: 'cohere',
        targetDimension: Number.POSITIVE_INFINITY,
        texts: ['test'],
        type: 'embed',
      })
    ).rejects.toThrow('output_dimension');

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        dimensionParameter: 'dimensions',
        id: 'invalid-dimensions',
        model: 'bge-m3',
        provider: 'openai',
        targetDimension: -1,
        texts: ['test'],
        type: 'embed',
      })
    ).rejects.toThrow('dimensions');
  });

  it('rejects non-integer and oversized target dimensions', async () => {
    pipelineMock.mockResolvedValue(async () => new Float32Array([0.2, 0.8]));
    const runEmbedding = await loadWorker();

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'invalid-non-integer-dimension',
        model: 'bge-m3',
        targetDimension: 2.5,
        texts: ['test'],
        type: 'embed',
      })
    ).rejects.toThrow('must be an integer');

    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'invalid-large-dimension',
        model: 'bge-m3',
        targetDimension: 20_001,
        texts: ['test'],
        type: 'embed',
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
        deviceHint: 'wasm',
        id: 'bulk',
        model: 'bge-m3',
        texts: Array.from({ length: 32 }, (_, index) => `text-${index}`),
        truncateDim: 2,
        type: 'embed',
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
        deviceHint: 'wasm',
        id: 'empty-output',
        model: 'bge-m3',
        texts: ['nope'],
        type: 'embed',
      })
    ).rejects.toThrow('Embedding pipeline returned no tensors');
    const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
    expect(errorCall?.[0]).toMatchObject({
      id: 'empty-output',
      message: 'Embedding pipeline returned no tensors',
      type: 'error',
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
        deviceHint: 'wasm',
        id: 'numeric-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toThrow('Embedding failed with error code: 42');
    const errorCall = workerEmitMock.mock.calls.find(([event]) => event?.type === 'error');
    expect(errorCall?.[0]).toMatchObject({
      cause: 'Error code: 42 (0x2a)',
      id: 'numeric-error',
      type: 'error',
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
        deviceHint: 'wasm',
        id: 'string-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
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
        deviceHint: 'wasm',
        id: 'undefined-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toThrow('unknown error');

    pipelineMock.mockResolvedValueOnce(async () => {
      // biome-ignore lint/style/useThrowOnlyError: Exercising unknown backend failure shape
      throw null;
    });
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'null-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
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
        deviceHint: 'wasm',
        id: 'object-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
      })
    ).rejects.toThrow('Embedding failed:');

    pipelineMock.mockResolvedValueOnce(async () => {
      throw circular;
    });
    await expect(
      runEmbedding({
        deviceHint: 'wasm',
        id: 'circular-error',
        model: 'bge-m3',
        texts: ['test'],
        truncateDim: 2,
        type: 'embed',
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

    await setWebGpuDevice({
      createCommandEncoder: createCommandEncoderMock,
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
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
      deviceHint: 'webgpu',
      id: 'pause-test',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
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

    await setWebGpuDevice({
      createCommandEncoder: vi.fn<() => MockGpuCommandEncoder>(() => ({ finish: finishMock })),
      lost: new Promise(() => {}),
      queue: { submit: submitMock },
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
      deviceHint: 'webgpu',
      id: 'active-guard',
      model: 'bge-m3',
      texts: ['hello'],
      type: 'embed',
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
      deviceHint: 'wasm',
      id: 'tensor-1d',
      model: 'bge-m3',
      texts: ['single'],
      truncateDim: 3,
      type: 'embed',
    });
    expect(oneDimensional.vectors).toHaveLength(1);
    expect(oneDimensional.vectors[0]).toHaveLength(3);

    pipelineMock.mockResolvedValueOnce(async () => new NestedMockTensor([1, 2, 3], [1, 1, 3]));
    const nested = await runEmbedding({
      deviceHint: 'wasm',
      id: 'tensor-nested',
      model: 'bge-m3',
      texts: ['nested'],
      truncateDim: 3,
      type: 'embed',
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
      deviceHint: 'wasm',
      id: 'tensor',
      model: 'bge-m3',
      texts: Array.from({ length: 9 }, (_, index) => `item-${index}`),
      truncateDim: 3,
      type: 'embed',
    });
    expect(result.vectors).toHaveLength(9);
    expect(Array.from(result.vectors[0])).toHaveLength(3);
    const length = Math.sqrt(result.vectors[0].reduce((sum, value) => sum + value * value, 0));
    expect(length).toBeCloseTo(1, 5);
  });
});
