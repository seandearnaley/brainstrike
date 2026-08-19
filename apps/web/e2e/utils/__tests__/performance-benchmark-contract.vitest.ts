import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const benchmarkSource = async (): Promise<string> =>
  await readFile(path.join(process.cwd(), 'e2e/performance/benchmarks.test.ts'), 'utf8');

describe('performance benchmark measurement contracts', () => {
  it('measures file selection at the browser interaction-to-paint boundary', async () => {
    const source = await benchmarkSource();
    const start = source.indexOf("test('baseline performance benchmark'");
    const end = source.indexOf("test('re-render performance tracking'");

    expect(start, 'baseline benchmark anchor not found').toBeGreaterThanOrEqual(0);
    expect(end, 're-render benchmark anchor not found').toBeGreaterThan(start);
    const baselineBenchmark = source.slice(start, end);

    expect(baselineBenchmark).toContain('measureLocatorInteractionFrames');
    expect(baselineBenchmark).toContain('name: /^Select (file1\\.ts|file2\\.js|README\\.md)$/');
    expect(baselineBenchmark).toContain('fileCheckboxes.first()).toBeVisible');
    expect(baselineBenchmark).toContain('CHECKBOX_FRAME_TOTAL_MAX_MS');
    expect(baselineBenchmark).toContain('CHECKBOX_FRAME_MAX_MS');
    expect(baselineBenchmark).not.toContain('PERFORMANCE_THRESHOLDS.FILE_SELECTION_MAX_MS');
  });

  it('measures re-render latency at the browser interaction-to-paint boundary', async () => {
    const source = await benchmarkSource();
    const start = source.indexOf("test('re-render performance tracking'");
    const end = source.indexOf("test('scroll performance with large datasets'");

    expect(start, 're-render benchmark anchor not found').toBeGreaterThanOrEqual(0);
    expect(end, 'scroll benchmark anchor not found').toBeGreaterThan(start);
    const rerenderBenchmark = source.slice(start, end);

    expect(rerenderBenchmark).toContain('fileCheckboxes.first()).toBeVisible');
    expect(rerenderBenchmark).toContain('measureLocatorInteractionFrames');
    expect(rerenderBenchmark).toContain('Checkbox Interaction-to-Paint Average');
    expect(rerenderBenchmark).toContain('Checkbox Interaction-to-Paint Max');
    expect(rerenderBenchmark).toContain('CHECKBOX_FRAME_AVERAGE_MAX_MS');
    expect(rerenderBenchmark).toContain('CHECKBOX_FRAME_MAX_MS');
    expect(rerenderBenchmark).not.toContain('PERFORMANCE_THRESHOLDS.RENDER_TIME_MAX_MS');
    expect(rerenderBenchmark).not.toContain('__renderTracker');
    expect(rerenderBenchmark).not.toContain('waitForTimeout(50)');
  });

  it('measures scroll latency at the browser interaction-to-paint boundary', async () => {
    const source = await benchmarkSource();
    const start = source.indexOf("test('scroll performance with large datasets'");
    const end = source.indexOf('\n  test(', start + 1);

    expect(start).toBeGreaterThan(-1);
    const scrollBenchmark = source.slice(start, end === -1 ? undefined : end);
    expect(scrollBenchmark).toContain('explorer.fileTreeViewport');
    expect(scrollBenchmark).toContain("kind: 'scroll-first'");
    expect(scrollBenchmark).toContain('steps: 5');
    expect(scrollBenchmark).toContain('SCROLL_FRAME_TOTAL_MAX_MS');
    expect(scrollBenchmark).toContain('SCROLL_FRAME_MAX_MS');
    expect(scrollBenchmark).not.toContain('SCROLL_PERFORMANCE_MAX_MS');
    expect(scrollBenchmark).not.toContain("performance.mark('scroll-test-start')");
    expect(scrollBenchmark).not.toContain('waitForTimeout(100)');
  });

  it('measures the shallow-comparison validation at the browser interaction-to-paint boundary', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'e2e/performance/validation.test.ts'),
      'utf8'
    );
    const start = source.indexOf("test('validate shallow comparison fix works'");
    const end = source.indexOf("test('validate file size limits work'");

    expect(start, 'shallow-comparison validation anchor not found').toBeGreaterThanOrEqual(0);
    expect(end, 'file-size validation anchor not found').toBeGreaterThan(start);
    const validation = source.slice(start, end);

    expect(validation).toContain('measureLocatorInteractionFrames');
    expect(validation).toContain('name: /^Select (test1\\.js|test2\\.js)$/');
    // BST-959: the fixture is fully known, so the checkbox count is asserted
    // (a partially rendered tree fails instead of shrinking the measured
    // set), the quantity is browser-side, and the budget is the sibling
    // benchmark's CI-proven CHECKBOX_FRAME threshold — not the legacy
    // wall-clock 2,000ms constant, which is vacuous over this quantity.
    expect(validation).toContain('expect(fileCheckboxes).toHaveCount(2)');
    expect(validation).toContain('PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_TOTAL_MAX_MS');
    expect(validation).not.toContain('toBeLessThan(2000)');
    expect(validation).not.toContain('Date.now()');
    expect(validation).not.toContain('waitForTimeout(');
    expect(validation).not.toContain('__renderCounter');
  });

  it('runs the embedding model-switch regression through the typed webdriver hook', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'e2e/performance/embedding-model-switch-memory.test.ts'),
      'utf8'
    );

    expect(source).toContain('hooks.runEmbeddingModelSwitchMemoryProbe()');
    expect(source).toContain('expect(modelRequests).toEqual([])');
    expect(source).toContain('residentLimitEvictionCount).toBe(18)');
    expect(source).toContain("firstWasmEvictedModel).toBe('wasm-b')");
    expect(source).toContain("firstGpuEvictedModel).toBe('gpu-a')");
    expect(source).not.toContain('Record<string, unknown>');
    expect(source).not.toContain('as ModelSwitchMemoryProbeResult');
    expect(source).not.toContain('waitForTimeout(');
  });
});
