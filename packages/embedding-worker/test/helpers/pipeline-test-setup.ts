import { vi } from 'vitest';
import type { EmbedWorkerRequest, EmbedWorkerSuccess } from '../../src';

export const workerEmitMock = vi.fn();
export const transferMock = vi.fn(function TransferStub<T>(value: T) {
  return value;
});
export const pipelineMock = vi.fn();
export const registeredHandlers: {
  runEmbedding?: (payload: EmbedWorkerRequest) => Promise<EmbedWorkerSuccess>;
} = {};

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
  env: { allowRemoteModels: false },
  pipeline: (...args: unknown[]) => pipelineMock(...args),
  Tensor: class MockTensor {
    readonly data: Float32Array;
    readonly dims: readonly number[];
    constructor(values: readonly number[], dims: readonly number[]) {
      this.data = Float32Array.from(values);
      this.dims = dims;
    }
    tolist() {
      return Array.from(this.data);
    }
  },
}));

export function resetMocks(): void {
  vi.resetModules();
  workerEmitMock.mockReset();
  pipelineMock.mockReset();
  transferMock.mockClear();
  registeredHandlers.runEmbedding = undefined;
  vi.unstubAllGlobals();
}

export async function loadWorker() {
  await import('../../src/embedding.worker');
  if (!registeredHandlers.runEmbedding) {
    throw new Error('Embedding worker was not registered');
  }
  return registeredHandlers.runEmbedding;
}

export async function installMockOrtWebGpuDevice(): Promise<void> {
  const transformers = await import('@huggingface/transformers');
  const mockedEnv = transformers.env as {
    allowRemoteModels: boolean;
    backends?: { onnx?: { webgpu?: { device?: unknown } } };
  };
  mockedEnv.backends = {
    onnx: {
      webgpu: {
        device: {
          lost: new Promise(() => {}),
          queue: { submit: vi.fn() },
          createCommandEncoder: () => ({ finish: () => ({}) }),
        },
      },
    },
  };
}

export function makeExtractor(id: string) {
  const disposeMock = vi.fn();
  const extractor = Object.assign(async () => new Float32Array([1, 0, 0]), {
    dispose: disposeMock,
    _id: id,
  });
  return { extractor, disposeMock };
}
