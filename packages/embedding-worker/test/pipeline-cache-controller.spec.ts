import type { EmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';
import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingPipelineCacheController } from '../src/pipeline-cache-controller';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;

describe('embedding pipeline cache controller', () => {
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
});
