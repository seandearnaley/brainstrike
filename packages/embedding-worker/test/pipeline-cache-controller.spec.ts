import type { EmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingPipelineCacheController,
  PIPELINE_SETUP_HEARTBEAT_INTERVAL_MS,
} from '../src/pipeline-cache-controller';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

describe('embedding pipeline cache controller setup liveness (BST-2104)', () => {
  const request = {
    device: 'wasm',
    dtype: 'q8',
    estimatedModelBytes: null,
    model: 'granite',
  } as const;

  function createPendingLoad() {
    let clock = 0;
    let reportSetupProgress: (() => void) | undefined;
    const loaded = createDeferred<{ dispose: () => void }>();
    const controller = createEmbeddingPipelineCacheController({
      load: (_model, _device, _dtype, _revision, onSetupProgress) => {
        reportSetupProgress = onSetupProgress;
        return loaded.promise;
      },
      now: () => clock,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'setup-liveness-worker',
    });
    return {
      advanceTo: (timestamp: number) => {
        clock = timestamp;
      },
      controller,
      loaded,
      report: () => {
        if (!reportSetupProgress) {
          throw new Error('The vendor load has not started.');
        }
        reportSetupProgress();
      },
      started: () => reportSetupProgress !== undefined,
    };
  }

  it('coalesces vendor setup events into heartbeats for every waiting request, one more on ready, then none', async () => {
    const load = createPendingLoad();
    const first = vi.fn();
    const second = vi.fn();
    try {
      const firstLoad = load.controller.load({ ...request, onSetupProgress: first });
      const secondLoad = load.controller.load({ ...request, onSetupProgress: second });
      await vi.waitFor(() => expect(load.started()).toBe(true));

      // Transformers.js calls back per downloaded chunk: 1,000 events inside one second.
      for (let event = 0; event < 1000; event += 1) {
        load.advanceTo(event);
        load.report();
      }
      expect(first.mock.calls.length).toBeLessThanOrEqual(2);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();

      load.advanceTo(PIPELINE_SETUP_HEARTBEAT_INTERVAL_MS);
      load.report();
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);

      const resource = { dispose: vi.fn() };
      load.loaded.resolve(resource);
      await expect(firstLoad).resolves.toBe(resource);
      await expect(secondLoad).resolves.toBe(resource);
      expect(first).toHaveBeenCalledTimes(3);
      expect(second).toHaveBeenCalledTimes(3);

      load.advanceTo(10 * PIPELINE_SETUP_HEARTBEAT_INTERVAL_MS);
      load.report();
      expect(first).toHaveBeenCalledTimes(3);
      expect(second).toHaveBeenCalledTimes(3);
    } finally {
      await load.controller.close();
    }
  });

  it('stops heartbeats when the load fails and still fails every waiting request', async () => {
    const load = createPendingLoad();
    const first = vi.fn();
    const second = vi.fn();
    const failure = new Error('model download failed');
    try {
      const firstLoad = load.controller.load({ ...request, onSetupProgress: first });
      const secondLoad = load.controller.load({ ...request, onSetupProgress: second });
      await vi.waitFor(() => expect(load.started()).toBe(true));
      load.report();
      expect(first).toHaveBeenCalledOnce();

      load.loaded.reject(failure);
      await expect(firstLoad).rejects.toBe(failure);
      await expect(secondLoad).rejects.toBe(failure);
      load.advanceTo(10 * PIPELINE_SETUP_HEARTBEAT_INTERVAL_MS);
      load.report();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      await load.controller.close();
    }
  });

  it('reports no setup for a request served by an already loaded pipeline', async () => {
    const load = createPendingLoad();
    const resource = { dispose: vi.fn() };
    try {
      const initial = load.controller.load(request);
      await vi.waitFor(() => expect(load.started()).toBe(true));
      load.loaded.resolve(resource);
      await initial;

      const onSetupProgress = vi.fn();
      await expect(load.controller.load({ ...request, onSetupProgress })).resolves.toBe(resource);
      expect(onSetupProgress).not.toHaveBeenCalled();
    } finally {
      await load.controller.close();
    }
  });
});

