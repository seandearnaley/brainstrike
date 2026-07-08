import type { CombinedMemorySnapshot, Page } from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  ERROR_LOCATOR,
  LARGE_BACKFILL_CHUNKS_PER_FILE,
  LARGE_BACKFILL_CYCLE_CHUNKS_PER_FILE,
  LARGE_BACKFILL_CYCLE_FILE_COUNT,
  LARGE_BACKFILL_FILE_COUNT,
  LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB,
  LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB,
  LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB,
  LARGE_BACKFILL_MAIN_HEAP_GROWTH_LIMIT_MB,
  LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB,
  LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB,
  LARGE_COLLECTION_LIST_FILE_COUNT,
  LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB,
  LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB,
  LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE,
  LARGE_COLLECTION_RENDER_FILE_COUNT,
  LARGE_COLLECTION_VISIBLE_HEAP_GROWTH_LIMIT_MB,
  LARGE_COLLECTION_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB,
  assertToolsPanelResponsive,
  clearEmbeddingQueue,
  createCollectionViaDialog,
  createLargeBackfillCorpusFixture,
  createLargeBackfillFixture,
  createLargeCollectionListFixture,
  ensureEmbeddingHostWarmed,
  forceRendererGarbageCollection,
  getDatabaseDemoImportSnapshot,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getEmbeddingQueueStats,
  getEmbeddingSetCounts,
  getRelevantElectronStderr,
  getRelevantElectronStderrSince,
  getRuntimeSnapshot,
  growth,
  isDatabaseError,
  parseBackfillProgressLabel,
  readCombinedMemorySnapshot,
  readRendererHeapSnapshot,
  reloadRendererInTest,
  resetEmbeddingHost,
  sampleMemoryWhileBackfillActive,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  startBackfillViaBridge,
  stopEmbeddingHost,
  waitForActiveProcessingOrFatalError,
  waitForBackfillButtonEnabled,
  waitForBackfillEnqueueComplete,
  waitForBackfillProgressText,
  waitForBackfillQueueMovementOrFatalError,
  waitForBridgeBackfillCompletion,
  waitForEmbeddingHostIdleAndQueueDrain,
  waitForEmbeddingHostState,
  waitForPositiveBackfillProgress,
  withTemporaryProcessEnv,
} = shared;

