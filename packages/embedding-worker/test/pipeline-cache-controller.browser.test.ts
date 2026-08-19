import type { EmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';
import { describe, expect, it } from 'vitest';
import { createEmbeddingPipelineCacheController } from '../src/pipeline-cache-controller';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;

describe('embedding pipeline cache controller in Chromium', () => {
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
