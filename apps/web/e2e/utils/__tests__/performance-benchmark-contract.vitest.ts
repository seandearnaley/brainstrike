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
    expect(validation).toContain('fileCheckboxes.first()).toBeVisible');
    // BST-959: the 2,000ms gate is preserved from the wall-clock era until a
    // controlled baseline proves a different budget — and the measured
    // quantity must stay browser-side.
    expect(validation).toContain('expect(selectionMetrics.totalDurationMs).toBeLessThan(2000)');
    expect(validation).not.toContain('Date.now()');
    expect(validation).not.toContain('waitForTimeout(');
    expect(validation).not.toContain('__renderCounter');
  });
});
