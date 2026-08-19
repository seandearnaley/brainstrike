import type { EmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';
import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingPipelineCacheController } from '../src/pipeline-cache-controller';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;

describe('embedding pipeline cache controller in Chromium', () => {
  it('does not evict a pending WebGPU resource for a concurrent miss', async () => {
    let resolvePending!: (resource: { readonly dispose: () => void }) => void;
    const pendingResource = new Promise<{ readonly dispose: () => void }>((resolve) => {
      resolvePending = resolve;
    });
    const dispose = vi.fn();
    const load = vi.fn(async (model: string) => {
      if (model === 'gpu-pending') {
        return await pendingResource;
      }
      return { dispose: vi.fn() };
    });
    const controller = createEmbeddingPipelineCacheController({
      load,
      publishDiagnostic: vi.fn(),
      workerInstanceId: 'browser-pending-gpu-worker',
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
        dtype: 'fp16',
        estimatedModelBytes: GPU_MODEL_BYTES,
        model: 'gpu-concurrent',
      })
      .catch((error: unknown) => {
        admissionError = error;
      });

    try {
      await vi.waitFor(() => expect(admissionError).toBeInstanceOf(Error), { timeout: 250 });
      expect(load).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
      expect(controller.getResidentEntries()).toMatchObject([
        { cacheKey: 'gpu-pending|webgpu|fp16' },
      ]);
    } finally {
      resolvePending({ dispose });
      await Promise.allSettled([firstLoad, concurrentLoad]);
      await controller.close();
    }
  });

  it('disposes every resident-limit victim across repeated device-class switches', async () => {
    const diagnostics: EmbedWorkerPipelineCacheDiagnostic[] = [];
    const disposedModels: string[] = [];
    let clock = 0;
    const controller = createEmbeddingPipelineCacheController({
      load: async (model: string) => ({
        dispose: () => {
          disposedModels.push(model);
        },
      }),
      now: () => {
        clock += 1;
        return clock;
      },
      publishDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      workerInstanceId: 'browser-worker',
    });

    try {
      for (const model of ['wasm-a', 'wasm-b', 'wasm-c', 'wasm-a', 'wasm-d']) {
        await controller.load({
          device: 'wasm',
          dtype: 'q4',
          estimatedModelBytes: WASM_MODEL_BYTES,
          model,
        });
      }
      for (let index = 0; index < 8; index += 1) {
        await controller.load({
          device: 'wasm',
          dtype: 'q4',
          estimatedModelBytes: WASM_MODEL_BYTES,
          model: `wasm-cycle-${index}`,
        });
      }
      for (const model of ['gpu-a', 'gpu-b']) {
        await controller.load({
          device: 'webgpu',
          dtype: 'fp16',
          estimatedModelBytes: GPU_MODEL_BYTES,
          model,
        });
      }
      for (let index = 0; index < 8; index += 1) {
        await controller.load({
          device: 'webgpu',
          dtype: 'fp16',
          estimatedModelBytes: GPU_MODEL_BYTES,
          model: `gpu-cycle-${index}`,
        });
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
      expect(controller.getResidentEntries()).toHaveLength(4);
    } finally {
      await controller.close();
    }

    expect(disposedModels).toHaveLength(22);
    expect(new Set(disposedModels).size).toBe(22);
  });
});
