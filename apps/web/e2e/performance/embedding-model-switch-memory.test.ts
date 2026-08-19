import { expect, test } from '../fixtures/web-fixture';
import { waitForAppLoad } from '../utils/layout-helpers';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;

test.describe('Embedding model-switch memory regression', () => {
  test('keeps WASM and GPU-class pipeline residency bounded without model downloads', async ({
    page,
  }) => {
    const modelRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (/huggingface\.co|cdn-lfs\.hf\.co|hf-mirror\.com/u.test(url)) {
        modelRequests.push(url);
      }
    });

    await page.goto('/');
    await waitForAppLoad(page);

    const result = await page.evaluate(async () => {
      const hooks = window.__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Web E2E hooks are not installed');
      }
      return await hooks.runEmbeddingModelSwitchMemoryProbe();
    });

    expect(modelRequests).toEqual([]);
    expect(result.beforeTeardown).toEqual({
      estimatedGpuBytes: GPU_MODEL_BYTES,
      estimatedHeapBytes: 3 * WASM_MODEL_BYTES,
      memoryEstimateUnavailableCount: 0,
      residentCount: 4,
    });
    expect(result.firstWasmEvictedModel).toBe('wasm-b');
    expect(result.firstGpuEvictedModel).toBe('gpu-a');
    expect(result.residentLimitEvictionCount).toBe(18);
    expect(result.disposedModels).toHaveLength(22);
    expect(new Set(result.disposedModels).size).toBe(22);
    expect(result.disposedModels.slice(-4)).toEqual([
      'wasm-cycle-5',
      'wasm-cycle-6',
      'wasm-cycle-7',
      'gpu-cycle-7',
    ]);
    expect(result.health).toEqual({ failureCount: 0, lastFailure: null });
    expect(result.afterTeardown).toEqual({
      estimatedGpuBytes: 0,
      estimatedHeapBytes: 0,
      residentCount: 0,
    });
  });
});