test.describe('Embedding Host Renderer - memory', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-memory keeps visible renderer heap bounded while the hidden host enqueues and processes a large backfill', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    const fixture = await createLargeBackfillFixture(activeWindow, 96, { persistActiveSet: false });
    await reloadRendererInTest(activeWindow, 'embedding-worker-visible-memory-diagnostic');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const baseline = await readRendererHeapSnapshot(activeWindow, 'before-backfill');

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForActiveProcessingOrFatalError(activeWindow);
    expect(['error', 'running']).toContain(outcome);

    await assertToolsPanelResponsive(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const retained = await readRendererHeapSnapshot(activeWindow, 'after-backfill');
    const retainedGrowthMB = retained.usedMB - baseline.usedMB;
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    console.log(
      JSON.stringify({
        baseline,
        embeddingSetId: fixture.embeddingSetId,
        outcome,
        queueStats,
        retained,
        retainedGrowthMB,
        type: 'desktop-visible-renderer-memory-diagnostic',
      })
    );

    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    }

    expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
    expect(retainedGrowthMB).toBeLessThan(60);
  });

  test('@desktop-embedding-diagnostic keeps hidden-host, visible-renderer, and main-process memory bounded during a 20k chunk backfill', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.skip(
      !!process.env['CI'],
      'Large local-model memory-pressure harness is opt-in; required CI covers active backfill lifecycle, queue caps, and UI responsiveness with bounded fixtures.'
    );
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-20k-backfill-memory-pressure');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const warmedHostPage = await ensureEmbeddingHostWarmed(activeWindow);
    const warmedBaseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      warmedHostPage,
      'post-warmup-idle'
    );

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: LARGE_BACKFILL_CHUNKS_PER_FILE,
      fileCount: LARGE_BACKFILL_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'embedding-worker-20k-backfill-memory-diagnostic');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'before-20k-backfill'
    );
    const baselineHostProcess = getRuntimeSnapshot(baseline.process, 'embedding-host');
    const baselineHostPid = baselineHostProcess.osProcessId;
    expect(baselineHostPid).toBeTruthy();

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
    expect(outcome).toBe('running');

    const samples = await sampleMemoryWhileBackfillActive(electronApp.app, activeWindow);
    const activeHostPid = getRuntimeSnapshot(
      samples[0]?.snapshot.process ?? baseline.process,
      'embedding-host'
    ).osProcessId;
    expect(activeHostPid).toBeTruthy();
    const peaks = samples.reduce(
      (current, sample) => {
        const hostProcess = getRuntimeSnapshot(sample.snapshot.process, 'embedding-host');
        return {
          hostHeapMB: Math.max(current.hostHeapMB, sample.snapshot.hostHeap.usedMB),
          hostPids: current.hostPids.concat(hostProcess.osProcessId),
          mainHeapMB: Math.max(current.mainHeapMB, sample.snapshot.process.mainProcess.heapUsedMB),
          mainRssMB: Math.max(current.mainRssMB, sample.snapshot.process.mainProcess.rssMB),
          visibleHeapMB: Math.max(current.visibleHeapMB, sample.snapshot.visibleHeap.usedMB),
        };
      },
      {
        hostHeapMB: baseline.hostHeap.usedMB,
        hostPids: [] as Array<number | null>,
        mainHeapMB: baseline.process.mainProcess.heapUsedMB,
        mainRssMB: baseline.process.mainProcess.rssMB,
        visibleHeapMB: baseline.visibleHeap.usedMB,
      }
    );

    console.log(
      JSON.stringify({
        baseline,
        fixture,
        peaks,
        samples,
        type: 'desktop-large-backfill-memory-pressure',
        warmedBaseline,
      })
    );

    for (const sample of samples) {
      expect(sample.queueStats.queued + sample.queueStats.running).toBeLessThanOrEqual(64);
      expect(getRuntimeSnapshot(sample.snapshot.process, 'embedding-host').osProcessId).toBe(
        activeHostPid
      );
    }

    expect(growth(peaks.hostHeapMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.visibleHeapMB, baseline.visibleHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainRssMB, baseline.process.mainProcess.rssMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainHeapMB, baseline.process.mainProcess.heapUsedMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_HEAP_GROWTH_LIMIT_MB
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-memory keeps the visible renderer bounded when opening a 50k chunk collection in the database tab', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'database-visible-render-large-collection-pref');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPage = await ensureEmbeddingHostWarmed(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunkContentBytes: 1024,
      chunksPerFile: LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE,
      fileContentBytes: 4096,
      fileCount: LARGE_COLLECTION_RENDER_FILE_COUNT,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-visible-render-large-collection');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    const reloadedHostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(reloadedHostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'before-large-collection-open'
    );

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });
    await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

    await activeWindow.waitForTimeout(3000);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const selected = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'after-large-collection-open'
    );

    const baselineVisibleProcess = getRuntimeSnapshot(baseline.process, 'visible-ui');
    const selectedVisibleProcess = getRuntimeSnapshot(selected.process, 'visible-ui');
    const visibleHeapGrowthMB = growth(selected.visibleHeap.usedMB, baseline.visibleHeap.usedMB);
    const visibleWorkingSetGrowthMB = growth(
      selectedVisibleProcess.workingSetMB ?? 0,
      baselineVisibleProcess.workingSetMB ?? 0
    );

    console.log(
      JSON.stringify({
        baseline,
        fixture,
        selected,
        type: 'desktop-visible-render-large-collection',
        visibleHeapGrowthMB,
        visibleWorkingSetGrowthMB,
      })
    );

    await assertToolsPanelResponsive(activeWindow);

    expect(visibleHeapGrowthMB).toBeLessThan(LARGE_COLLECTION_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(visibleWorkingSetGrowthMB).toBeLessThan(
      LARGE_COLLECTION_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
    );
  });

  test('@desktop-embedding-memory keeps the database tab source-paginated and memory-bounded for a 50k file collection', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'database-visible-render-large-file-list-pref');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPage = await ensureEmbeddingHostWarmed(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const fixture = await createLargeCollectionListFixture(activeWindow, {
      fileContentBytes: 1024,
      fileCount: LARGE_COLLECTION_LIST_FILE_COUNT,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-visible-render-large-file-list');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    const reloadedHostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(reloadedHostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'before-large-file-list-open'
    );

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });
    await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

    const treegrid = activeWindow.getByRole('treegrid');
    const firstVisibleDataRow = treegrid.getByRole('row').nth(1);
    await expect(firstVisibleDataRow).toBeVisible({ timeout: 30_000 });
    expect(((await firstVisibleDataRow.textContent()) ?? '').trim().length).toBeGreaterThan(0);

    const pageNumberInput = activeWindow.getByRole('spinbutton', { name: 'Page number' });
    await expect(pageNumberInput).toHaveValue('1');
    await expect
      .poll(async () => {
        const snapshot = await getDatabaseDemoImportSnapshot(activeWindow);
        return snapshot?.recordPagination.currentPage ?? -1;
      })
      .toBe(0);

    await activeWindow.getByRole('button', { name: 'Go to next page' }).click({ timeout: 5000 });

    await expect(pageNumberInput).toHaveValue('2');
    await expect
      .poll(
        async () => {
          const snapshot = await getDatabaseDemoImportSnapshot(activeWindow);
          return JSON.stringify(snapshot?.recordPagination ?? null);
        },
        { timeout: 30_000 }
      )
      .toBe(
        JSON.stringify({
          currentPage: 1,
          pageSize: 50,
          totalRecords: fixture.fileCount,
        })
      );

    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const paged = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'after-large-file-list-page-change'
    );

    const baselineVisibleProcess = getRuntimeSnapshot(baseline.process, 'visible-ui');
    const pagedVisibleProcess = getRuntimeSnapshot(paged.process, 'visible-ui');
    const visibleHeapGrowthMB = growth(paged.visibleHeap.usedMB, baseline.visibleHeap.usedMB);
    const visibleWorkingSetGrowthMB = growth(
      pagedVisibleProcess.workingSetMB ?? 0,
      baselineVisibleProcess.workingSetMB ?? 0
    );

    console.log(
      JSON.stringify({
        baseline,
        fixture,
        paged,
        type: 'desktop-visible-render-large-file-list',
        visibleHeapGrowthMB,
        visibleWorkingSetGrowthMB,
      })
    );

    expect(visibleHeapGrowthMB).toBeLessThan(LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(visibleWorkingSetGrowthMB).toBeLessThan(
      LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
    );
  });

  test('shows a newly created collection immediately without leaving the database tab', async ({
    window,
  }) => {
    test.setTimeout(180_000);

    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const collectionName = `Immediate Collection ${Date.now()}`;
    await createCollectionViaDialog(activeWindow, collectionName);

    const createdOption = activeWindow.getByRole('option', { name: new RegExp(collectionName) });
    await expect(createdOption).toBeVisible({ timeout: 15_000 });
    await expect(createdOption).toHaveAttribute('aria-selected', 'true');
    await expect(activeWindow.locator('[data-testid="database-demo-panel"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('@desktop-embedding-backfill preserves backfill progress on the database button across sidebar tab switches', async ({
    electronHarness,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: 8,
      fileCount: 16,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-backfill-progress-tab-switch');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const resolveBackfillActionButton = () =>
      databasePanel
        .locator('button')
        .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
        .first();
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const initialProgress = await waitForPositiveBackfillProgress(
      resolveBackfillActionButton(),
      30_000
    );
    expect(initialProgress.total).toBe(fixture.totalChunks);

    const threadsTab = activeWindow
      .getByTestId('threads-tab-trigger')
      .or(activeWindow.getByRole('tab', { name: 'Threads' }));
    await expect(threadsTab).toBeVisible({ timeout: 10_000 });
    await threadsTab.click();
    await expect(activeWindow.getByTestId('assistant-chat-card')).toBeVisible({ timeout: 10_000 });
    await expect(
      activeWindow
        .getByTestId('database-tab-trigger')
        .or(activeWindow.getByRole('tab', { name: 'Database' }))
    ).toBeVisible({ timeout: 10_000 });

    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const remountedDatabasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const remountedBackfillButton = remountedDatabasePanel
      .locator('button')
      .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
      .first();
    const resumedProgressLabel = await waitForBackfillProgressText(remountedBackfillButton, 30_000);
    const resumedProgress = parseBackfillProgressLabel(resumedProgressLabel);

    expect(resumedProgress.total).toBe(initialProgress.total);
    expect(resumedProgress.done).toBeGreaterThanOrEqual(initialProgress.done);

    await waitForBackfillEnqueueComplete(activeWindow, fixture.embeddingSetId, fixture.totalChunks);
    await electronHarness.restart();
  });

  test('@desktop-embedding-recovery wiping the queue clears visible backfill state and re-enables manual backfill in the same desktop session', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    const context = await electronHarness.restart();
    let activeWindow = await showDatabaseDemoPanel(context.window);

    try {
      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'wasm');

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        chunksPerFile: 8,
        fileCount: 80,
        persistActiveSet: true,
      });

      await reloadRendererInTest(activeWindow, 'database-backfill-wipe-recovery-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const resolveBackfillActionButton = () =>
        databasePanel
          .locator('button')
          .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
          .first();
      const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
      const initialElectronStderrCount = (await getRelevantElectronStderr(context.app)).length;

      await expect(backfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });
      const initialOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      expect(initialOutcome).toBe('queued');

      const initialProgress = parseBackfillProgressLabel(
        await waitForBackfillProgressText(resolveBackfillActionButton(), 30_000)
      );
      expect(initialProgress.total).toBe(fixture.totalChunks);
      expect(initialProgress.done).toBeGreaterThanOrEqual(0);

      const actionsButton = databasePanel.getByRole('button', {
        name: /more embedding actions/i,
      });
      await expect(actionsButton).toBeVisible({ timeout: 15_000 });
      await actionsButton.click({ timeout: 5000 });
      await activeWindow.getByRole('menuitem', { name: /wipe all jobs/i }).click({
        timeout: 5000,
      });

      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 60_000);
      await activeWindow.waitForTimeout(1000);
      const stderrSinceWipe = await getRelevantElectronStderrSince(
        context.app,
        initialElectronStderrCount
      );
      expect(
        stderrSinceWipe.filter((entry) => !entry.includes('Embedding backfill was canceled'))
      ).toEqual([]);

      const countsAfterWipe = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(countsAfterWipe.totalChunks).toBe(fixture.totalChunks);
      expect(countsAfterWipe.embeddedChunks).toBeLessThan(fixture.totalChunks);

      const retryBackfillButton = databasePanel.getByRole('button', {
        name: /^Backfill(?:\s|$)/,
      });
      await waitForBackfillButtonEnabled(activeWindow, retryBackfillButton, 60_000);
      await retryBackfillButton.click({ timeout: 5000 });

      const retryOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      if (retryOutcome === 'error') {
        const status = await getEmbeddingHostStatus(activeWindow);
        throw new Error(
          `Backfill did not recover after wipe and renderer reload: ${status.lastError ?? 'unknown host error'}`
        );
      }
    } finally {
      await clearEmbeddingQueue(activeWindow);
      await stopEmbeddingHost(activeWindow);
      restoreEnv();
    }
  });

  test('@desktop-embedding-recovery re-enables manual backfill after desktop restart when a collection still has unembedded chunks and no queued or running jobs', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    let activeWindow: Page | null = null;
    try {
      const firstContext = await electronHarness.restart();
      activeWindow = await showDatabaseDemoPanel(firstContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'wasm');

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        chunksPerFile: 6,
        fileCount: 40,
        persistActiveSet: true,
      });

      await reloadRendererInTest(activeWindow, 'database-backfill-restart-recovery-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

      await expect(backfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });
      const initialOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      expect(initialOutcome).toBe('queued');

      const actionsButton = databasePanel.getByRole('button', {
        name: /more embedding actions/i,
      });
      await expect(actionsButton).toBeVisible({ timeout: 15_000 });
      await actionsButton.click({ timeout: 5000 });
      await activeWindow.getByRole('menuitem', { name: /wipe all jobs/i }).click({
        timeout: 5000,
      });
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 60_000);

      const countsBeforeRestart = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(countsBeforeRestart.totalChunks).toBe(fixture.totalChunks);
      expect(countsBeforeRestart.embeddedChunks).toBeGreaterThanOrEqual(0);
      expect(countsBeforeRestart.embeddedChunks).toBeLessThan(countsBeforeRestart.totalChunks);

      const restartedContext = await electronHarness.restart();
      activeWindow = await showDatabaseDemoPanel(restartedContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      const restartedCollectionOption = activeWindow.locator(
        `#collection-option-${fixture.embeddingSetId}`
      );
      await expect(restartedCollectionOption).toBeVisible({ timeout: 30_000 });
      await restartedCollectionOption.click({ timeout: 5000 });

      const restartedDatabasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const restartedBackfillButton = restartedDatabasePanel.getByRole('button', {
        name: /^Backfill(?:\s|$)/,
      });
      await expect(restartedBackfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, restartedBackfillButton, 60_000);

      const restartedCounts = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(restartedCounts.totalChunks).toBe(fixture.totalChunks);
      expect(restartedCounts.embeddedChunks).toBeGreaterThanOrEqual(0);
      expect(restartedCounts.embeddedChunks).toBeLessThan(restartedCounts.totalChunks);

      await restartedBackfillButton.click({ timeout: 5000 });
      const retryOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      if (retryOutcome === 'error') {
        const status = await getEmbeddingHostStatus(activeWindow);
        throw new Error(
          `Backfill stayed disabled or failed after desktop restart with pending chunks: ${status.lastError ?? 'unknown host error'}`
        );
      }
    } finally {
      if (activeWindow) {
        await clearEmbeddingQueue(activeWindow);
        await stopEmbeddingHost(activeWindow);
      }
      restoreEnv();
    }
  });

  test('@desktop-embedding-diagnostic does not accumulate hidden-host memory across repeated large backfill cycles on the same host process', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);

    const electronContext = await electronHarness.restart();
    let activeWindow = await showDatabaseDemoPanel(electronContext.window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-repeat-backfill-cycles');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await resetEmbeddingHost(activeWindow);
    await waitForEmbeddingHostState(
      activeWindow,
      (status) => status.state === 'error' || status.state === 'running',
      60_000
    );

    const initialHostPage = await getEmbeddingHostPage(activeWindow);
    const initialSnapshot = await readCombinedMemorySnapshot(
      electronContext.app,
      activeWindow,
      initialHostPage,
      'repeat-cycle-initial'
    );
    const idleSnapshots: CombinedMemorySnapshot[] = [];
    let baseline: CombinedMemorySnapshot | null = null;
    let hostPage = initialHostPage;
    let referenceHostPid: number | null = null;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        chunksPerFile: LARGE_BACKFILL_CYCLE_CHUNKS_PER_FILE,
        fileCount: LARGE_BACKFILL_CYCLE_FILE_COUNT,
        persistActiveSet: false,
      });

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        90_000
      );
      expect(outcome).toBe('queued');

      await waitForBridgeBackfillCompletion(activeWindow, 240_000);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);
      hostPage = await getEmbeddingHostPage(activeWindow);
      await clearEmbeddingQueue(activeWindow);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);
      await forceRendererGarbageCollection(activeWindow);
      await forceRendererGarbageCollection(hostPage);
      await forceRendererGarbageCollection(hostPage);
      const idleSnapshot = await readCombinedMemorySnapshot(
        electronContext.app,
        activeWindow,
        hostPage,
        `repeat-cycle-${cycle + 1}-idle`
      );
      idleSnapshots.push(idleSnapshot);

      const hostProcess = getRuntimeSnapshot(idleSnapshot.process, 'embedding-host');
      if (referenceHostPid === null) {
        referenceHostPid = hostProcess.osProcessId;
        expect(referenceHostPid).toBeTruthy();
        baseline = idleSnapshot;
        continue;
      }

      expect(hostProcess.osProcessId).toBe(referenceHostPid);
    }

    if (!baseline) {
      throw new Error('Expected a warmed idle baseline after the first repeated backfill cycle');
    }

    const finalIdleSnapshot = idleSnapshots.at(-1);
    if (!finalIdleSnapshot) {
      throw new Error('Expected at least one idle snapshot after repeated backfill cycles');
    }

    console.log(
      JSON.stringify({
        baseline,
        idleSnapshots,
        initialSnapshot,
        referenceHostPid,
        type: 'desktop-repeat-backfill-idle-drift',
      })
    );

    expect(growth(finalIdleSnapshot.hostHeap.usedMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB
    );
    expect(
      growth(finalIdleSnapshot.process.mainProcess.rssMB, baseline.process.mainProcess.rssMB)
    ).toBeLessThan(LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB);
  });
});
