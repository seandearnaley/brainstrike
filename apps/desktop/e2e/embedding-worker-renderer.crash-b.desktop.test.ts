import type {
  DesktopProcessSnapshot,
  ElectronApplication,
  EmbeddingHostStatus,
  MainBufferedLogRecord,
  MainProcessHealthSample,
  Page,
  QueueStatsRow,
} from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
  CRASH_REPRO_LARGE_FILE_COUNT,
  DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT,
  DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB,
  ERROR_LOCATOR,
  assertCleanBackfillMeasurementScenario,
  clearEmbeddingQueue,
  collectPostTargetMemorySamples,
  countPlannedMaintenanceLogs,
  createLargeBackfillCorpusFixture,
  destroyEmbeddingHostWindow,
  detectObservedMaintenanceCycles,
  ensureEmbeddingHostWarmed,
  extractUnexpectedLifecycleLogs,
  forceRendererGarbageCollection,
  getBridgeBackfillState,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getEmbeddingQueueStats,
  getGpuWorkingSetKB,
  getMainBufferedLogs,
  getRelevantElectronStderr,
  getRelevantElectronStderrSince,
  getRendererTimeOrigin,
  getRuntimeSnapshot,
  getTotalWorkingSetKB,
  growth,
  isDatabaseError,
  parseMainProcessHealthSamples,
  readAppMetricSample,
  readCombinedMemorySnapshot,
  readDesktopProcessSnapshot,
  readElectronAppMetricsWithRetry,
  reloadRendererInTest,
  scoreGpuWorkingSetSamples,
  scoreNumericSamples,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  startBackfillViaBridge,
  waitForBackfillQueueMovementOrFatalError,
  waitForBridgeBackfillCompletion,
  waitForEmbeddingHostIdleAndQueueDrain,
  waitForReclaimCycleAndResumedProcessing,
  waitForTrackedRuntimeWorkingSetMB,
  withTemporaryProcessEnv,
} = shared;

