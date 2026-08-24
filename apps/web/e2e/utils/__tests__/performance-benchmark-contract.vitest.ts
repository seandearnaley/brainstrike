import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const benchmarkSource = async (): Promise<string> =>
  await readFile(path.join(process.cwd(), 'e2e/performance/benchmarks.test.ts'), 'utf8');

const MODEL_SWITCH_SOURCE_FILES = [
  'src/embedding-model-switch-memory-probe.ts',
  'src/embedding-model-switch-memory-probe.worker.ts',
  'src/embedding-model-switch-memory-measurement.ts',
  'src/embedding-model-switch-memory-probe-contract.ts',
] as const;
const EXPECTED_MODEL_SWITCH_COVERAGE_EXCLUSIONS = MODEL_SWITCH_SOURCE_FILES.slice(0, 2);

function githubExpression(expression: string): string {
  return ['$', `{{ ${expression} }}`].join('');
}

const PERFORMANCE_PROJECT_FALLBACK = `PERF_PROJECT: ${githubExpression(
  "github.event.inputs.project || 'performance'"
)}`;
const EMPTY_PERFORMANCE_GREP_FALLBACK = `PERF_GREP: ${githubExpression(
  "github.event.inputs.grep || ''"
)}`;

function assertModelSwitchCoverageOwnership(vitestConfig: string): void {
  const coverageExcludeBlock =
    /coverage:\s*\{[\s\S]*?exclude:\s*\[([\s\S]*?)\][\s\S]*?include:/u.exec(vitestConfig)?.[1];
  if (coverageExcludeBlock === undefined) {
    throw new Error('Web coverage exclude block not found.');
  }
  const exclusionPatterns = [...coverageExcludeBlock.matchAll(/['"]([^'"]+)['"]/gu)].map(
    (match) => {
      const pattern = match[1];
      if (pattern === undefined) {
        throw new Error('Web coverage exclusion parser produced an empty capture.');
      }
      return pattern;
    }
  );
  const excludedModelSwitchFiles = MODEL_SWITCH_SOURCE_FILES.filter((sourceFile) =>
    exclusionPatterns.some((pattern) => path.matchesGlob(sourceFile, pattern))
  );
  if (
    excludedModelSwitchFiles.length !== EXPECTED_MODEL_SWITCH_COVERAGE_EXCLUSIONS.length ||
    excludedModelSwitchFiles.some(
      (sourceFile, index) => sourceFile !== EXPECTED_MODEL_SWITCH_COVERAGE_EXCLUSIONS[index]
    )
  ) {
    throw new Error(
      `Web coverage must exclude exactly the two browser-only BST-369 runtime files; received ${JSON.stringify(excludedModelSwitchFiles)}.`
    );
  }
}

function assertScheduledPerformanceOwner(performanceWorkflow: string): void {
  if (!performanceWorkflow.includes("on:\n  schedule:\n    - cron: '")) {
    throw new Error('BST-369 coverage ownership requires the scheduled performance workflow.');
  }
  const performanceStep = /- name: Run performance tests[\s\S]*?- name: Upload blob report/u.exec(
    performanceWorkflow
  )?.[0];
  if (performanceStep === undefined) {
    throw new Error('BST-369 coverage ownership requires the performance test step.');
  }
  if (!performanceStep.includes(PERFORMANCE_PROJECT_FALLBACK)) {
    throw new Error('Scheduled performance runs must select the performance project.');
  }
  if (!performanceStep.includes(EMPTY_PERFORMANCE_GREP_FALLBACK)) {
    throw new Error('Scheduled performance runs must default to an empty grep.');
  }
  if (
    !/if \[ -n "\$PERF_GREP" \]; then[\s\S]*?pnpm exec playwright test --project="\$PERF_PROJECT" -g "\$PERF_GREP"[\s\S]*?else\s+pnpm exec playwright test --project="\$PERF_PROJECT"\s+fi/u.test(
      performanceStep
    )
  ) {
    throw new Error('Scheduled performance runs must retain the unfiltered project fallback.');
  }
}

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
    expect(validation).toContain('measureNamedCheckboxInteractionFrame');
    expect(validation).toContain('name: /^Select (test1\\.js|test2\\.js)$/');
    expect(validation).toContain("name: 'Select folder'");
    // BST-959/BST-1037: both fixture quantities are known, so their checkbox
    // counts are asserted (a partially rendered tree fails instead of
    // shrinking the measured set). The recursive folder sample re-resolves by
    // accessible name after paint because its original row detaches.
    expect(validation).toContain('expect(fileCheckboxes).toHaveCount(2)');
    expect(validation).toContain('expect(folderCheckbox).toHaveCount(1)');
    expect(validation).toContain('PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_TOTAL_MAX_MS');
    expect(validation).toContain('PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS');
    expect(validation).not.toContain('toBeLessThan(2000)');
    expect(validation).not.toContain('Date.now()');
    expect(validation).not.toContain('waitForTimeout(');
    expect(validation).not.toContain('__renderCounter');
  });

  it('routes the embedding model-switch regression through the production worker', async () => {
    const [
      e2eSource,
      embeddingWorkerPackageSource,
      hookSource,
      performanceWorkflow,
      probeSource,
      vitestConfig,
      workerSource,
      playwrightConfig,
    ] = await Promise.all([
      readFile(
        path.join(process.cwd(), 'e2e/performance/embedding-model-switch-memory.test.ts'),
        'utf8'
      ),
      readFile(path.join(process.cwd(), '../../packages/embedding-worker/package.json'), 'utf8'),
      readFile(path.join(process.cwd(), 'src/web-e2e-test-hooks.tsx'), 'utf8'),
      readFile(path.join(process.cwd(), '../../.github/workflows/performance.yml'), 'utf8'),
      readFile(path.join(process.cwd(), 'src/embedding-model-switch-memory-probe.ts'), 'utf8'),
      readFile(path.join(process.cwd(), 'vitest.config.mts'), 'utf8'),
      readFile(
        path.join(process.cwd(), 'src/embedding-model-switch-memory-probe.worker.ts'),
        'utf8'
      ),
      readFile(path.join(process.cwd(), 'playwright.config.mts'), 'utf8'),
    ]);
    const embeddingWorkerPackage = JSON.parse(embeddingWorkerPackageSource) as unknown;
    if (!(typeof embeddingWorkerPackage === 'object' && embeddingWorkerPackage !== null)) {
      throw new Error('Embedding worker package.json must contain an object.');
    }
    const sideEffects = Reflect.get(embeddingWorkerPackage, 'sideEffects');

    expect(e2eSource).toContain('__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__');
    expect(e2eSource).toContain('page.addInitScript');
    expect(e2eSource).toContain('page.route');
    expect(e2eSource).toContain('const appOrigin = new URL(baseURL).origin');
    expect(e2eSource).toContain("requestUrl.pathname.startsWith('/api/hf/')");
    expect(e2eSource).toContain("route.abort('blockedbyclient')");
    expect(e2eSource).toContain('expect(crossOriginRequests).toEqual([])');
    expect(e2eSource).toContain('expect(modelProxyRequests).toEqual([])');
    expect(e2eSource).toContain('expect(browserErrors).toEqual([])');
    expect(e2eSource).toContain('hooks.runEmbeddingModelSwitchMemoryProbe()');
    expect(e2eSource).toContain('residentLimitEvictionCount).toBe(18)');
    expect(e2eSource).not.toContain('waitForTimeout(');

    expect(hookSource).not.toContain(
      "import { runEmbeddingModelSwitchMemoryProbe } from './embedding-model-switch-memory-probe'"
    );
    expect(hookSource).toContain("await import('./embedding-model-switch-memory-probe')");
    expect(hookSource).toContain('window.navigator.webdriver !== true');
    expect(hookSource).toContain('Reflect.get(window, BST369_E2E_INIT_FLAG)');

    expect(probeSource).toContain('createBrowserEmbeddingQueue');
    expect(probeSource).toContain('embedding-model-switch-memory-probe.worker.ts?worker&url');
    expect(probeSource).toContain('maxWorkers: 1');
    expect(probeSource).toContain('minWorkers: 1');
    expect(probeSource).toContain('measureUserAgentSpecificMemory');
    expect(probeSource).not.toContain('new Worker(');

    expect(workerSource).toContain("await import('@brainstrike/embedding-worker/worker')");
    expect(workerSource).toContain('parseSingleFragmentValue');
    expect(workerSource).toContain('runtime bootstrap was installed more than once');
    expect(workerSource).toContain('requires exactly one');
    expect(workerSource).toContain('failProbeWorker');
    expect(workerSource).toContain('liveBytes += resource.store.byteLength');
    expect(workerSource).not.toContain('createEmbeddingPipelineCacheController');

    expect(sideEffects).toEqual(['./dist/embedding.worker.cjs', './dist/embedding.worker.js']);

    expect(playwrightConfig).toContain('ForceEagerMeasureMemory');
    expect(playwrightConfig).toContain("testMatch: '**/performance/*.test.ts'");
    expect(performanceWorkflow).toContain("default: 'performance'");
    assertModelSwitchCoverageOwnership(vitestConfig);
    assertScheduledPerformanceOwner(performanceWorkflow);
  });

  it('fails closed when coverage broadens or the scheduled owner narrows', async () => {
    const [vitestConfig, performanceWorkflow] = await Promise.all([
      readFile(path.join(process.cwd(), 'vitest.config.mts'), 'utf8'),
      readFile(path.join(process.cwd(), '../../.github/workflows/performance.yml'), 'utf8'),
    ]);

    expect(() =>
      assertModelSwitchCoverageOwnership(
        vitestConfig.replace("'src/embedding-model-switch-memory-probe.ts'", "'src/**'")
      )
    ).toThrow('must exclude exactly the two browser-only BST-369 runtime files');

    expect(() =>
      assertScheduledPerformanceOwner(
        performanceWorkflow.replace('  schedule:\n', '  disabled-schedule:\n')
      )
    ).toThrow('requires the scheduled performance workflow');
    expect(() =>
      assertScheduledPerformanceOwner(
        performanceWorkflow.replace(
          PERFORMANCE_PROJECT_FALLBACK,
          `PERF_PROJECT: ${githubExpression("github.event.inputs.project || 'functional'")}`
        )
      )
    ).toThrow('must select the performance project');
    expect(() =>
      assertScheduledPerformanceOwner(
        performanceWorkflow.replace(
          EMPTY_PERFORMANCE_GREP_FALLBACK,
          `PERF_GREP: ${githubExpression("github.event.inputs.grep || 'smoke'")}`
        )
      )
    ).toThrow('must default to an empty grep');
    expect(() =>
      assertScheduledPerformanceOwner(
        performanceWorkflow.replace(
          'pnpm exec playwright test --project="$PERF_PROJECT"\n          fi',
          'pnpm exec playwright test --project="$PERF_PROJECT" -g "forced"\n          fi'
        )
      )
    ).toThrow('must retain the unfiltered project fallback');
  });
});
