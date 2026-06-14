import type {
  DatabaseDemoSemanticSearchTestSnapshot,
  ImportedPathCounts,
  MainProcessHealthSample,
  QueueStatsRow,
} from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  ACTUAL_IMPORT_SENTENCES_PER_FILE,
  ACTUAL_IMPORT_STRESS_FILE_COUNT,
  ACTUAL_IMPORT_VISIBLE_WORKING_SET_LIMIT_MB,
  DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT,
  DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB,
  DESKTOP_DEV_RENDERER_PORT,
  DESKTOP_DEV_RENDERER_URL,
  ERROR_LOCATOR,
  REAL_WORLD_MIXED_STATE_FILE_COUNT,
  cleanupRealWorldMixedStateTest,
  clearEmbeddingQueue,
  clearLargeImportFileSystemMock,
  closeElectronAppInTest,
  createCollectionViaDialog,
  createLargeBackfillCorpusFixture,
  ensureEmbeddingHostWarmed,
  ensureFileExplorerPanelVisible,
  extractStructuredLogString,
  extractUnexpectedLifecycleLogs,
  getBridgeBackfillState,
  getChunkingHostStatus,
  getDatabaseDemoImportSnapshot,
  getDatabaseDemoSemanticSearchSnapshot,
  getEmbeddingHostStatus,
  getEmbeddingQueueStats,
  getEmbeddingSetCounts,
  getEmbeddingSetQueueStats,
  getFileExplorerTestSnapshot,
  getHybridSearchBox,
  getImportedPathCounts,
  getMainBufferedLogs,
  getMainProcessFileSystemFixtureSummary,
  getRelevantElectronStderr,
  getRelevantElectronStderrSince,
  getRendererLogRecords,
  getRendererTimeOrigin,
  getRuntimeSnapshot,
  getVisibleAlertTexts,
  growth,
  installLargeImportFileSystemMock,
  isDatabaseError,
  launchElectronDevAppInTest,
  os,
  parseMainProcessHealthSamples,
  path,
  prepareRealWorldMixedStateScenario,
  readDesktopProcessSnapshot,
  recordContainsText,
  reloadRendererInTest,
  resolveCollectionIdByName,
  sampleMemoryWhileBackfillActive,
  setFileExplorerMaxSelectionCount,
  setImportSettingsForStressTest,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  startBackfillViaBridge,
  stopChunkingHost,
  stopEmbeddingHost,
  waitForActiveProcessingOrFatalError,
  waitForAppReadyInTest,
  waitForBackfillButtonEnabled,
  waitForBackfillQueueMovementOrFatalError,
  waitForCollectionTreeRegionVisible,
  waitForTcpPortOpen,
  withTemporaryProcessEnv,
} = shared;