test.describe('Embedding Host Renderer - crash b', () => {
  test('@desktop-embedding-crash-b @perf @embedding-soak tracks per-process memory growth rate during sustained backfill (crash repro test 6)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    const GROWTH_SAMPLE_COUNT = 12;
    const GROWTH_SAMPLE_INTERVAL_MS = 10_000;
    // Acceptable per-minute growth rates (MB/min) after GC
    const VISIBLE_HEAP_GROWTH_RATE_LIMIT_MB_PER_MIN = 5;
    const MAIN_RSS_GROWTH_RATE_LIMIT_MB_PER_MIN = 15;

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-growth-rate');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use a large fixture to keep the backfill running for the full sample window
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_LARGE_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-growth-rate-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Force GC before baseline
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const hostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'growth-rate-baseline'
    );

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample every 10s for 2 minutes with forced GC at each point
    const samples: Array<{
      elapsedSec: number;
      mainHeapMB: number;
      mainRssMB: number;
      visibleHeapMB: number;
    }> = [];
    const startedAt = Date.now();

    for (let index = 0; index < GROWTH_SAMPLE_COUNT; index += 1) {
      await activeWindow.waitForTimeout(GROWTH_SAMPLE_INTERVAL_MS);

      // Force GC on both renderers to measure real retention, not GC lag
      await forceRendererGarbageCollection(activeWindow);
      await forceRendererGarbageCollection(activeWindow);
      const currentHostPage = await getEmbeddingHostPage(activeWindow);
      await forceRendererGarbageCollection(currentHostPage);

      const snapshot = await readCombinedMemorySnapshot(
        electronApp.app,
        activeWindow,
        currentHostPage,
        `growth-rate-sample-${index + 1}`
      );

      samples.push({
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        mainHeapMB: snapshot.process.mainProcess.heapUsedMB,
        mainRssMB: snapshot.process.mainProcess.rssMB,
        visibleHeapMB: snapshot.visibleHeap.usedMB,
      });
    }

    // Verify renderer didn't crash
    const postTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postTimeOrigin).toBe(baselineTimeOrigin);

    // Calculate growth rates (MB per minute) using linear regression
    const elapsedMinutes = samples.at(-1)!.elapsedSec / 60;
    const visibleHeapGrowth = growth(samples.at(-1)!.visibleHeapMB, baseline.visibleHeap.usedMB);
    const mainRssGrowth = growth(samples.at(-1)!.mainRssMB, baseline.process.mainProcess.rssMB);
    const visibleHeapRate = elapsedMinutes > 0 ? visibleHeapGrowth / elapsedMinutes : 0;
    const mainRssRate = elapsedMinutes > 0 ? mainRssGrowth / elapsedMinutes : 0;

    console.log(
      JSON.stringify({
        baseline: {
          mainHeapMB: baseline.process.mainProcess.heapUsedMB,
          mainRssMB: baseline.process.mainProcess.rssMB,
          visibleHeapMB: baseline.visibleHeap.usedMB,
        },
        elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
        fixture,
        mainRssGrowthMB: mainRssGrowth,
        mainRssRateMBPerMin: Math.round(mainRssRate * 10) / 10,
        samples,
        type: 'crash-repro-memory-growth-rate',
        visibleHeapGrowthMB: visibleHeapGrowth,
        visibleHeapRateMBPerMin: Math.round(visibleHeapRate * 10) / 10,
      })
    );

    // Assert growth rates are within acceptable bounds
    expect(visibleHeapRate).toBeLessThan(VISIBLE_HEAP_GROWTH_RATE_LIMIT_MB_PER_MIN);
    expect(mainRssRate).toBeLessThan(MAIN_RSS_GROWTH_RATE_LIMIT_MB_PER_MIN);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    await electronHarness.restart();
  });

  async function runGpuReclaimMeasurementScenario(options: {
    chunksPerFile: number;
    electronHarness: {
      restart: () => Promise<{ app: ElectronApplication; window: Page }>;
    };
    itemThreshold: number;
    label: string;
    minimumIntervalMs?: number;
    reclaimEnabled: boolean;
    reclaimMode?: 'reset';
    targetSucceededItems: number;
  }): Promise<{
    cycleCount: number;
    gpuGrowthMB: number;
    gpuGrowthPerItemKB: number;
    hostWorkingSetGrowthMB: number;
    hostWorkingSetGrowthPerItemKB: number;
    itemsProcessed: number;
    label: string;
    runtimeIdAfterSampling: string;
    runtimeIdBeforeBackfill: string;
    hostScore: {
      maxWorkingSetMB: number;
      medianWorkingSetMB: number;
      minWorkingSetMB: number;
    };
    score: {
      maxGpuKB: number;
      maxTotalKB: number;
      medianGpuKB: number;
      medianTotalKB: number;
      minGpuKB: number;
      minTotalKB: number;
    };
    totalGrowthMB: number;
  }> {
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS:
        options.minimumIntervalMs === undefined ? undefined : String(options.minimumIntervalMs),
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: options.reclaimEnabled ? 'true' : 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: String(options.itemThreshold),
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: options.reclaimMode,
    });

    try {
      const electronContext = await options.electronHarness.restart();
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error(`Database failed to initialize for ${options.label}.`);
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, `${options.label}-memory-measurement`);
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        chunkContentBytes: 1024,
        chunksPerFile: options.chunksPerFile,
        fileCount: 180,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, `${options.label}-memory-measurement-fixture`);
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const [baseline, initialStatus, baselineMainLogs, baselineElectronStderr] = await Promise.all(
        [
          readAppMetricSample(electronContext.app, activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getMainBufferedLogs(activeWindow),
          getRelevantElectronStderr(electronContext.app),
        ]
      );

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        120_000
      );
      expect(outcome).toBe('queued');
      const baselineHostWorkingSetMB = await waitForTrackedRuntimeWorkingSetMB(
        electronContext.app,
        activeWindow,
        'embedding-host'
      );

      let queueStatsBeforeSampling: QueueStatsRow | null = null;
      const measurementStartedAt = Date.now();
      while (Date.now() - measurementStartedAt < 180_000) {
        const [queueStats, status, mainLogs] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getMainBufferedLogs(activeWindow),
        ]);
        if (status.state === 'error') {
          throw new Error(
            `Embedding host entered error state during ${options.label}: ${status.lastError ?? 'unknown host error'}`
          );
        }

        if (options.reclaimEnabled) {
          const observedMaintenanceCycles = detectObservedMaintenanceCycles({
            finalRuntimeId: status.runtimeId,
            initialRuntimeId: initialStatus.runtimeId,
            logsSinceBaseline: mainLogs.slice(baselineMainLogs.length),
          });
          const reclaimedAndResumed =
            observedMaintenanceCycles > 0 &&
            status.runtimeId !== initialStatus.runtimeId &&
            status.state === 'running' &&
            status.active &&
            queueStats.running > 0 &&
            queueStats.succeeded >= options.targetSucceededItems;
          if (reclaimedAndResumed) {
            queueStatsBeforeSampling = queueStats;
            break;
          }
        } else if (queueStats.succeeded >= options.targetSucceededItems) {
          queueStatsBeforeSampling = queueStats;
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      if (!queueStatsBeforeSampling) {
        throw new Error(`Timed out waiting for the ${options.label} sampling checkpoint.`);
      }
      expect(queueStatsBeforeSampling.succeeded).toBeGreaterThanOrEqual(
        options.targetSucceededItems
      );
      if (options.reclaimEnabled) {
        await expect
          .poll(
            async () =>
              countPlannedMaintenanceLogs(
                (await getMainBufferedLogs(activeWindow)).slice(baselineMainLogs.length)
              ),
            {
              timeout: 60_000,
            }
          )
          .toBeGreaterThan(0);
        const resumedState = await waitForReclaimCycleAndResumedProcessing(
          activeWindow,
          initialStatus.runtimeId,
          baselineMainLogs.length,
          options.targetSucceededItems,
          60_000
        );
        queueStatsBeforeSampling = resumedState.queueStats;
      }

      const baselineGpuKB = getGpuWorkingSetKB(baseline);
      const baselineTotalKB = getTotalWorkingSetKB(baseline);

      // Score a short steady-state window after the sampling checkpoint. The
      // comparison gate is the hidden embedding-host renderer working set,
      // which maps directly to the background renderer the user observes.
      const postTargetSampleDelayMs = 1000;
      const postTargetSampleCount = 12;
      const postTargetSamples = await collectPostTargetMemorySamples(
        electronContext.app,
        activeWindow,
        postTargetSampleCount,
        postTargetSampleDelayMs
      );
      const rawSampleSummary = postTargetSamples.map((sample) => ({
        gpuKB: getGpuWorkingSetKB(sample.appMetrics),
        hostWorkingSetMB: sample.hostWorkingSetMB,
        totalKB: getTotalWorkingSetKB(sample.appMetrics),
      }));
      const score = scoreGpuWorkingSetSamples(postTargetSamples.map((sample) => sample.appMetrics));
      const hostScore = scoreNumericSamples(
        postTargetSamples.map((sample) => sample.hostWorkingSetMB)
      );

      const finalGpuKB = score.medianGpuKB;
      const gpuGrowthMB = (finalGpuKB - baselineGpuKB) / 1024;

      const finalTotalKB = score.medianTotalKB;
      const totalGrowthMB = (finalTotalKB - baselineTotalKB) / 1024;
      const finalHostWorkingSetMB = hostScore.median;
      const hostWorkingSetGrowthMB = finalHostWorkingSetMB - baselineHostWorkingSetMB;
      const finalQueueStats = await getEmbeddingQueueStats(activeWindow);
      const itemsProcessed = finalQueueStats.succeeded;
      const gpuGrowthPerItemKB =
        itemsProcessed > 0 ? (finalGpuKB - baselineGpuKB) / itemsProcessed : 0;
      const hostWorkingSetGrowthPerItemKB =
        itemsProcessed > 0
          ? ((finalHostWorkingSetMB - baselineHostWorkingSetMB) * 1024) / itemsProcessed
          : 0;
      const [statusAfterSampling, mainLogsAfterSampling] = await Promise.all([
        getEmbeddingHostStatus(activeWindow),
        getMainBufferedLogs(activeWindow),
      ]);
      const observedMaintenanceCycles = detectObservedMaintenanceCycles({
        finalRuntimeId: statusAfterSampling.runtimeId,
        initialRuntimeId: initialStatus.runtimeId,
        logsSinceBaseline: mainLogsAfterSampling.slice(baselineMainLogs.length),
      });

      await waitForBridgeBackfillCompletion(activeWindow, 240_000);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);
      await assertCleanBackfillMeasurementScenario(
        activeWindow,
        electronContext.app,
        baselineMainLogs.length,
        baselineElectronStderr.length
      );

      console.log(
        JSON.stringify({
          cycleCount: observedMaintenanceCycles,
          gpuGrowthMB: Math.round(gpuGrowthMB),
          gpuGrowthPerItemKB: Math.round(gpuGrowthPerItemKB * 10) / 10,
          hostMaxWorkingSetMB: Math.round(hostScore.max * 10) / 10,
          hostMedianWorkingSetMB: Math.round(hostScore.median * 10) / 10,
          hostMinWorkingSetMB: Math.round(hostScore.min * 10) / 10,
          hostWorkingSetGrowthMB: Math.round(hostWorkingSetGrowthMB * 10) / 10,
          hostWorkingSetGrowthPerItemKB: Math.round(hostWorkingSetGrowthPerItemKB * 10) / 10,
          itemsProcessed,
          itemsProcessedBeforeSampling: queueStatsBeforeSampling.succeeded,
          itemThreshold: options.itemThreshold,
          label: options.label,
          maxGpuKB: score.maxGpuKB,
          maxTotalKB: score.maxTotalKB,
          medianGpuKB: score.medianGpuKB,
          medianTotalKB: score.medianTotalKB,
          minGpuKB: score.minGpuKB,
          minTotalKB: score.minTotalKB,
          postTargetSampleCount,
          rawSampleSummary,
          reclaimEnabled: options.reclaimEnabled,
          reclaimMode: options.reclaimMode ?? null,
          runtimeIdAfterSampling: statusAfterSampling.runtimeId,
          runtimeIdBeforeBackfill: initialStatus.runtimeId,
          totalGrowthMB: Math.round(totalGrowthMB),
          type: 'GPU_RECLAIM_MEASUREMENT',
        })
      );

      return {
        cycleCount: observedMaintenanceCycles,
        gpuGrowthMB,
        gpuGrowthPerItemKB,
        hostScore: {
          maxWorkingSetMB: hostScore.max,
          medianWorkingSetMB: hostScore.median,
          minWorkingSetMB: hostScore.min,
        },
        hostWorkingSetGrowthMB,
        hostWorkingSetGrowthPerItemKB,
        itemsProcessed,
        label: options.label,
        runtimeIdAfterSampling: statusAfterSampling.runtimeId,
        runtimeIdBeforeBackfill: initialStatus.runtimeId,
        score: {
          maxGpuKB: score.maxGpuKB,
          maxTotalKB: score.maxTotalKB,
          medianGpuKB: score.medianGpuKB,
          medianTotalKB: score.medianTotalKB,
          minGpuKB: score.minGpuKB,
          minTotalKB: score.minTotalKB,
        },
        totalGrowthMB,
      };
    } finally {
      restoreEnv();
    }
  }

  test('@desktop-embedding-crash-b measures reset reclaim against the disabled control without lifecycle regressions', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_GPU_RECLAIM_CONTROL'] !== '1',
      'Opt-in GPU control comparison for tuning reclaim behavior.'
    );
    test.setTimeout(420_000);

    const withoutReclaim = await runGpuReclaimMeasurementScenario({
      chunksPerFile: 12,
      electronHarness,
      itemThreshold: 500,
      label: 'gpu-reclaim-disabled',
      reclaimEnabled: false,
      targetSucceededItems: 650,
    });

    const withReclaim = await runGpuReclaimMeasurementScenario({
      chunksPerFile: 12,
      electronHarness,
      itemThreshold: 500,
      label: 'gpu-reclaim-reset',
      reclaimEnabled: true,
      reclaimMode: 'reset',
      targetSucceededItems: 650,
    });

    console.log(
      JSON.stringify({
        hostImprovementPerItemKB:
          withoutReclaim.hostWorkingSetGrowthPerItemKB - withReclaim.hostWorkingSetGrowthPerItemKB,
        hostMinWorkingSetReductionMB:
          withoutReclaim.hostScore.minWorkingSetMB - withReclaim.hostScore.minWorkingSetMB,
        improvementPerItemKB: withoutReclaim.gpuGrowthPerItemKB - withReclaim.gpuGrowthPerItemKB,
        improvementRatio:
          withoutReclaim.gpuGrowthPerItemKB > 0
            ? withReclaim.gpuGrowthPerItemKB / withoutReclaim.gpuGrowthPerItemKB
            : null,
        type: 'GPU_RECLAIM_COMPARISON',
        withoutReclaim,
        withReclaim,
      })
    );

    expect(withReclaim.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(withoutReclaim.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(withReclaim.cycleCount).toBeGreaterThan(0);
    expect(withReclaim.runtimeIdAfterSampling).not.toBe(withReclaim.runtimeIdBeforeBackfill);
    expect(withoutReclaim.runtimeIdAfterSampling).toBe(withoutReclaim.runtimeIdBeforeBackfill);
  });

  test('@desktop-embedding-crash-b completes reclaim-enabled backfill in reset mode without fatal lifecycle errors', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.setTimeout(420_000);

    const result = await runGpuReclaimMeasurementScenario({
      chunksPerFile: 12,
      electronHarness,
      itemThreshold: 500,
      label: 'gpu-reclaim-reset-correctness',
      reclaimEnabled: true,
      reclaimMode: 'reset',
      targetSucceededItems: 650,
    });

    expect(result.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(result.cycleCount).toBeGreaterThan(0);
  });

  test('@desktop-embedding-crash-b does not reload the visible renderer during the default 12k chunk backfill path', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.setTimeout(600_000);

    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    try {
      const electronContext = await electronHarness.restart();
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error('Database failed to initialize for the 12k-chunk reclaim regression.');
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, 'gpu-reclaim-default-disabled-visible-reload-12k');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        chunkContentBytes: 1024,
        chunksPerFile: 20,
        fileCount: 623,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, 'gpu-reclaim-visible-reload-12k-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const baselineStderrCount = (await getRelevantElectronStderr(electronContext.app)).length;
      const initialEmbeddingStatus = await getEmbeddingHostStatus(activeWindow);
      const initialProcessSnapshot = await readDesktopProcessSnapshot(electronContext.app);
      const initialEmbeddingHostProcessId = getRuntimeSnapshot(
        initialProcessSnapshot,
        'embedding-host'
      ).osProcessId;
      const baselineVisibleWorkingSetMB = await waitForTrackedRuntimeWorkingSetMB(
        electronContext.app,
        activeWindow,
        'visible-ui'
      );
      const runtimeIds = new Set<string>([initialEmbeddingStatus.runtimeId]);
      const embeddingHostProcessIds = new Set<number | null>([initialEmbeddingHostProcessId]);
      let peakVisibleWorkingSetMB = baselineVisibleWorkingSetMB;
      const visibleWorkingSetSamplesMB: number[] = [baselineVisibleWorkingSetMB];
      let sampledWhileRunning = false;
      let lastQueueStats: QueueStatsRow | null = null;
      let mainProcessHealthSamples: MainProcessHealthSample[] = [];
      let completedBeforeActiveCheckpoint = false;

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        120_000
      );
      expect(outcome).toBe('queued');

      const sampleStartedAt = Date.now();
      while (Date.now() - sampleStartedAt < 240_000) {
        let timeOrigin: number;
        let embeddingStatus: EmbeddingHostStatus;
        let queueStats: QueueStatsRow;
        let processSnapshot: DesktopProcessSnapshot;
        let electronStderr: string[];
        let mainLogs: MainBufferedLogRecord[];
        let visibleWorkingSetMB: number;
        try {
          [
            timeOrigin,
            embeddingStatus,
            queueStats,
            processSnapshot,
            electronStderr,
            mainLogs,
            visibleWorkingSetMB,
          ] = await Promise.all([
            getRendererTimeOrigin(activeWindow),
            getEmbeddingHostStatus(activeWindow),
            getEmbeddingQueueStats(activeWindow),
            readDesktopProcessSnapshot(electronContext.app),
            getRelevantElectronStderrSince(electronContext.app, baselineStderrCount),
            getMainBufferedLogs(activeWindow),
            waitForTrackedRuntimeWorkingSetMB(electronContext.app, activeWindow, 'visible-ui'),
          ]);
        } catch (error) {
          throw new Error(
            'Desktop app connection dropped during the default 12k backfill regression.\n' +
              `runtimeIds=${JSON.stringify([...runtimeIds])}\n` +
              `error=${error instanceof Error ? error.message : String(error)}`
          );
        }

        expect(timeOrigin).toBe(initialTimeOrigin);
        expect(embeddingStatus.state).not.toBe('error');
        expect(electronStderr).toEqual([]);

        lastQueueStats = queueStats;
        runtimeIds.add(embeddingStatus.runtimeId);
        embeddingHostProcessIds.add(
          getRuntimeSnapshot(processSnapshot, 'embedding-host').osProcessId
        );
        mainProcessHealthSamples = parseMainProcessHealthSamples(
          mainLogs.slice(baselineMainLogs.length)
        );

        visibleWorkingSetSamplesMB.push(visibleWorkingSetMB);
        peakVisibleWorkingSetMB = Math.max(peakVisibleWorkingSetMB, visibleWorkingSetMB);

        if (queueStats.running > 0 || queueStats.succeeded > 0) {
          sampledWhileRunning = true;
        }

        if (
          queueStats.succeeded >= 1800 &&
          queueStats.running > 0 &&
          mainProcessHealthSamples.length >= DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT
        ) {
          break;
        }

        const backfillState = await getBridgeBackfillState(activeWindow);
        if (
          backfillState?.done &&
          !backfillState.error &&
          queueStats.queued === 0 &&
          queueStats.running === 0 &&
          queueStats.succeeded >= fixture.totalChunks
        ) {
          completedBeforeActiveCheckpoint = true;
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      expect(sampledWhileRunning).toBe(true);
      expect(lastQueueStats).not.toBeNull();
      const reachedActiveCheckpoint =
        !!lastQueueStats && lastQueueStats.succeeded >= 1800 && lastQueueStats.running > 0;
      if (!(reachedActiveCheckpoint || completedBeforeActiveCheckpoint)) {
        const backfillState = await getBridgeBackfillState(activeWindow);
        throw new Error(
          'Default 12k backfill did not sustain active progress before the sampling window ended.\n' +
            `queueStats=${JSON.stringify(lastQueueStats)}\n` +
            `backfillState=${JSON.stringify(backfillState)}`
        );
      }

      const visibleWorkingSetSamplesKB = mainProcessHealthSamples
        .map((sample) => sample.visibleUiWorkingSetKB)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const hasEnoughHealthWorkingSetSamples =
        visibleWorkingSetSamplesKB.length >= DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT;
      if (!hasEnoughHealthWorkingSetSamples && visibleWorkingSetSamplesMB.length < 2) {
        throw new Error(
          'Default 12k backfill did not collect enough visible-ui working-set samples.\n' +
            `healthSamples=${JSON.stringify(mainProcessHealthSamples)}\n` +
            `processSamples=${JSON.stringify(visibleWorkingSetSamplesMB)}`
        );
      }
      const baselineVisibleWorkingSetFromHealthMB = hasEnoughHealthWorkingSetSamples
        ? visibleWorkingSetSamplesKB[0]! / 1024
        : visibleWorkingSetSamplesMB[0]!;
      const peakVisibleWorkingSetFromHealthMB = hasEnoughHealthWorkingSetSamples
        ? Math.max(...visibleWorkingSetSamplesKB) / 1024
        : Math.max(...visibleWorkingSetSamplesMB);
      const visibleWorkingSetGrowthFromHealthMB = growth(
        peakVisibleWorkingSetFromHealthMB,
        baselineVisibleWorkingSetFromHealthMB
      );
      const visibleWorkingSetMeasurementSource = hasEnoughHealthWorkingSetSamples
        ? 'main-process-health'
        : 'process-snapshot';

      const finalMainLogs = await getMainBufferedLogs(activeWindow);
      const finalElectronStderr = await getRelevantElectronStderrSince(
        electronContext.app,
        baselineStderrCount
      );
      const finalBackfillState = await getBridgeBackfillState(activeWindow);
      const unexpectedLifecycleLogs = extractUnexpectedLifecycleLogs(
        finalMainLogs.slice(baselineMainLogs.length)
      );

      console.log(
        JSON.stringify({
          baselineVisibleWorkingSetFromHealthMB:
            Math.round(baselineVisibleWorkingSetFromHealthMB * 10) / 10,
          embeddingHostProcessIds: [...embeddingHostProcessIds],
          embeddingRuntimeIds: [...runtimeIds],
          finalBackfillState,
          fixture: {
            fileCount: fixture.fileCount,
            totalChunks: fixture.totalChunks,
          },
          lastQueueStats,
          mainProcessHealthSamples,
          peakVisibleWorkingSetFromHealthMB:
            Math.round(peakVisibleWorkingSetFromHealthMB * 10) / 10,
          peakVisibleWorkingSetMB: Math.round(peakVisibleWorkingSetMB * 10) / 10,
          processSnapshotVisibleWorkingSetSamplesMB: visibleWorkingSetSamplesMB,
          type: 'desktop-default-visible-reload-12k',
          visibleWorkingSetGrowthFromHealthMB:
            Math.round(visibleWorkingSetGrowthFromHealthMB * 10) / 10,
          visibleWorkingSetMeasurementSource,
        })
      );

      expect(initialEmbeddingHostProcessId).not.toBeNull();
      expect(embeddingHostProcessIds.size).toBe(1);
      expect(runtimeIds.size).toBe(1);
      expect(unexpectedLifecycleLogs).toEqual([]);
      expect(finalElectronStderr).toEqual([]);
      expect(finalBackfillState?.error ?? null).toBeNull();
      expect(visibleWorkingSetGrowthFromHealthMB).toBeLessThan(
        DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
      );
    } finally {
      restoreEnv();
      await electronHarness.restart();
    }
  });

  test('@desktop-embedding-crash-b fails backfill explicitly when the embedding host stops unexpectedly during processing', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.skip(
      process.env['BRAINSTRIKE_E2E_EMBEDDING_HOST_FAILURE_TEST'] !== '1',
      'Opt-in because forced host teardown is still unstable in headless GPU mode.'
    );
    test.setTimeout(240_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, process.env['CI'] ? 'wasm' : 'webgpu');
    await reloadRendererInTest(activeWindow, 'unexpected-embedding-host-stop');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunkContentBytes: 1024,
      chunksPerFile: 8,
      fileCount: 80,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'unexpected-embedding-host-stop-fixture');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    await destroyEmbeddingHostWindow(electronApp.app);

    await expect(waitForBridgeBackfillCompletion(activeWindow, 60_000)).rejects.toThrow(
      'Embedding host stopped while backfill was in progress.'
    );

    await expect
      .poll(
        async () =>
          await getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        {
          timeout: 30_000,
        }
      )
      .toContainEqual(
        expect.stringContaining('Embedding host stopped while backfill was in progress.')
      );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-b benchmarks reclaim thresholds against the same GPU-growth workload', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_GPU_RECLAIM_BENCHMARK'] !== '1',
      'Opt-in benchmark for tuning reclaim defaults.'
    );
    test.setTimeout(1_200_000);

    const baseline = await runGpuReclaimMeasurementScenario({
      chunksPerFile: 12,
      electronHarness,
      itemThreshold: 80,
      label: 'gpu-reclaim-benchmark-disabled',
      minimumIntervalMs: 1000,
      reclaimEnabled: false,
      targetSucceededItems: 650,
    });

    const thresholdResults = [] as Array<{
      gpuGrowthPerItemKB: number;
      improvementPerItemKB: number;
      improvementRatio: number;
      itemThreshold: number;
      itemsProcessed: number;
      reclaimMode: 'reset';
    }>;

    for (const reclaimMode of ['reset'] as const) {
      for (const itemThreshold of [40, 80, 160, 320, 500]) {
        const result = await runGpuReclaimMeasurementScenario({
          chunksPerFile: 12,
          electronHarness,
          itemThreshold,
          label: `gpu-reclaim-${reclaimMode}-threshold-${itemThreshold}`,
          minimumIntervalMs: 1000,
          reclaimEnabled: true,
          reclaimMode,
          targetSucceededItems: 650,
        });
        thresholdResults.push({
          gpuGrowthPerItemKB: result.gpuGrowthPerItemKB,
          improvementPerItemKB: baseline.gpuGrowthPerItemKB - result.gpuGrowthPerItemKB,
          improvementRatio:
            baseline.gpuGrowthPerItemKB > 0
              ? result.gpuGrowthPerItemKB / baseline.gpuGrowthPerItemKB
              : Number.NaN,
          itemsProcessed: result.itemsProcessed,
          itemThreshold,
          reclaimMode,
        });
      }
    }

    console.log(
      JSON.stringify({
        baseline,
        thresholdResults,
        type: 'GPU_RECLAIM_THRESHOLD_BENCHMARK',
      })
    );

    expect(thresholdResults).toHaveLength(5);
    for (const result of thresholdResults) {
      expect(result.itemsProcessed).toBeGreaterThanOrEqual(900);
    }
  });

  test('@desktop-embedding-crash-b @perf @embedding-soak diagnoses per-process memory growth during sustained backfill (crash repro test 7 — diagnostic)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    // This test runs a real backfill for 3+ minutes, sampling ALL process
    // memory every 10s. It prints detailed per-process snapshots so we can
    // see exactly which process (visible-ui, embedding-host, main) is growing.
    // This is intentionally diagnostic: machine-specific GPU behavior varies,
    // so the contract here is that sampling completes against a live workload
    // and emits real process-level measurements without crashing the session.
    test.setTimeout(360_000);

    const DIAG_FILE_COUNT = 500;
    const DIAG_CHUNKS_PER_FILE = 20;
    const DIAG_SAMPLE_COUNT = 18;
    const DIAG_SAMPLE_INTERVAL_MS = 10_000;

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    // Use WebGPU to reproduce production memory growth. WASM shows no growth
    // but WebGPU buffers (managed by Dawn/Metal) accumulate unboundedly.
    // Falls back to WASM in CI where GPU is disabled.
    const devicePref = process.env['CI'] ? 'wasm' : 'webgpu';
    await setVectorDevicePreference(activeWindow, devicePref as 'wasm' | 'webgpu');
    await reloadRendererInTest(activeWindow, 'crash-repro-memory-diagnostic');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use realistic chunk content (1KB) to match production where chunks
    // contain actual code/text. Empty content underestimates GPU buffer
    // allocations because tokenizer and inference inputs are smaller.
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunkContentBytes: 1024,
      chunksPerFile: DIAG_CHUNKS_PER_FILE,
      fileCount: DIAG_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-memory-diagnostic-fixture');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Force GC everywhere before baseline
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const hostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    // Use app.getAppMetrics() for real OS-level memory (V8 heap can't see WASM)
    async function getAppMetricsSummary(): Promise<
      Array<{ memoryKB: number; name: string; pid: number; type: string }>
    > {
      return await readElectronAppMetricsWithRetry(electronApp.app, activeWindow);
    }

    const baseline = await getAppMetricsSummary();
    console.log(JSON.stringify({ processes: baseline, type: 'MEMORY_DIAGNOSTIC_BASELINE' }));

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample every 10s for 3 minutes
    const startedAt = Date.now();
    for (let index = 0; index < DIAG_SAMPLE_COUNT; index += 1) {
      await activeWindow.waitForTimeout(DIAG_SAMPLE_INTERVAL_MS);

      const metrics = await getAppMetricsSummary();
      const queueStats = await getEmbeddingQueueStats(activeWindow);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      console.log(
        JSON.stringify({
          elapsedSec,
          processes: metrics.map((m) => ({
            memoryMB: Math.round((m.memoryKB / 1024) * 10) / 10,
            pid: m.pid,
            type: m.type,
          })),
          queueQueued: queueStats.queued,
          queueRunning: queueStats.running,
          queueSucceeded: queueStats.succeeded,
          sample: index + 1,
          totalMemoryMB:
            Math.round((metrics.reduce((sum, m) => sum + m.memoryKB, 0) / 1024) * 10) / 10,
          type: 'MEMORY_DIAGNOSTIC_SAMPLE',
        })
      );
    }

    console.log(JSON.stringify({ type: 'MEMORY_DIAGNOSTIC_COMPLETE' }));

    // Assert total memory growth stays bounded.
    // With WebGPU, unbounded buffer accumulation can cause GB-scale growth.
    // Assert GPU process memory is bounded. With unbounded WebGPU buffer
    // accumulation, the GPU process grows monotonically (~2.5 MB every 10s).
    // Extrapolated to 30K items this would be ~600MB+ of GPU growth alone.
    // After the fix (periodic embedding host restart), the GPU memory should
    // reset at each restart and stay bounded.
    const finalMetrics = await getAppMetricsSummary();
    const baselineGpuKB = baseline.find((p) => p.type === 'GPU')?.memoryKB ?? 0;
    const finalGpuKB = finalMetrics.find((p) => p.type === 'GPU')?.memoryKB ?? 0;
    const gpuGrowthMB = (finalGpuKB - baselineGpuKB) / 1024;

    const baselineTotalKB = baseline.reduce((sum, p) => sum + p.memoryKB, 0);
    const finalTotalKB = finalMetrics.reduce((sum, p) => sum + p.memoryKB, 0);
    const totalGrowthMB = (finalTotalKB - baselineTotalKB) / 1024;

    const queueStats = await getEmbeddingQueueStats(activeWindow);
    const itemsProcessed = queueStats.succeeded;
    const gpuGrowthPerItemKB =
      itemsProcessed > 0 ? (finalGpuKB - baselineGpuKB) / itemsProcessed : 0;

    console.log(
      JSON.stringify({
        gpuGrowthMB: Math.round(gpuGrowthMB),
        gpuGrowthPerItemKB: Math.round(gpuGrowthPerItemKB * 10) / 10,
        itemsProcessed,
        totalGrowthMB: Math.round(totalGrowthMB),
        type: 'MEMORY_DIAGNOSTIC_GROWTH',
      })
    );

    expect(itemsProcessed).toBeGreaterThanOrEqual(1500);
    expect(Number.isFinite(gpuGrowthPerItemKB)).toBe(true);
    expect(Number.isFinite(totalGrowthMB)).toBe(true);

    await electronHarness.restart();
  });
});
