import { expect, test } from '../fixtures/web-fixture';
import { waitForAppLoad } from '../utils/layout-helpers';

const WASM_MODEL_BYTES = 8 * 1024 * 1024;
const GPU_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_LIVE_BYTES = 3 * WASM_MODEL_BYTES + GPU_MODEL_BYTES;
// Structural bound: half the smallest retained 8 MiB model store. Local samples
// qualify the signal but must not tighten the nightly budget (ci-quality contract).
const PROBE_WORKER_PLATEAU_GROWTH_MAX_BYTES = 4 * 1024 * 1024;
const TASK_COUNT = 23;
const VECTOR_TRANSFER_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;

test.describe('Embedding model-switch memory regression', () => {
  test('bounds production-worker JS allocation for WASM and GPU-class proxy switches', async ({
    baseURL,
    page,
  }) => {
    if (!baseURL) {
      throw new Error('BST-369 requires a Playwright baseURL.');
    }
    const appOrigin = new URL(baseURL).origin;
    const browserErrors: string[] = [];
    const crossOriginRequests: string[] = [];
    const modelProxyRequests: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.addInitScript(() => {
      window.__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__ = true;
    });
    await page.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      const isNetworkRequest = requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:';
      if (isNetworkRequest && requestUrl.origin !== appOrigin) {
        crossOriginRequests.push(requestUrl.href);
        await route.abort('blockedbyclient');
        return;
      }
      if (requestUrl.origin === appOrigin && requestUrl.pathname.startsWith('/api/hf/')) {
        modelProxyRequests.push(requestUrl.href);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await waitForAppLoad(page);

    const result = await page
      .evaluate(async () => {
        const hooks = window.__brainstrikeWebE2ETestHooks__;
        if (!hooks?.runEmbeddingModelSwitchMemoryProbe) {
          throw new Error('BST-369 webdriver/init-gated E2E hook is not installed');
        }
        const timeoutMs = 60_000;
        let timeout: number | null = null;
        try {
          return await Promise.race([
            hooks.runEmbeddingModelSwitchMemoryProbe(),
            new Promise<never>((_resolve, reject) => {
              timeout = window.setTimeout(() => {
                const marks = performance
                  .getEntriesByType('mark')
                  .filter((entry) => entry.name.startsWith('bst-369:'))
                  .map((entry) => entry.name);
                reject(
                  new Error(
                    `BST-369 probe timed out after ${timeoutMs}ms; progress=${JSON.stringify(marks)}`
                  )
                );
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timeout !== null) {
            window.clearTimeout(timeout);
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; browserErrors=${JSON.stringify(browserErrors)}`);
      });

    console.info(
      `BST-369 raw memory samples ${JSON.stringify({
        afterTeardown: result.memory.afterTeardown,
        baseline: result.memory.baseline,
        warm: result.memory.warm,
        windowA: result.memory.windowA,
        windowB: result.memory.windowB,
      })}`
    );

    expect(browserErrors).toEqual([]);
    expect(crossOriginRequests).toEqual([]);
    expect(modelProxyRequests).toEqual([]);
    expect(result.beforeTeardown).toEqual({
      estimatedGpuBytes: GPU_MODEL_BYTES,
      estimatedHeapBytes: 3 * WASM_MODEL_BYTES,
      memoryEstimateUnavailableCount: 0,
      residentCount: 4,
    });
    expect(result.afterTeardown).toEqual({
      estimatedGpuBytes: 0,
      estimatedHeapBytes: 0,
      residentCount: 0,
    });
    expect(result.firstWasmEvictedModel).toBe('wasm-b');
    expect(result.firstGpuEvictedModel).toBe('gpu-a');
    expect(result.failureReasons).toEqual([]);
    expect(result.residentLimitEvictionCount).toBe(18);
    expect(result.telemetrySourceRemoved).toBe(true);
    expect(result.transferEventCount).toBe(TASK_COUNT);
    expect(result.transferBytes).toBe(TASK_COUNT * VECTOR_TRANSFER_BYTES);

    expect(result.physical.warm).toMatchObject({
      allocationCount: 6,
      liveBytes: MAX_LIVE_BYTES,
    });
    expect(result.physical.warm.disposedModels).toEqual(['wasm-b', 'gpu-a']);
    expect(result.physical.windowA).toMatchObject({
      allocationCount: 14,
      liveBytes: MAX_LIVE_BYTES,
    });
    expect(result.physical.windowA.disposedModels).toHaveLength(10);
    expect(result.physical.windowB).toMatchObject({
      allocationCount: 22,
      liveBytes: MAX_LIVE_BYTES,
    });
    expect(result.physical.windowB.disposedModels).toHaveLength(18);
    expect(new Set(result.physical.windowB.disposedModels).size).toBe(18);
    expect([...result.physical.windowB.residentModels].sort()).toEqual([
      'gpu-cycle-7',
      'wasm-cycle-5',
      'wasm-cycle-6',
      'wasm-cycle-7',
    ]);

    expect(result.memory.baseline.workerBreakdownCount).toBe(0);
    expect(result.memory.baseline.workerBytes).toBe(0);
    expect(result.memory.warm.workerBreakdownCount).toBeGreaterThan(0);
    expect(result.memory.warm.workerBytes).toBeGreaterThanOrEqual(MAX_LIVE_BYTES);
    expect(result.memory.windowA.workerBreakdownCount).toBeGreaterThan(0);
    expect(result.memory.windowA.workerBytes).toBeGreaterThanOrEqual(MAX_LIVE_BYTES);
    expect(result.memory.windowB.workerBreakdownCount).toBeGreaterThan(0);
    expect(result.memory.windowB.workerBytes).toBeGreaterThanOrEqual(MAX_LIVE_BYTES);
    expect(result.memory.afterTeardown.workerBreakdownCount).toBe(0);
    expect(result.memory.afterTeardown.workerBytes).toBe(0);
    expect(
      Math.max(0, result.memory.windowB.workerBytes - result.memory.windowA.workerBytes)
    ).toBeLessThanOrEqual(PROBE_WORKER_PLATEAU_GROWTH_MAX_BYTES);
  });
});