test.describe('Embedding Host Renderer - diagnostics', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-diagnostic does not reload the visible renderer or churn hidden runtimes during a real 1k-file import and backfill', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await stopEmbeddingHost(activeWindow);
    await stopChunkingHost(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await setImportSettingsForStressTest(activeWindow);
    await reloadRendererInTest(activeWindow, 'embedding-worker-real-import-stress');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await expect
      .poll(async () => await getEmbeddingHostStatus(activeWindow), {
        timeout: 15_000,
      })
      .toMatchObject({ state: 'stopped' });
    await expect
      .poll(async () => await getChunkingHostStatus(activeWindow), {
        timeout: 15_000,
      })
      .toMatchObject({ state: 'stopped' });

    await ensureFileExplorerPanelVisible(activeWindow);
    await installLargeImportFileSystemMock(electronApp.app, {
      fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
      rootPath: '/mock/stress-import',
      sentencesPerFile: ACTUAL_IMPORT_SENTENCES_PER_FILE,
    });

    try {
      const fixtureSummaryAfterInstall = await getMainProcessFileSystemFixtureSummary(
        electronApp.app
      );
      expect(fixtureSummaryAfterInstall).toMatchObject({
        fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
        requestDirectoryAccessCount: 0,
        rootHandlePath: '/mock/stress-import',
      });

      const collectionName = `Stress Import ${Date.now()}`;
      await createCollectionViaDialog(activeWindow, collectionName);
      const embeddingSetId = await resolveCollectionIdByName(activeWindow, collectionName);

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const initialLogCount = (await getMainBufferedLogs(activeWindow)).length;

      const selectRootButton = activeWindow.getByTestId('select-root-button');
      await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
      await selectRootButton.click({ timeout: 5000 });
      await setFileExplorerMaxSelectionCount(activeWindow, ACTUAL_IMPORT_STRESS_FILE_COUNT);

      await expect
        .poll(async () => await getMainProcessFileSystemFixtureSummary(electronApp.app), {
          timeout: 30_000,
        })
        .toMatchObject({
          fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
          requestDirectoryAccessCount: 1,
          rootHandlePath: '/mock/stress-import',
        });

      const selectAllButton = activeWindow.getByRole('button', { name: /^Select All$/i }).first();
      await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
      await selectAllButton.click({ timeout: 5000 });

      await expect(activeWindow.getByTestId('selection-count')).toHaveText(
        String(ACTUAL_IMPORT_STRESS_FILE_COUNT),
        {
          timeout: 60_000,
        }
      );

      const fixtureSummaryAfterSelection = await getMainProcessFileSystemFixtureSummary(
        electronApp.app
      );
      const fileExplorerSnapshotAfterSelection = await getFileExplorerTestSnapshot(activeWindow);
      expect(fixtureSummaryAfterSelection).toMatchObject({
        fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
        requestDirectoryAccessCount: 1,
        rootHandlePath: '/mock/stress-import',
      });
      expect(fixtureSummaryAfterSelection?.readDirectoryCalls.length).toBeGreaterThan(0);
      expect(fixtureSummaryAfterSelection?.readDirectoryCalls).toEqual(
        expect.arrayContaining(['/mock/stress-import'])
      );
      expect(
        fixtureSummaryAfterSelection?.readDirectoryCalls.every(
          (readPath) => readPath === '/mock/stress-import'
        )
      ).toBe(true);
      expect(fileExplorerSnapshotAfterSelection).not.toBeNull();
      // Storage v5: the live pick yields a durable RootId (UUID) as the
      // identity key, never the filesystem path. The path lives only in
      // rootDirectoryPath; selection keys are composited from the RootId.
      const currentFolderId = fileExplorerSnapshotAfterSelection?.currentFolderId;
      expect(typeof currentFolderId).toBe('string');
      expect(currentFolderId).toBeTruthy();
      expect(currentFolderId).not.toBe('/mock/stress-import');
      expect(fileExplorerSnapshotAfterSelection).toMatchObject({
        rootDirectoryPath: '/mock/stress-import',
        selectedFilePathCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
      });
      expect(
        fileExplorerSnapshotAfterSelection?.selectedFilePathSamples.every((key) =>
          key.startsWith(`${currentFolderId}|@|`)
        )
      ).toBe(true);

      const importButton = activeWindow.getByRole('button', { name: /^Import\s*\(/ });
      await expect(importButton).toContainText(`(${ACTUAL_IMPORT_STRESS_FILE_COUNT})`, {
        timeout: 30_000,
      });

      await importButton.click({ timeout: 5000 });

      const runtimeIds = {
        chunking: new Set<string>(),
        embedding: new Set<string>(),
      };
      let peakVisibleWorkingSetMB = 0;
      const importStartedAt = Date.now();
      let importedPathCounts: ImportedPathCounts | null = null;

      while (Date.now() - importStartedAt < 240_000) {
        const [
          pathCounts,
          timeOrigin,
          embeddingStatus,
          chunkingStatus,
          processSnapshot,
          rendererLogs,
          importSnapshot,
        ] = await Promise.all([
          getImportedPathCounts(activeWindow, '/mock/stress-import'),
          getRendererTimeOrigin(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
          readDesktopProcessSnapshot(electronApp.app),
          getRendererLogRecords(activeWindow),
          getDatabaseDemoImportSnapshot(activeWindow),
        ]);

        if (embeddingStatus.state !== 'stopped') {
          runtimeIds.embedding.add(embeddingStatus.runtimeId);
        }
        if (chunkingStatus.state !== 'stopped') {
          runtimeIds.chunking.add(chunkingStatus.runtimeId);
        }
        const visibleRuntime = getRuntimeSnapshot(processSnapshot, 'visible-ui');
        peakVisibleWorkingSetMB = Math.max(
          peakVisibleWorkingSetMB,
          visibleRuntime.workingSetMB ?? 0
        );

        expect(timeOrigin).toBe(initialTimeOrigin);

        const catastrophicImportLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Enhanced import failed catastrophically')
        );
        const importErrors = importSnapshot?.progress?.errors ?? [];
        if (importErrors.length > 0) {
          const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
            getVisibleAlertTexts(activeWindow),
            getMainProcessFileSystemFixtureSummary(electronApp.app),
            getFileExplorerTestSnapshot(activeWindow),
          ]);
          throw new Error(
            `Real desktop import reported progress errors: ${JSON.stringify(importErrors.slice(0, 10))}\nimportSnapshot=${JSON.stringify(importSnapshot)}\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
          );
        }
        if (catastrophicImportLog) {
          const errorMessage =
            extractStructuredLogString(catastrophicImportLog, 'error') ??
            catastrophicImportLog.message ??
            'unknown enhanced import failure';
          const errorStack = extractStructuredLogString(catastrophicImportLog, 'stack');
          const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
            getVisibleAlertTexts(activeWindow),
            getMainProcessFileSystemFixtureSummary(electronApp.app),
            getFileExplorerTestSnapshot(activeWindow),
          ]);
          throw new Error(
            `Enhanced import failed during real desktop import: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
          );
        }

        if (
          pathCounts.fileCount === ACTUAL_IMPORT_STRESS_FILE_COUNT &&
          pathCounts.totalChunks > 0
        ) {
          importedPathCounts = pathCounts;
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      if (!importedPathCounts) {
        const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
          getVisibleAlertTexts(activeWindow),
          getMainProcessFileSystemFixtureSummary(electronApp.app),
          getFileExplorerTestSnapshot(activeWindow),
        ]);
        throw new Error(
          `Timed out waiting for imported file records and chunks to persist\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
        );
      }

      expect(importedPathCounts.fileCount).toBe(ACTUAL_IMPORT_STRESS_FILE_COUNT);
      expect(importedPathCounts.totalChunks).toBeGreaterThan(0);

      const collectionOption = activeWindow.getByRole('option', {
        name: new RegExp(collectionName),
      });
      await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

      const backfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(backfillButton).toBeVisible({ timeout: 30_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });

      const backfillOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        embeddingSetId,
        120_000
      );
      expect(backfillOutcome).toBe('queued');

      const memorySamples = await sampleMemoryWhileBackfillActive(
        electronApp.app,
        activeWindow,
        8,
        3000
      );
      for (const sample of memorySamples) {
        const embeddingStatus = await getEmbeddingHostStatus(activeWindow);
        const chunkingStatus = await getChunkingHostStatus(activeWindow);
        runtimeIds.embedding.add(embeddingStatus.runtimeId);
        if (chunkingStatus.state !== 'stopped') {
          runtimeIds.chunking.add(chunkingStatus.runtimeId);
        }
        expect(await getRendererTimeOrigin(activeWindow)).toBe(initialTimeOrigin);
        peakVisibleWorkingSetMB = Math.max(
          peakVisibleWorkingSetMB,
          getRuntimeSnapshot(sample.snapshot.process, 'visible-ui').workingSetMB ?? 0
        );
      }

      const timeOriginAfterBackfill = await getRendererTimeOrigin(activeWindow);
      expect(timeOriginAfterBackfill).toBe(initialTimeOrigin);

      await expect
        .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
          timeout: 240_000,
        })
        .toMatchObject({
          fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
          totalChunks: expect.any(Number),
          embeddedChunks: expect.any(Number),
        });

      const semanticQuery = 'stress-file-42-sentence-0';
      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');
      await semanticSearchBox.fill(semanticQuery);
      await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

      const semanticSearchStartedAt = Date.now();
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      let lastSemanticSearchAlertTexts: string[] = [];
      while (Date.now() - semanticSearchStartedAt < 60_000) {
        const [rendererLogs, alertTexts, emptyStateCount, searchingCount, semanticSearchSnapshot] =
          await Promise.all([
            getRendererLogRecords(activeWindow),
            getVisibleAlertTexts(activeWindow),
            emptySemanticSearchMessage.count(),
            searchingOverlay.count(),
            getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          ]);
        lastSemanticSearchSnapshot = semanticSearchSnapshot;
        lastSemanticSearchAlertTexts = alertTexts;
        const queueFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Embedding worker queue failed')
        );
        const searchFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Search failed')
        );

        if (queueFailureLog || searchFailureLog) {
          const failureLog = queueFailureLog ?? searchFailureLog;
          const errorMessage =
            (failureLog ? extractStructuredLogString(failureLog, 'error') : null) ??
            failureLog?.message ??
            'unknown semantic search failure';
          const errorStack = failureLog ? extractStructuredLogString(failureLog, 'stack') : null;
          throw new Error(
            `Semantic search failed after real desktop backfill: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}\nalerts=${JSON.stringify(alertTexts)}`
          );
        }

        if (semanticSearchSnapshot?.error) {
          throw new Error(
            `Semantic search failed after real desktop backfill: ${semanticSearchSnapshot.error}\nalerts=${JSON.stringify(alertTexts)}`
          );
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      if (
        !(
          lastSemanticSearchSnapshot?.hasSearched &&
          !lastSemanticSearchSnapshot.isSearching &&
          lastSemanticSearchSnapshot.resultCount > 0 &&
          lastSemanticSearchSnapshot.firstResultNodeId !== null
        )
      ) {
        throw new Error(
          `Semantic search did not surface rendered results within 60s after real desktop backfill\nsnapshot=${JSON.stringify(lastSemanticSearchSnapshot)}\nalerts=${JSON.stringify(lastSemanticSearchAlertTexts)}`
        );
      }
      await expect(emptySemanticSearchMessage).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(async () => await getDatabaseDemoSemanticSearchSnapshot(activeWindow), {
          timeout: 60_000,
        })
        .toMatchObject({
          error: null,
          hasSearched: true,
          isSearching: false,
          resultCount: expect.any(Number),
        });

      const finalLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLifecycleLogs = extractUnexpectedLifecycleLogs(
        finalLogs.slice(initialLogCount)
      );

      expect(runtimeIds.embedding.size).toBe(1);
      expect(runtimeIds.chunking.size).toBeLessThanOrEqual(1);
      expect(peakVisibleWorkingSetMB).toBeLessThan(ACTUAL_IMPORT_VISIBLE_WORKING_SET_LIMIT_MB);
      expect(unexpectedLifecycleLogs).toEqual([]);
    } finally {
      await clearLargeImportFileSystemMock(electronApp.app);
    }
  });

  test('@desktop-embedding-mixed keeps search working and backfill actionable during a real mixed-state desktop session', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(540_000);
    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;
    const scenario = await prepareRealWorldMixedStateScenario(electronApp.app, window);
    const { importEmbeddingSetId, searchableEmbeddingSetId } = scenario;
    const activeWindow = scenario.activeWindow;
    // Clicks in this stress test use 30s timeouts because the collection browser's loading
    // overlay (z-20, aria-busy) stays visible for 15–30s while refetching data after heavy
    // import/backfill/search operations. This is a known collection browser perf issue.
    try {
      const searchableCollectionOption = activeWindow.locator(
        `#collection-option-${searchableEmbeddingSetId}`
      );
      await expect(searchableCollectionOption).toBeVisible({ timeout: 15_000 });
      await searchableCollectionOption.click({ timeout: 30_000 });
      await expect(searchableCollectionOption).toHaveAttribute('aria-selected', 'true');

      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await semanticSearchBox.fill('desktop import backfill regression');
      await queryButton.click({ timeout: 30_000 });

      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');
      const mixedStateFailures: string[] = [];

      const semanticSearchStartedAt = Date.now();
      let searchWorked = false;
      let sawBackgroundQueuePressureDuringSearch = false;
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      while (Date.now() - semanticSearchStartedAt < 60_000) {
        const [
          semanticSearchSnapshot,
          rendererLogs,
          emptyStateCount,
          searchingCount,
          embeddingHostStatus,
          queueStats,
        ] = await Promise.all([
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          getRendererLogRecords(activeWindow),
          emptySemanticSearchMessage.count(),
          searchingOverlay.count(),
          getEmbeddingHostStatus(activeWindow),
          getEmbeddingQueueStats(activeWindow),
        ]);

        lastSemanticSearchSnapshot = semanticSearchSnapshot;
        if (queueStats.queued + queueStats.running > 0) {
          sawBackgroundQueuePressureDuringSearch = true;
        }

        const queueFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Embedding worker queue failed')
        );
        const searchFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Search failed')
        );

        if (queueFailureLog || searchFailureLog) {
          const failureLog = queueFailureLog ?? searchFailureLog;
          const errorMessage =
            (failureLog ? extractStructuredLogString(failureLog, 'error') : null) ??
            failureLog?.message ??
            'unknown semantic search failure';
          const errorStack = failureLog ? extractStructuredLogString(failureLog, 'stack') : null;
          throw new Error(
            `Mixed-state semantic search failed: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}`
          );
        }

        if (
          queueStats.queued + queueStats.running > 0 &&
          (embeddingHostStatus.state === 'error' || embeddingHostStatus.state === 'stopped')
        ) {
          mixedStateFailures.push(
            `embedding host stopped during active mixed-state backfill: hostStatus=${JSON.stringify(embeddingHostStatus)} queueStats=${JSON.stringify(queueStats)}`
          );
          break;
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          !semanticSearchSnapshot.error &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          searchWorked = true;
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      const expandAllButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Expand all' });
      await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
      await expandAllButton.click({ timeout: 30_000 });

      const [embeddingHostStatusAfterExpand, queueStatsAfterExpand] = await Promise.all([
        getEmbeddingHostStatus(activeWindow),
        getEmbeddingQueueStats(activeWindow),
      ]);

      if (
        queueStatsAfterExpand.queued + queueStatsAfterExpand.running > 0 &&
        (embeddingHostStatusAfterExpand.state === 'error' ||
          embeddingHostStatusAfterExpand.state === 'stopped')
      ) {
        mixedStateFailures.push(
          `embedding host stopped during active mixed-state backfill after expand-all: hostStatus=${JSON.stringify(embeddingHostStatusAfterExpand)} queueStats=${JSON.stringify(queueStatsAfterExpand)}`
        );
      }

      const collectionTreeVisibleAfterExpand =
        await waitForCollectionTreeRegionVisible(collectionTreeRegion);
      let expandedTreeNodeCount: number | null = null;
      let searchResultStillAvailableAfterTreeLoss = false;
      if (collectionTreeVisibleAfterExpand) {
        expandedTreeNodeCount = await collectionTreeRegion.evaluate(
          (node) => node.querySelectorAll('[aria-expanded="true"]').length
        );
      } else {
        const [
          queueStatsAfterTreeLoss,
          hostStatusAfterTreeLoss,
          semanticSearchSnapshotAfterTreeLoss,
          fileExplorerSnapshotAfterTreeLoss,
          importSnapshotAfterTreeLoss,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          getFileExplorerTestSnapshot(activeWindow),
          getDatabaseDemoImportSnapshot(activeWindow),
        ]);
        searchResultStillAvailableAfterTreeLoss =
          !!semanticSearchSnapshotAfterTreeLoss?.hasSearched &&
          !semanticSearchSnapshotAfterTreeLoss.isSearching &&
          !semanticSearchSnapshotAfterTreeLoss.error &&
          semanticSearchSnapshotAfterTreeLoss.resultCount > 0 &&
          semanticSearchSnapshotAfterTreeLoss.firstResultNodeId !== null;
        if (!searchResultStillAvailableAfterTreeLoss) {
          mixedStateFailures.push(
            `collection tree region disappeared and search state was not preserved after expand-all during mixed-state run: hostStatus=${JSON.stringify(hostStatusAfterTreeLoss)} queueStats=${JSON.stringify(queueStatsAfterTreeLoss)} semanticSearch=${JSON.stringify(semanticSearchSnapshotAfterTreeLoss)} fileExplorer=${JSON.stringify(fileExplorerSnapshotAfterTreeLoss)} importSnapshot=${JSON.stringify(importSnapshotAfterTreeLoss)}`
          );
        }
      }

      const importCollectionOption = activeWindow.locator(
        `#collection-option-${importEmbeddingSetId}`
      );
      await expect(importCollectionOption).toBeVisible({ timeout: 15_000 });
      await importCollectionOption.click({ timeout: 30_000 });
      await expect(importCollectionOption).toHaveAttribute('aria-selected', 'true');

      const importCollectionBackfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(importCollectionBackfillButton).toBeVisible({ timeout: 15_000 });

      const [
        backfillEnabled,
        globalQueueStats,
        importCollectionQueueStats,
        importCollectionCounts,
        semanticSearchSnapshotAfterChecks,
        importSnapshotAfterChecks,
        alerts,
        fileExplorerSnapshotAfterChecks,
        fixtureSummaryAfterChecks,
        electronStderr,
        embeddingHostStatus,
        chunkingHostStatus,
      ] = await Promise.all([
        importCollectionBackfillButton.isEnabled(),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, importEmbeddingSetId),
        getDatabaseDemoSemanticSearchSnapshot(activeWindow),
        getDatabaseDemoImportSnapshot(activeWindow),
        getVisibleAlertTexts(activeWindow),
        getFileExplorerTestSnapshot(activeWindow),
        getMainProcessFileSystemFixtureSummary(electronApp.app),
        getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        getEmbeddingHostStatus(activeWindow),
        getChunkingHostStatus(activeWindow),
      ]);

      const failures = [...mixedStateFailures];
      if (!searchWorked) {
        failures.push(
          'semantic search returned no results while background embedding work was active'
        );
      }
      if (
        !sawBackgroundQueuePressureDuringSearch &&
        globalQueueStats.queued + globalQueueStats.running === 0
      ) {
        failures.push('background queue pressure drained before mixed-state search checks');
      }
      if (!backfillEnabled) {
        failures.push(
          'backfill button was disabled for the selected import collection while that collection had no queued or running jobs'
        );
      }
      if (
        !fileExplorerSnapshotAfterChecks ||
        fileExplorerSnapshotAfterChecks.selectedFilePathCount !== REAL_WORLD_MIXED_STATE_FILE_COUNT
      ) {
        failures.push('explorer selection state did not remain mounted at 1002 selected files');
      }
      if (!scenario.sawChunkingHostActive) {
        failures.push('chunking host never activated during the real import path');
      }

      if (failures.length > 0) {
        throw new Error(
          `Mixed-state desktop regression reproduced: ${failures.join('; ')}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `sawBackgroundQueuePressureDuringSearch=${sawBackgroundQueuePressureDuringSearch}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `semanticSearchSnapshot=${JSON.stringify(semanticSearchSnapshotAfterChecks ?? lastSemanticSearchSnapshot)}\n` +
            `expandedTreeNodeCount=${expandedTreeNodeCount}\n` +
            `importSnapshot=${JSON.stringify(importSnapshotAfterChecks)}\n` +
            `alerts=${JSON.stringify(alerts)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorerSnapshotAfterChecks)}\n` +
            `fixture=${JSON.stringify(fixtureSummaryAfterChecks)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      expect(sawBackgroundQueuePressureDuringSearch).toBe(true);
      expect(importCollectionQueueStats.queued + importCollectionQueueStats.running).toBe(0);
      expect(importCollectionCounts.fileCount).toBe(REAL_WORLD_MIXED_STATE_FILE_COUNT);
      expect(importCollectionCounts.totalChunks).toBeGreaterThan(0);
      expect(importCollectionCounts.embeddedChunks).toBe(0);
      expect(searchWorked).toBe(true);
      expect(collectionTreeVisibleAfterExpand || searchResultStillAvailableAfterTreeLoss).toBe(
        true
      );
      expect(backfillEnabled).toBe(true);
      if (collectionTreeVisibleAfterExpand) {
        expect(expandedTreeNodeCount).toBeGreaterThan(0);
      }
      expect(electronStderr).toEqual([]);
    } finally {
      await cleanupRealWorldMixedStateTest(electronApp, activeWindow);
    }
  });

  test('@desktop-embedding-mixed keeps the import collection backfill and search path working during a real mixed-state desktop session', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(540_000);
    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;

    const scenario = await prepareRealWorldMixedStateScenario(electronApp.app, window);
    const activeWindow = scenario.activeWindow;

    // Clicks in this stress test use 30s timeouts because the collection browser's loading
    // overlay (z-20, aria-busy) stays visible for 15–30s while refetching data after heavy
    // import/backfill/search operations. This is a known collection browser perf issue.
    try {
      const importCollectionOption = activeWindow.locator(
        `#collection-option-${scenario.importEmbeddingSetId}`
      );
      await expect(importCollectionOption).toBeVisible({ timeout: 15_000 });
      await importCollectionOption.click({ timeout: 30_000 });
      await expect(importCollectionOption).toHaveAttribute('aria-selected', 'true');

      const backfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(backfillButton).toBeVisible({ timeout: 15_000 });

      const [
        backfillEnabledBefore,
        globalQueueStatsBefore,
        importCollectionQueueStatsBefore,
        importCollectionCountsBefore,
        fileExplorerBefore,
      ] = await Promise.all([
        backfillButton.isEnabled(),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
        getFileExplorerTestSnapshot(activeWindow),
      ]);

      const failures: string[] = [];
      if (!backfillEnabledBefore) {
        failures.push(
          'backfill button was disabled for the import collection before manual backfill started'
        );
      }
      if (globalQueueStatsBefore.queued + globalQueueStatsBefore.running <= 0) {
        failures.push('background queue pressure was not active before import-collection checks');
      }
      if (importCollectionQueueStatsBefore.queued + importCollectionQueueStatsBefore.running > 0) {
        failures.push('import collection already had active jobs before manual backfill');
      }
      if (importCollectionCountsBefore.embeddedChunks !== 0) {
        failures.push('import collection was already partially embedded before manual backfill');
      }
      if (
        !fileExplorerBefore ||
        fileExplorerBefore.selectedFilePathCount !== REAL_WORLD_MIXED_STATE_FILE_COUNT
      ) {
        failures.push('explorer selection was not still mounted before import-collection backfill');
      }

      if (failures.length > 0) {
        const [importSnapshot, electronStderr, embeddingHostStatus, chunkingHostStatus] =
          await Promise.all([
            getDatabaseDemoImportSnapshot(activeWindow),
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
          ]);
        throw new Error(
          `Import-collection mixed-state regression reproduced before backfill: ${failures.join('; ')}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStatsBefore)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStatsBefore)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCountsBefore)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorerBefore)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      await backfillButton.click({ timeout: 30_000 });

      let importBackfillOutcome: 'error' | 'queued';
      try {
        importBackfillOutcome = await waitForBackfillQueueMovementOrFatalError(
          activeWindow,
          scenario.importEmbeddingSetId,
          60_000
        );
      } catch (error) {
        const [
          globalQueueStats,
          importCollectionQueueStats,
          importCollectionCounts,
          importSnapshot,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
          getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
          getDatabaseDemoImportSnapshot(activeWindow),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);
        throw new Error(
          `Import-collection backfill did not produce set-scoped queue movement under mixed-state load: ${error instanceof Error ? error.message : String(error)}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }
      if (importBackfillOutcome === 'error') {
        const [electronStderr, embeddingHostStatus, chunkingHostStatus, importSnapshot] =
          await Promise.all([
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
            getDatabaseDemoImportSnapshot(activeWindow),
          ]);
        throw new Error(
          'Import-collection backfill failed to start under mixed-state load\n' +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      const embedStartedAt = Date.now();
      let embeddedChunkCount = 0;
      while (Date.now() - embedStartedAt < 120_000) {
        const [counts, queueStats, embeddingHostStatus, chunkingHostStatus, electronStderr] =
          await Promise.all([
            getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
            getEmbeddingQueueStats(activeWindow),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          ]);

        if (counts.embeddedChunks > 0 && queueStats.queued + queueStats.running > 0) {
          embeddedChunkCount = counts.embeddedChunks;
          break;
        }

        if (
          electronStderr.length > 0 ||
          embeddingHostStatus.state === 'error' ||
          chunkingHostStatus.state === 'error'
        ) {
          throw new Error(
            'Hidden runtime failure surfaced during mixed-state import backfill\n' +
              `counts=${JSON.stringify(counts)}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}\n` +
              `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
              `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
          );
        }

        await activeWindow.waitForTimeout(500);
      }

      expect(embeddedChunkCount).toBeGreaterThan(0);

      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await semanticSearchBox.fill('stress-file-42-sentence-0');
      await queryButton.click({ timeout: 30_000 });

      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');

      const searchStartedAt = Date.now();
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      while (Date.now() - searchStartedAt < 60_000) {
        const [
          semanticSearchSnapshot,
          emptyStateCount,
          searchingCount,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          emptySemanticSearchMessage.count(),
          searchingOverlay.count(),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);

        lastSemanticSearchSnapshot = semanticSearchSnapshot;

        if (
          electronStderr.length > 0 ||
          embeddingHostStatus.state === 'error' ||
          chunkingHostStatus.state === 'error'
        ) {
          throw new Error(
            'Hidden runtime failure surfaced during mixed-state import search\n' +
              `semanticSearch=${JSON.stringify(semanticSearchSnapshot)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}\n` +
              `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
              `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
          );
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          !semanticSearchSnapshot.error &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      if (
        !(
          lastSemanticSearchSnapshot?.hasSearched &&
          !lastSemanticSearchSnapshot.isSearching &&
          !lastSemanticSearchSnapshot.error &&
          lastSemanticSearchSnapshot.resultCount > 0 &&
          lastSemanticSearchSnapshot.firstResultNodeId !== null
        )
      ) {
        const [
          globalQueueStats,
          importCollectionQueueStats,
          importCollectionCounts,
          importSnapshot,
          fileExplorer,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
          getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
          getDatabaseDemoImportSnapshot(activeWindow),
          getFileExplorerTestSnapshot(activeWindow),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);
        throw new Error(
          'Import-collection mixed-state semantic search did not return results\n' +
            `semanticSearch=${JSON.stringify(lastSemanticSearchSnapshot)}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorer)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      const expandAllButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Expand all' });
      await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
      await expandAllButton.click({ timeout: 30_000 });

      const [
        collectionTreeVisibleAfterExpand,
        globalQueueStatsAfterExpand,
        importCollectionQueueStatsAfterExpand,
        importCollectionCountsAfterExpand,
        importSnapshotAfterExpand,
        semanticSearchSnapshotAfterExpand,
        fileExplorerAfterExpand,
        electronStderrAfterExpand,
        embeddingHostStatusAfterExpand,
        chunkingHostStatusAfterExpand,
      ] = await Promise.all([
        waitForCollectionTreeRegionVisible(collectionTreeRegion),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
        getDatabaseDemoImportSnapshot(activeWindow),
        getDatabaseDemoSemanticSearchSnapshot(activeWindow),
        getFileExplorerTestSnapshot(activeWindow),
        getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        getEmbeddingHostStatus(activeWindow),
        getChunkingHostStatus(activeWindow),
      ]);

      const searchSnapshotAfterExpand =
        semanticSearchSnapshotAfterExpand ?? lastSemanticSearchSnapshot;
      const searchResultStillAvailable =
        !!searchSnapshotAfterExpand?.hasSearched &&
        !searchSnapshotAfterExpand.isSearching &&
        !searchSnapshotAfterExpand.error &&
        searchSnapshotAfterExpand.resultCount > 0 &&
        searchSnapshotAfterExpand.firstResultNodeId !== null;

      if (!(collectionTreeVisibleAfterExpand || searchResultStillAvailable)) {
        throw new Error(
          'Search results were not visible or reflected in the semantic-search snapshot after expand-all during mixed-state import backfill\n' +
            `globalQueueStats=${JSON.stringify(globalQueueStatsAfterExpand)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStatsAfterExpand)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCountsAfterExpand)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshotAfterExpand)}\n` +
            `semanticSearchSnapshot=${JSON.stringify(searchSnapshotAfterExpand)}\n` +
            `collectionTreeVisible=${collectionTreeVisibleAfterExpand}\n` +
            `fileExplorer=${JSON.stringify(fileExplorerAfterExpand)}\n` +
            `electronStderr=${JSON.stringify(electronStderrAfterExpand)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatusAfterExpand)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatusAfterExpand)}`
        );
      }
      expect(searchResultStillAvailable).toBe(true);
      expect(importCollectionCountsAfterExpand.embeddedChunks).toBeGreaterThan(0);
      const importCollectionBackfillComplete =
        importCollectionCountsAfterExpand.totalChunks > 0 &&
        importCollectionCountsAfterExpand.embeddedChunks ===
          importCollectionCountsAfterExpand.totalChunks;
      expect(
        globalQueueStatsAfterExpand.queued +
          globalQueueStatsAfterExpand.running +
          (importCollectionBackfillComplete ? 1 : 0)
      ).toBeGreaterThan(0);
      expect(
        importCollectionQueueStatsAfterExpand.queued +
          importCollectionQueueStatsAfterExpand.running +
          (importCollectionBackfillComplete ? 1 : 0)
      ).toBeGreaterThan(0);
      expect(fileExplorerAfterExpand?.selectedFilePathCount).toBe(
        REAL_WORLD_MIXED_STATE_FILE_COUNT
      );
      expect(electronStderrAfterExpand).toEqual([]);
      expect(embeddingHostStatusAfterExpand.state).not.toBe('error');
      expect(chunkingHostStatusAfterExpand.state).not.toBe('error');
      expect(importSnapshotAfterExpand?.activeCollectionId).not.toBeNull();
    } finally {
      await cleanupRealWorldMixedStateTest(electronApp, activeWindow);
    }
  });

  test('@desktop-embedding-mixed reproduces the desktop:dev mixed-state visible renderer crash path under real import and backfill load', async () => {
    test.skip(!!process.env['CI'], 'Requires a local desktop dev session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO'] !== '1',
      'Opt-in repro harness. Set BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO=1 to run.'
    );
    test.setTimeout(540_000);

    await waitForTcpPortOpen(DESKTOP_DEV_RENDERER_PORT, 5000).catch((error) => {
      throw new Error(
        `Desktop dev renderer must already be running on ${DESKTOP_DEV_RENDERER_URL} before this repro test starts.\n` +
          'Start it with `pnpm --filter @brainstrike/desktop dev:renderer` in a separate terminal.\n' +
          `error=${error instanceof Error ? error.message : String(error)}`
      );
    });
    const userDataDir = path.join(
      os.tmpdir(),
      `brainstrike-desktop-dev-repro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const electronContext = await launchElectronDevAppInTest(userDataDir);
    let activeWindow = electronContext.window;
    let electronStderrBaselineCount = 0;

    try {
      await waitForAppReadyInTest(activeWindow);
      electronStderrBaselineCount = (await getRelevantElectronStderr(electronContext.app)).length;
      const scenario = await prepareRealWorldMixedStateScenario(electronContext.app, activeWindow);
      activeWindow = scenario.activeWindow;

      const baselineTimeOrigin = scenario.initialTimeOrigin;
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const samples: Array<{
        elapsedMs: number;
        importPhase: string | null;
        queued: number;
        running: number;
        visibleWorkingSetMB: number | null;
      }> = [];

      const startedAt = Date.now();
      while (Date.now() - startedAt < 420_000) {
        try {
          const [
            timeOrigin,
            processSnapshot,
            queueStats,
            importSnapshot,
            mainLogs,
            electronStderr,
          ] = await Promise.all([
            getRendererTimeOrigin(activeWindow),
            readDesktopProcessSnapshot(electronContext.app),
            getEmbeddingQueueStats(activeWindow),
            getDatabaseDemoImportSnapshot(activeWindow),
            getMainBufferedLogs(activeWindow),
            getRelevantElectronStderrSince(electronContext.app, electronStderrBaselineCount),
          ]);

          const visibleWorkingSetMB = getRuntimeSnapshot(
            processSnapshot,
            'visible-ui'
          ).workingSetMB;
          samples.push({
            elapsedMs: Date.now() - startedAt,
            importPhase: importSnapshot?.progress?.phase ?? null,
            queued: queueStats.queued,
            running: queueStats.running,
            visibleWorkingSetMB,
          });

          if (timeOrigin !== baselineTimeOrigin) {
            throw new Error(
              'Visible renderer reloaded during desktop:dev mixed-state repro.\n' +
                `baselineTimeOrigin=${baselineTimeOrigin}\n` +
                `currentTimeOrigin=${timeOrigin}\n` +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          const crashLifecycleLogs = extractUnexpectedLifecycleLogs(
            mainLogs.slice(baselineMainLogs.length)
          );
          if (crashLifecycleLogs.length > 0) {
            throw new Error(
              'Detected visible-renderer crash/reload lifecycle logs during desktop:dev mixed-state repro.\n' +
                `crashLifecycleLogs=${JSON.stringify(crashLifecycleLogs)}\n` +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          if (
            electronStderr.some(
              (line) =>
                line.includes('Renderer crashed; deferring recovery') ||
                line.includes('Render frame was disposed before WebFrameMain could be accessed')
            )
          ) {
            throw new Error(
              'Detected renderer-crash aftermath on desktop:dev mixed-state repro.\n' +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          await activeWindow.waitForTimeout(1000);
        } catch (error) {
          throw new Error(
            'Desktop:dev mixed-state repro triggered a renderer failure path.\n' +
              `error=${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      throw new Error(
        'Desktop:dev mixed-state repro did not trigger the renderer failure path within 420s.\n' +
          `samples=${JSON.stringify(samples.slice(-40))}`
      );
    } finally {
      await clearLargeImportFileSystemMock(electronContext.app).catch(() => undefined);
      await closeElectronAppInTest(electronContext).catch(() => undefined);
    }
  });

  test('@desktop-embedding-mixed keeps desktop:dev 12k visible-ui working-set growth bounded during active backfill', async () => {
    test.skip(!!process.env['CI'], 'Requires a local desktop dev session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO'] !== '1',
      'Opt-in repro harness. Set BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO=1 to run.'
    );
    test.setTimeout(540_000);

    await waitForTcpPortOpen(DESKTOP_DEV_RENDERER_PORT, 5000).catch((error) => {
      throw new Error(
        `Desktop dev renderer must already be running on ${DESKTOP_DEV_RENDERER_URL} before this repro test starts.\n` +
          'Start it with `pnpm --filter @brainstrike/desktop dev:renderer` in a separate terminal.\n' +
          `error=${error instanceof Error ? error.message : String(error)}`
      );
    });

    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });
    const userDataDir = path.join(
      os.tmpdir(),
      `brainstrike-desktop-dev-12k-repro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const electronContext = await launchElectronDevAppInTest(userDataDir);

    try {
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error('Database failed to initialize for the desktop:dev 12k repro.');
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, 'desktop-dev-visible-growth-12k');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 623,
        chunksPerFile: 20,
        chunkContentBytes: 1024,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, 'desktop-dev-visible-growth-12k-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const baselineStderrCount = (await getRelevantElectronStderr(electronContext.app)).length;

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
      expect(outcome).toBe('running');

      let lastQueueStats: QueueStatsRow | null = null;
      let lastBackfillState: Awaited<ReturnType<typeof getBridgeBackfillState>> = null;
      let mainProcessHealthSamples: MainProcessHealthSample[] = [];
      let sampledWhileRunning = false;

      const sampleStartedAt = Date.now();
      while (Date.now() - sampleStartedAt < 420_000) {
        const [timeOrigin, queueStats, mainLogs, electronStderr, backfillState] = await Promise.all(
          [
            getRendererTimeOrigin(activeWindow),
            getEmbeddingQueueStats(activeWindow),
            getMainBufferedLogs(activeWindow),
            getRelevantElectronStderrSince(electronContext.app, baselineStderrCount),
            getBridgeBackfillState(activeWindow),
          ]
        );

        if (timeOrigin !== initialTimeOrigin) {
          throw new Error(
            'Visible renderer reloaded during the desktop:dev 12k repro.\n' +
              `baselineTimeOrigin=${initialTimeOrigin}\n` +
              `currentTimeOrigin=${timeOrigin}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}`
          );
        }

        const crashLifecycleLogs = extractUnexpectedLifecycleLogs(
          mainLogs.slice(baselineMainLogs.length)
        );
        if (crashLifecycleLogs.length > 0) {
          throw new Error(
            'Detected renderer crash/reload lifecycle logs during the desktop:dev 12k repro.\n' +
              `crashLifecycleLogs=${JSON.stringify(crashLifecycleLogs)}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}`
          );
        }

        if (
          electronStderr.some(
            (line) =>
              line.includes('Renderer crashed; deferring recovery') ||
              line.includes('Render frame was disposed before WebFrameMain could be accessed')
          )
        ) {
          throw new Error(
            'Detected renderer crash aftermath on stderr during the desktop:dev 12k repro.\n' +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}`
          );
        }

        lastQueueStats = queueStats;
        lastBackfillState = backfillState;
        mainProcessHealthSamples = parseMainProcessHealthSamples(
          mainLogs.slice(baselineMainLogs.length)
        );
        if (queueStats.running > 0 || queueStats.succeeded > 0) {
          sampledWhileRunning = true;
        }

        const visibleWorkingSetSamplesKB = mainProcessHealthSamples
          .map((sample) => sample.visibleUiWorkingSetKB)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const baselineVisibleWorkingSetFromHealthMB =
          visibleWorkingSetSamplesKB.length > 0 ? visibleWorkingSetSamplesKB[0]! / 1024 : 0;
        const peakVisibleWorkingSetMB =
          visibleWorkingSetSamplesKB.length > 0
            ? Math.max(...visibleWorkingSetSamplesKB) / 1024
            : 0;
        const visibleWorkingSetGrowthFromHealthMB = growth(
          peakVisibleWorkingSetMB,
          baselineVisibleWorkingSetFromHealthMB
        );

        if (
          sampledWhileRunning &&
          visibleWorkingSetSamplesKB.length >= DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT &&
          visibleWorkingSetGrowthFromHealthMB < DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
        ) {
          console.log(
            JSON.stringify({
              type: 'desktop-dev-visible-growth-12k-bounded',
              fixture,
              lastQueueStats,
              lastBackfillState,
              baselineVisibleWorkingSetFromHealthMB:
                Math.round(baselineVisibleWorkingSetFromHealthMB * 10) / 10,
              peakVisibleWorkingSetMB: Math.round(peakVisibleWorkingSetMB * 10) / 10,
              visibleWorkingSetGrowthFromHealthMB:
                Math.round(visibleWorkingSetGrowthFromHealthMB * 10) / 10,
              mainProcessHealthSamples,
            })
          );
          return;
        }

        await activeWindow.waitForTimeout(1000);
      }

      const visibleWorkingSetSamplesKB = mainProcessHealthSamples
        .map((sample) => sample.visibleUiWorkingSetKB)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const baselineVisibleWorkingSetFromHealthMB =
        visibleWorkingSetSamplesKB.length > 0 ? visibleWorkingSetSamplesKB[0]! / 1024 : null;
      const peakVisibleWorkingSetMB =
        visibleWorkingSetSamplesKB.length > 0
          ? Math.max(...visibleWorkingSetSamplesKB) / 1024
          : null;
      const visibleWorkingSetGrowthFromHealthMB =
        peakVisibleWorkingSetMB !== null && baselineVisibleWorkingSetFromHealthMB !== null
          ? growth(peakVisibleWorkingSetMB, baselineVisibleWorkingSetFromHealthMB)
          : null;

      throw new Error(
        'Desktop:dev 12k bounded-memory regression did not reach a stable active-backfill sample within 420s.\n' +
          `lastQueueStats=${JSON.stringify(lastQueueStats)}\n` +
          `lastBackfillState=${JSON.stringify(lastBackfillState)}\n` +
          `sampledWhileRunning=${JSON.stringify(sampledWhileRunning)}\n` +
          `healthSampleCount=${mainProcessHealthSamples.length}\n` +
          `baselineVisibleWorkingSetMB=${JSON.stringify(baselineVisibleWorkingSetFromHealthMB)}\n` +
          `peakVisibleWorkingSetMB=${JSON.stringify(peakVisibleWorkingSetMB)}\n` +
          `visibleWorkingSetGrowthFromHealthMB=${JSON.stringify(visibleWorkingSetGrowthFromHealthMB)}\n` +
          `mainProcessHealthSamples=${JSON.stringify(mainProcessHealthSamples)}`
      );
    } finally {
      restoreEnv();
      await closeElectronAppInTest(electronContext).catch(() => undefined);
    }
  });
});
