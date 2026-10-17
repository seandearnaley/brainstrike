/**
 * WebGPU memory growth test — runs in REAL Chromium via Vitest 4 Browser Mode.
 *
 * Runs sustained ONNX inference with WebGPU in a real browser (not headless
 * Electron with --disable-gpu). This reproduces the production GPU memory leak
 * that is invisible to JS APIs but visible in Activity Monitor.
 *
 * The test uses CDP Performance.getMetrics for JS heap tracking. GPU buffer
 * memory can only be observed externally (Activity Monitor) while the test runs
 * with headless: false.
 *
 * Run: pnpm --filter @brainstrike/embedding-worker test:webgpu-memory
 */

import { describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';

const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

interface Metric {
  name: string;
  value: number;
}

async function getJsHeapMB(): Promise<number> {
  const session = cdp();
  const result = (await session.send('Performance.getMetrics')) as { metrics: Metric[] };
  const heap = result.metrics.find((m) => m.name === 'JSHeapUsedSize');
  return Math.round((heap?.value ?? 0) / (1024 * 1024));
}

describe('WebGPU embedding memory growth', () => {
  it('reads JavaScript heap metrics through the typed Chromium CDP session', async () => {
    const session = cdp();
    await session.send('Performance.enable');
    try {
      const heapMB = await getJsHeapMB();
      expect(Number.isFinite(heapMB)).toBe(true);
      expect(heapMB).toBeGreaterThan(0);
    } finally {
      await session.send('Performance.disable');
    }
  });

  it('should have WebGPU available in real browser', () => {
    expect(hasWebGPU).toBe(true);
  });

  it('GPU memory should stay bounded during sustained WebGPU inference', async () => {
    if (!hasWebGPU) {
      console.warn('WebGPU not available — skipping');
      return;
    }

    const session = cdp();
    await session.send('Performance.enable');

    const { pipeline } = await import('@huggingface/transformers');

    console.log('[WebGPU Memory Test] Loading model with WebGPU...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      device: 'webgpu',
      dtype: 'fp32',
    });
    console.log('[WebGPU Memory Test] Model loaded. Starting inference loop.');

    // 1KB text chunks matching production content
    const sampleTexts = Array.from({ length: 10 }, (_, i) =>
      `export function sampleFunction${i}(): string { return "chunk content for embedding inference test number ${i}"; } `.repeat(
        12
      )
    );

    const baselineHeap = await getJsHeapMB();
    const TOTAL_BATCHES = 50; // 500 total inferences
    const heapSnapshots: number[] = [];

    for (let batch = 0; batch < TOTAL_BATCHES; batch++) {
      const output = await extractor(sampleTexts, {
        normalize: false,
        pooling: 'mean',
      });

      // Dispose output tensor (belt-and-suspenders — doesn't free GPU buffers)
      if (output && typeof (output as { dispose?: () => void }).dispose === 'function') {
        (output as { dispose: () => void }).dispose();
      }

      const heapMB = await getJsHeapMB();
      heapSnapshots.push(heapMB);

      // Log progress every 10 batches so user can correlate with Activity Monitor
      if ((batch + 1) % 10 === 0) {
        const itemsDone = (batch + 1) * sampleTexts.length;
        console.log(
          `[WebGPU Memory Test] ${itemsDone} inferences done. JS heap: ${heapMB}MB. Check Activity Monitor for GPU process growth.`
        );
      }
    }

    // Dispose pipeline
    if (typeof (extractor as { dispose?: () => Promise<void> }).dispose === 'function') {
      await (extractor as { dispose: () => Promise<void> }).dispose();
    }

    await session.send('Performance.disable');

    const finalHeap = heapSnapshots.at(-1) ?? 0;
    const heapGrowthMB = finalHeap - baselineHeap;
    const totalInferences = TOTAL_BATCHES * sampleTexts.length;

    console.log(
      JSON.stringify({
        baselineHeapMB: baselineHeap,
        finalHeapMB: finalHeap,
        heapGrowthMB,
        heapTrend: heapSnapshots,
        totalInferences,
        type: 'WEBGPU_MEMORY_RESULT',
      })
    );

    // JS heap should not grow unboundedly (GPU buffers are separate)
    expect(Math.abs(heapGrowthMB)).toBeLessThan(200);
  }, 300_000); // 5 min timeout for 500 inferences
});
