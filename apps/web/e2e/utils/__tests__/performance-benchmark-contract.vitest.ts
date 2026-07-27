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
    const rerenderBenchmark = source.slice(
      source.indexOf("test('re-render performance tracking'"),
      source.indexOf("test('scroll performance with large datasets'")
    );

    expect(rerenderBenchmark).toContain('measureLocatorInteractionFrames');
    expect(rerenderBenchmark).not.toContain('__renderTracker');
    expect(rerenderBenchmark).not.toContain('waitForTimeout(50)');
  });
});
