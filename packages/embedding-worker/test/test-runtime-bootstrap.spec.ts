import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeEmbeddingWorkerTestRuntimeOverride,
  EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
  EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY,
} from '../src/test-runtime-bootstrap';

function runtimeOverride(): {
  readonly runtime: Record<string, unknown>;
  readonly webGpuClassProxy: true;
} {
  return {
    runtime: {
      env: { allowRemoteModels: false },
      pipeline: vi.fn(),
      tensorConstructor: class SyntheticTensor {},
    },
    webGpuClassProxy: true,
  };
}

describe('embedding worker test runtime bootstrap', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY);
    Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY);
  });

  it('leaves normal workers on the real runtime path', () => {
    expect(consumeEmbeddingWorkerTestRuntimeOverride()).toBeNull();
  });

  it('consumes an explicitly attested runtime exactly once', () => {
    const override = runtimeOverride();
    Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
      configurable: true,
      value: {
        automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
        marker: EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
        takeRuntime: () => override,
      },
    });

    expect(consumeEmbeddingWorkerTestRuntimeOverride()).toBe(override);
    expect(Reflect.has(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY)).toBe(false);
    expect(() => consumeEmbeddingWorkerTestRuntimeOverride()).toThrow(
      'Embedding worker test runtime bootstrap window is already closed.'
    );
  });

  it('throws instead of accepting a malformed bootstrap', () => {
    Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
      configurable: true,
      value: {
        automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
        marker: 'wrong-marker',
        takeRuntime: vi.fn(runtimeOverride),
      },
    });

    expect(() => consumeEmbeddingWorkerTestRuntimeOverride()).toThrow(
      'Embedding worker test runtime bootstrap is malformed.'
    );
  });

  it('does not leave a retryable override when runtime construction throws', () => {
    Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
      configurable: true,
      value: {
        automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
        marker: EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
        takeRuntime: () => {
          throw new Error('synthetic runtime construction failed');
        },
      },
    });

    expect(() => consumeEmbeddingWorkerTestRuntimeOverride()).toThrow(
      'synthetic runtime construction failed'
    );
    expect(Reflect.has(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY)).toBe(false);
  });

  it('rejects a bootstrap installed after the module initialization window', () => {
    expect(consumeEmbeddingWorkerTestRuntimeOverride()).toBeNull();
    Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
      configurable: true,
      value: {
        automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
        marker: EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
        takeRuntime: vi.fn(runtimeOverride),
      },
    });

    expect(() => consumeEmbeddingWorkerTestRuntimeOverride()).toThrow(
      'Embedding worker test runtime bootstrap window is already closed.'
    );
  });
});