describe('embedding pipeline cache controller', () => {
  it('separates explicitly pinned revisions of the same model and dtype', async () => {
    const load = vi.fn(async () => ({ dispose: vi.fn() }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'pinned-worker',
    });
    const request = {
      device: 'wasm',
      dtype: 'q8',
      estimatedModelBytes: null,
      model: 'minilm',
    } as const;
    try {
      const first = await controller.load({ ...request, revision: 'a'.repeat(40) });
      const second = await controller.load({ ...request, revision: 'b'.repeat(40) });
      expect(first).not.toBe(second);
      expect(await controller.load({ ...request, revision: 'a'.repeat(40) })).toBe(first);
      expect(load).toHaveBeenCalledTimes(2);
      expect(load).toHaveBeenNthCalledWith(
        1,
        'minilm',
        'wasm',
        'q8',
        'a'.repeat(40),
        expect.any(Function)
      );
      expect(load).toHaveBeenNthCalledWith(
        2,
        'minilm',
        'wasm',
        'q8',
        'b'.repeat(40),
        expect.any(Function)
      );
    } finally {
      await controller.close();
    }
  });
  it('rejects invalid identity and load metadata before invoking the loader', async () => {
    const load = vi.fn(async () => ({ dispose: vi.fn() }));

    expect(() =>
      createEmbeddingPipelineCacheController({
        load,
        publishDiagnostic: vi.fn(),
        workerInstanceId: '',
      })
    ).toThrow('Embedding pipeline cache requires a worker instance identity.');

    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'validation-worker',
    });
    await expect(
      controller.load({
        device: 'wasm',
        dtype: 'q8',
        estimatedModelBytes: null,
        model: 'minilm',
        revision: '',
      })
    ).rejects.toThrow('Embedding pipeline revision must be a non-empty string.');
    await expect(
      controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model: '',
      })
    ).rejects.toThrow('Embedding pipeline cache requires a non-empty model identifier.');
    await expect(
      controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: 0,
        model: 'invalid-bytes',
      })
    ).rejects.toThrow('Embedding pipeline cache model bytes must be a positive safe integer.');
    expect(load).not.toHaveBeenCalled();
    await controller.close();
  });

  it('keeps repeated WASM and GPU-class model switches within their resident limits', async () => {
    const diagnostics: EmbedWorkerPipelineCacheDiagnostic[] = [];
    const disposedCacheKeys: string[] = [];
    const disposedModels: string[] = [];
    let clock = 0;
    const load = vi.fn(async (model: string) => ({
      dispose: () => {
        disposedModels.push(model);
      },
    }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      now: () => {
        clock += 1;
        return clock;
      },
      onDisposed: ({ cacheKey }) => {
        disposedCacheKeys.push(cacheKey);
      },
      publishDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      workerInstanceId: 'unit-worker',
    });

    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };
    const loadGpu = async (model: string): Promise<void> => {
      await controller.load({
        device: 'webgpu',
        dtype: 'fp16',
        estimatedModelBytes: GPU_MODEL_BYTES,
        model,
      });
    };

    try {
      await loadWasm('wasm-a');
      await loadWasm('wasm-b');
      await loadWasm('wasm-c');
      await loadWasm('wasm-a');
      await loadWasm('wasm-d');
      for (let index = 0; index < 8; index += 1) {
        await loadWasm(`wasm-cycle-${index}`);
      }

      await loadGpu('gpu-a');
      await loadGpu('gpu-b');
      for (let index = 0; index < 8; index += 1) {
        await loadGpu(`gpu-cycle-${index}`);
      }

      await controller.waitForPendingDisposals();

      const evictions = diagnostics.filter(
        (diagnostic) => diagnostic.event === 'evicted' && diagnostic.reason === 'resident-limit'
      );
      expect(evictions).toHaveLength(18);
      expect(evictions[0]?.entry?.model).toBe('wasm-b');
      expect(evictions[9]?.entry?.model).toBe('gpu-a');
      expect(disposedModels).toHaveLength(18);
      expect(new Set(disposedModels).size).toBe(18);
      expect(controller.getResidentEntries()).toMatchObject([
        { device: 'wasm', model: 'wasm-cycle-5' },
        { device: 'wasm', model: 'wasm-cycle-6' },
        { device: 'wasm', model: 'wasm-cycle-7' },
        { device: 'webgpu', model: 'gpu-cycle-7' },
      ]);
    } finally {
      await controller.close();
    }

    expect(disposedModels).toHaveLength(22);
    expect(new Set(disposedModels).size).toBe(22);
    expect(disposedCacheKeys).toEqual(
      disposedModels.map((model) =>
        model.startsWith('gpu') ? `${model}|webgpu|fp16` : `${model}|wasm|q4`
      )
    );
  });

  it('reports rejected pipeline loads with their complete debug context', async () => {
    const loadError = new Error('loader exploded');
    const onLoadFailed = vi.fn();
    const controller = createEmbeddingPipelineCacheController({
      load: vi.fn().mockRejectedValue(loadError),
      onLoadFailed,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'failed-load-worker',
    });

    try {
      await expect(
        controller.load({
          device: 'webgpu',
          dtype: 'fp16',
          estimatedModelBytes: GPU_MODEL_BYTES,
          model: 'broken-model',
        })
      ).rejects.toBe(loadError);
      expect(onLoadFailed).toHaveBeenCalledOnce();
      expect(onLoadFailed).toHaveBeenCalledWith({
        device: 'webgpu',
        dtype: 'fp16',
        error: loadError,
        model: 'broken-model',
      });
    } finally {
      await controller.close();
    }
  });

  it('does not invoke the loader when the cache clock is invalid', async () => {
    const load = vi.fn(async () => ({ dispose: vi.fn() }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      now: () => Number.NaN,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'invalid-clock-worker',
    });

    await expect(
      controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model: 'must-not-allocate',
      })
    ).rejects.toThrow('Embedding pipeline cache clock must return a non-negative finite number.');
    await Promise.resolve();

    expect(load).not.toHaveBeenCalled();
    await controller.close();
  });

  it('does not evict a resident before rejecting an invalid cache clock', async () => {
    const disposedModels: string[] = [];
    let clock = 0;
    let clockIsValid = true;
    const load = vi.fn(async (model: string) => ({
      dispose: () => {
        disposedModels.push(model);
      },
    }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      now: () => {
        if (!clockIsValid) {
          return Number.NaN;
        }
        clock += 1;
        return clock;
      },
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'invalid-replacement-clock-worker',
    });
    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };

    try {
      await loadWasm('wasm-a');
      await loadWasm('wasm-b');
      await loadWasm('wasm-c');
      const residentsBeforeRejection = controller
        .getResidentEntries()
        .map((entry) => entry.cacheKey);

      clockIsValid = false;
      await expect(loadWasm('wasm-d')).rejects.toThrow(
        'Embedding pipeline cache clock must return a non-negative finite number.'
      );
      await Promise.resolve();

      expect(load).toHaveBeenCalledTimes(3);
      expect(disposedModels).toEqual([]);
      clockIsValid = true;
      expect(controller.getResidentEntries().map((entry) => entry.cacheKey)).toEqual(
        residentsBeforeRejection
      );
    } finally {
      clockIsValid = true;
      await controller.close();
    }
  });

  it('awaits asynchronous resident-limit disposal before allocating the replacement', async () => {
    const disposalStarted = createDeferred<void>();
    const releaseDisposal = createDeferred<void>();
    const physicallyLiveModels = new Set<string>();
    const load = vi.fn(async (model: string) => {
      physicallyLiveModels.add(model);
      return {
        dispose: async (): Promise<void> => {
          disposalStarted.resolve();
          await releaseDisposal.promise;
          physicallyLiveModels.delete(model);
        },
      };
    });
    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'async-disposal-worker',
    });

    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };

    try {
      await loadWasm('wasm-a');
      await loadWasm('wasm-b');
      await loadWasm('wasm-c');

      const replacement = loadWasm('wasm-d');
      const duplicateReplacement = loadWasm('wasm-d');
      await disposalStarted.promise;

      expect(load).toHaveBeenCalledTimes(3);
      expect(physicallyLiveModels).toEqual(new Set(['wasm-a', 'wasm-b', 'wasm-c']));

      releaseDisposal.resolve();
      await Promise.all([replacement, duplicateReplacement]);

      expect(load).toHaveBeenCalledTimes(4);
      expect(physicallyLiveModels).toEqual(new Set(['wasm-b', 'wasm-c', 'wasm-d']));
    } finally {
      releaseDisposal.resolve();
      await controller.close();
    }
  });

  it('rejects replacement loading when resident-limit disposal fails', async () => {
    const disposalError = new Error('physical release failed');
    const diagnostics: EmbedWorkerPipelineCacheDiagnostic[] = [];
    const onDisposeFailed = vi.fn();
    const onLoadFailed = vi.fn();
    const load = vi.fn(async (model: string) => ({
      dispose: async (): Promise<void> => {
        if (model === 'wasm-a') {
          throw disposalError;
        }
      },
    }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      onDisposeFailed,
      onLoadFailed,
      publishDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      workerInstanceId: 'failed-disposal-worker',
    });
    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };

    let closeFailureObserved = false;
    try {
      await loadWasm('wasm-a');
      await loadWasm('wasm-b');
      await loadWasm('wasm-c');

      await expect(
        controller.load({
          device: 'wasm',
          diagnostics: { id: 'replacement' },
          dtype: 'q4',
          estimatedModelBytes: WASM_MODEL_BYTES,
          model: 'wasm-d',
        })
      ).rejects.toBe(disposalError);
      expect(load).toHaveBeenCalledTimes(3);
      expect(onDisposeFailed).toHaveBeenCalledExactlyOnceWith({
        cacheKey: 'wasm-a|wasm|q4',
        error: disposalError,
        reason: 'resident-limit',
      });
      expect(onLoadFailed).toHaveBeenCalledExactlyOnceWith({
        device: 'wasm',
        dtype: 'q4',
        error: disposalError,
        model: 'wasm-d',
      });
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          event: 'load-failed',
          id: 'replacement',
          reason: 'load-failure',
        })
      );
      await expect(loadWasm('wasm-e')).rejects.toThrow(
        'Embedding pipeline cache cannot load after a resource disposal failure.'
      );
      expect(load).toHaveBeenCalledTimes(3);

      await expect(controller.close()).rejects.toBe(disposalError);
      closeFailureObserved = true;
    } finally {
      if (!closeFailureObserved) {
        await controller.close().catch(() => undefined);
      }
    }
  });

  it('preserves a resident-disposal failure when close races the pending replacement', async () => {
    const disposalStarted = createDeferred<void>();
    const releaseDisposal = createDeferred<void>();
    const disposalError = new Error('resident release failed during close');
    const controller = createEmbeddingPipelineCacheController({
      load: vi.fn(async (model: string) => ({
        dispose: async (): Promise<void> => {
          if (model === 'wasm-a') {
            disposalStarted.resolve();
            await releaseDisposal.promise;
            throw disposalError;
          }
        },
      })),
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'replacement-close-race-worker',
    });
    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };

    await loadWasm('wasm-a');
    await loadWasm('wasm-b');
    await loadWasm('wasm-c');
    const replacement = loadWasm('wasm-d');
    let close: Promise<void> | null = null;

    try {
      await disposalStarted.promise;
      close = controller.close();
      const replacementFailure = expect(replacement).rejects.toBe(disposalError);
      const closeFailure = expect(close).rejects.toBe(disposalError);

      releaseDisposal.resolve();
      await Promise.all([replacementFailure, closeFailure]);
    } finally {
      releaseDisposal.resolve();
      await Promise.allSettled([replacement, ...(close ? [close] : [])]);
    }
  });

  it('keeps concurrent distinct replacements physically bounded', async () => {
    const releaseA = createDeferred<void>();
    const releaseB = createDeferred<void>();
    const physicallyLiveModels = new Set<string>();
    let peakPhysicalResidents = 0;
    const load = vi.fn(async (model: string) => {
      physicallyLiveModels.add(model);
      peakPhysicalResidents = Math.max(peakPhysicalResidents, physicallyLiveModels.size);
      return {
        dispose: async (): Promise<void> => {
          if (model === 'wasm-a') {
            await releaseA.promise;
          } else if (model === 'wasm-b') {
            await releaseB.promise;
          }
          physicallyLiveModels.delete(model);
        },
      };
    });
    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'concurrent-disposal-worker',
    });
    const loadWasm = async (model: string): Promise<void> => {
      await controller.load({
        device: 'wasm',
        dtype: 'q4',
        estimatedModelBytes: WASM_MODEL_BYTES,
        model,
      });
    };

    try {
      await loadWasm('wasm-a');
      await loadWasm('wasm-b');
      await loadWasm('wasm-c');

      const replacementD = loadWasm('wasm-d');
      const replacementE = loadWasm('wasm-e');
      await Promise.resolve();

      expect(load).toHaveBeenCalledTimes(3);
      expect(physicallyLiveModels.size).toBe(3);

      releaseB.resolve();
      await replacementE;
      expect(physicallyLiveModels).toEqual(new Set(['wasm-a', 'wasm-c', 'wasm-e']));

      releaseA.resolve();
      await replacementD;
      expect(physicallyLiveModels).toEqual(new Set(['wasm-c', 'wasm-d', 'wasm-e']));
      expect(peakPhysicalResidents).toBe(3);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await controller.close();
    }
  });

  it('rejects a concurrent WebGPU miss until its pending resident becomes evictable', async () => {
    const pendingGpuLoad = createDeferred<{ readonly dispose: () => void }>();
    const firstDispose = vi.fn();
    const secondResource = { dispose: vi.fn() };
    const diagnostics: EmbedWorkerPipelineCacheDiagnostic[] = [];
    const onLoadFailed = vi.fn();
    const load = vi.fn(async (model: string) => {
      if (model === 'gpu-pending') {
        return await pendingGpuLoad.promise;
      }
      return secondResource;
    });
    const controller = createEmbeddingPipelineCacheController({
      load,
      onLoadFailed,
      publishDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      workerInstanceId: 'pending-gpu-worker',
    });
    const firstLoad = controller.load({
      device: 'webgpu',
      dtype: 'fp16',
      estimatedModelBytes: GPU_MODEL_BYTES,
      model: 'gpu-pending',
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let admissionError: unknown;
    const concurrentLoad = controller
      .load({
        device: 'webgpu',
        diagnostics: { id: 'gpu-concurrent' },
        dtype: 'fp16',
        estimatedModelBytes: GPU_MODEL_BYTES,
        model: 'gpu-concurrent',
      })
      .catch((error: unknown) => {
        admissionError = error;
        return secondResource;
      });

    try {
      await vi.waitFor(() => expect(admissionError).toBeInstanceOf(Error), { timeout: 250 });
      expect(admissionError).toMatchObject({
        message:
          'Embedding pipeline cache cannot admit a webgpu load because every resident slot is pending.',
      });
      expect(load).toHaveBeenCalledTimes(1);
      expect(firstDispose).not.toHaveBeenCalled();
      expect(controller.getResidentEntries()).toMatchObject([
        { cacheKey: 'gpu-pending|webgpu|fp16', model: 'gpu-pending' },
      ]);
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ event: 'evicted', reason: 'resident-limit' })
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          cacheSize: 1,
          event: 'load-failed',
          id: 'gpu-concurrent',
          reason: 'load-failure',
        })
      );
      expect(onLoadFailed).toHaveBeenCalledWith({
        device: 'webgpu',
        dtype: 'fp16',
        error: admissionError,
        model: 'gpu-concurrent',
      });

      const firstResource = { dispose: firstDispose };
      pendingGpuLoad.resolve(firstResource);
      await expect(firstLoad).resolves.toBe(firstResource);
      await expect(concurrentLoad).resolves.toBe(secondResource);

      await expect(
        controller.load({
          device: 'webgpu',
          dtype: 'fp16',
          estimatedModelBytes: GPU_MODEL_BYTES,
          model: 'gpu-concurrent',
        })
      ).resolves.toBe(secondResource);
      expect(firstDispose).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      pendingGpuLoad.resolve({ dispose: firstDispose });
      await Promise.allSettled([firstLoad, concurrentLoad]);
      await controller.close();
    }
  });

  it('does not idle-evict a pending pipeline and later deliver its disposed resource', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const pendingLoad = createDeferred<{ readonly dispose: () => void }>();
    const dispose = vi.fn();
    const diagnostics: EmbedWorkerPipelineCacheDiagnostic[] = [];
    const controller = createEmbeddingPipelineCacheController({
      load: async () => await pendingLoad.promise,
      now: () => clock,
      publishDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      workerInstanceId: 'pending-idle-worker',
    });
    const load = controller.load({
      device: 'wasm',
      dtype: 'q4',
      estimatedModelBytes: WASM_MODEL_BYTES,
      model: 'slow-pending-model',
    });

    try {
      await Promise.resolve();
      clock = 5 * 60 * 1000 + 1;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(controller.getResidentEntries()).toMatchObject([
        { cacheKey: 'slow-pending-model|wasm|q4' },
      ]);
      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ event: 'evicted', reason: 'idle-timeout' })
      );

      const resource = { dispose };
      pendingLoad.resolve(resource);
      await expect(load).resolves.toBe(resource);

      const readyAt = clock;
      clock = readyAt + 1;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.getResidentEntries()).toMatchObject([
        { cacheKey: 'slow-pending-model|wasm|q4', lastUsedAt: readyAt },
      ]);
      expect(dispose).not.toHaveBeenCalled();

      clock = readyAt + 5 * 60 * 1000 + 1;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.getResidentEntries()).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      pendingLoad.resolve({ dispose });
      await Promise.allSettled([load]);
      await controller.close();
      vi.useRealTimers();
    }
  });

  it('joins invalidated GPU retirement before loading a replacement session', async () => {
    const release = createDeferred<void>();
    const started = createDeferred<void>();
    const load = vi.fn(async () => ({
      dispose: async (): Promise<void> => {
        started.resolve();
        await release.promise;
      },
    }));
    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'lost-device-retirement',
    });
    const request = {
      device: 'webgpu',
      dtype: 'fp16',
      estimatedModelBytes: GPU_MODEL_BYTES,
      model: 'gpu-a',
    } as const;
    await controller.load(request);
    controller.invalidateWebGpuPipelines();
    await started.promise;
    const replacement = controller.load(request);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(load).toHaveBeenCalledOnce();
      release.resolve();
      await replacement;
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await replacement;
      await controller.close();
    }
  });

  it('surfaces a settled background disposal failure through wait and close', async () => {
    const disposalError = new Error('device-lost release failed');
    const onDisposeFailed = vi.fn();
    const controller = createEmbeddingPipelineCacheController({
      load: vi.fn(async () => ({
        dispose: async (): Promise<void> => {
          throw disposalError;
        },
      })),
      onDisposeFailed,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'background-disposal-worker',
    });

    await controller.load({
      device: 'webgpu',
      dtype: 'fp16',
      estimatedModelBytes: GPU_MODEL_BYTES,
      model: 'gpu-a',
    });
    controller.invalidateWebGpuPipelines();

    await expect(controller.waitForPendingDisposals()).rejects.toBe(disposalError);
    expect(onDisposeFailed).toHaveBeenCalledExactlyOnceWith({
      cacheKey: 'gpu-a|webgpu|fp16',
      error: disposalError,
      reason: 'device-lost',
    });
    await expect(controller.close()).rejects.toBe(disposalError);
  });

  it('preserves multiple disposal failures in one aggregate close error', async () => {
    const firstError = new Error('first physical release failed');
    const secondError = new Error('second physical release failed');
    const controller = createEmbeddingPipelineCacheController({
      load: vi.fn(async (model: string) => ({
        dispose: async (): Promise<void> => {
          throw model === 'wasm-a' ? firstError : secondError;
        },
      })),
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'aggregate-disposal-worker',
    });

    await controller.load({
      device: 'wasm',
      dtype: 'q4',
      estimatedModelBytes: WASM_MODEL_BYTES,
      model: 'wasm-a',
    });
    await controller.load({
      device: 'wasm',
      dtype: 'q4',
      estimatedModelBytes: WASM_MODEL_BYTES,
      model: 'wasm-b',
    });

    let closeError: unknown;
    try {
      await controller.close();
    } catch (error) {
      closeError = error;
    }
    if (!(closeError instanceof AggregateError)) {
      throw new Error('Expected close to preserve both disposal failures in an AggregateError.');
    }
    expect(closeError.errors).toEqual([firstError, secondError]);
  });
});
