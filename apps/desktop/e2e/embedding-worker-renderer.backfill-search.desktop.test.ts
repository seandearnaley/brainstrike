import {
  configureNativeCollectionSearch,
  createNativeImportedSearchFixture,
  readNativeCollectionDiagnostics,
  searchNativeCollection,
  waitForNativeCollectionCoverage,
} from './embedding-worker-renderer.native-search';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  ERROR_LOCATOR,
  clearEmbeddingQueue,
  createChunkedImportFixture,
  createImportTargetCollection,
  getEmbeddingHostStatus,
  getEmbeddingSetCounts,
  getEmbeddingSetQueueStats,
  getRendererTimeOrigin,
  getVisibleAlertTexts,
  isDatabaseError,
  openWorkspaceSearchPanel,
  reloadRendererInTest,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  waitForBackfillButtonEnabled,
  waitForBackfillQueueMovementOrFatalError,
  waitForEmbeddedCollectionSummary,
  waitForWorkspaceSemanticSearchResults,
  waitForImportedChunks,
} = shared;

test.describe('Embedding Host Renderer - backfill search', () => {
  test('@desktop-embedding-backfill backfills chunked imported data without hanging and updates collection coverage', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Desktop UI Import ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-import-backfill-flow');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const timeOriginBeforeBackfill = await getRendererTimeOrigin(activeWindow);

    await waitForImportedChunks(activeWindow, embeddingSetId);
    const countsBeforeBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);

    expect(countsBeforeBackfill.fileCount).toBe(chunkedFixture.fileCount);
    expect(countsBeforeBackfill.totalChunks).toBe(chunkedFixture.totalChunks);
    expect(countsBeforeBackfill.embeddedChunks).toBe(0);

    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      return;
    }

    const setQueueStats = await getEmbeddingSetQueueStats(activeWindow, embeddingSetId);
    expect(
      setQueueStats.queued + setQueueStats.running + setQueueStats.failed + setQueueStats.succeeded
    ).toBeGreaterThan(0);

    await waitForEmbeddedCollectionSummary(activeWindow, collectionName);

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 90_000,
      })
      .toMatchObject({
        embeddedChunks: expect.any(Number),
        fileCount: chunkedFixture.fileCount,
        totalChunks: expect.any(Number),
      });

    const countsAfterBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);
    expect(countsAfterBackfill.totalChunks).toBeGreaterThan(0);
    expect(countsAfterBackfill.embeddedChunks).toBe(countsAfterBackfill.totalChunks);

    const timeOriginAfterBackfill = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterBackfill).toBe(timeOriginBeforeBackfill);
    await expect(backfillButton).toContainText('Backfill', { timeout: 15_000 });

    // Exercise the shipped drawer and its real semantic executor against the
    // fixture embedded above. This is intentionally not another SQL assertion.
    const drawerToggle = databasePanel.getByRole('button', { name: /collection details/i });
    await drawerToggle.click({ timeout: 5000 });
    const drawerContent = databasePanel.getByTestId('collection-debug-drawer-content');
    await expect(drawerContent).toBeVisible({ timeout: 15_000 });

    const drawerQuery = 'desktop chunking backfill';
    await expect(drawerContent.getByTestId('collection-debug-retrieval-refusal')).toHaveCount(0);
    await drawerContent.getByLabel('Retrieval preview query').fill(drawerQuery);
    await drawerContent.getByRole('button', { name: /^Run$/ }).click({ timeout: 5000 });

    const drawerResults = drawerContent.getByTestId('collection-debug-retrieval-results');
    const drawerError = drawerContent.getByTestId('collection-debug-retrieval-error');
    await expect
      .poll(async () => (await drawerResults.count()) + (await drawerError.count()), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);
    if ((await drawerError.count()) > 0) {
      throw new Error(`Drawer retrieval failed: ${await drawerError.innerText()}`);
    }
    await expect(drawerResults).toContainText(/desktop chunking|manual backfill/i);
  });

  test('@desktop-embedding-search end-to-end: import, embed, then vector search returns correct results', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(300_000);
    const activeWindow = await showDatabaseDemoPanel(window);
    const collectionName = `Search E2E ${Date.now()}`;
    const fixture = await createNativeImportedSearchFixture(activeWindow, collectionName);
    expect(fixture.fileCount).toBe(2);
    const before = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
    expect(before.embeddedChunks).toBe(0);

    await configureNativeCollectionSearch(activeWindow, collectionName);
    const observation = await waitForNativeCollectionCoverage(
      activeWindow,
      fixture.embeddingSetId,
      fixture.fileCount
    );
    const coverage = observation.coverage[0]!;
    expect(coverage.totals.chunks).toBeGreaterThan(0);
    expect(coverage.totals.vectors).toBe(coverage.totals.chunks);
    expect(coverage.totals.indexedFiles).toBe(fixture.fileCount);
    expect(coverage.totals.missingVectors).toBe(0);

    // Native SQLite is the vector and lexical owner; PG retains the source catalog.
    const diagnostics = await readNativeCollectionDiagnostics(
      electronApp.app,
      fixture.embeddingSetId
    );
    expect(diagnostics.embeddedCount).toBe(coverage.totals.chunks);
    expect(diagnostics.dimensions.length).toBeGreaterThan(0);
    const dimensions = [...new Set(diagnostics.dimensions)];
    expect(dimensions).toHaveLength(1);
    expect(dimensions[0]).toBeGreaterThan(0);
    expect(diagnostics.embeddingSetIds).toContain(fixture.embeddingSetId);
    expect(diagnostics.withContent).toBe(diagnostics.totalChunks);
    expect(diagnostics.withFts).toBe(diagnostics.totalChunks);
    expect(diagnostics.ftsEnabled).toBe(1);
    const lexical = await searchNativeCollection(activeWindow, fixture.embeddingSetId);
    expect(lexical.hits.length).toBeGreaterThan(0);
    expect(lexical.hits[0]?.content).toMatch(/backfill/i);

    // The actual stored vector must retrieve its own chunk at cosine similarity ~1.
    const selfSearch = await searchNativeCollection(
      activeWindow,
      fixture.embeddingSetId,
      diagnostics.vector
    );
    expect(selfSearch.hits.length).toBeGreaterThan(0);
    expect(selfSearch.hits[0]?.chunkId).toBe(diagnostics.selfChunkId);
    expect(1 - selfSearch.hits[0]!.score).toBeGreaterThan(0.95);

    // Rootless imported files keep their identity and are searched through their collection scope.
    const searchPanel = await openWorkspaceSearchPanel(activeWindow);
    await selectWorkspaceSearchCollection(searchPanel, collectionName);
    await runWorkspaceSemanticSearch(searchPanel, 'desktop chunking backfill');
    const searchSnapshot = await waitForWorkspaceSemanticSearchResults(searchPanel, {
      context: async () =>
        `nativeCoverage=${JSON.stringify(coverage)}\nalerts=${JSON.stringify(await getVisibleAlertTexts(activeWindow))}`,
    });
    expect(searchSnapshot.resultFileCount).toBeGreaterThan(0);
    expect(searchSnapshot.emptyState).toBe(false);
    expect(searchSnapshot.firstResultLabel).not.toBeNull();
  });

  test('@desktop-embedding-search search works when vector-preferences store has no devicePref (stale migration)', async ({
    window,
  }) => {
    test.setTimeout(300_000);
    let activeWindow = await showDatabaseDemoPanel(window);
    const collectionName = `Stale Prefs Search ${Date.now()}`;
    const fixture = await createNativeImportedSearchFixture(activeWindow, collectionName);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await configureNativeCollectionSearch(activeWindow, collectionName);
    const initial = await waitForNativeCollectionCoverage(
      activeWindow,
      fixture.embeddingSetId,
      fixture.fileCount
    );
    expect(initial.coverage[0]!.totals.vectors).toBe(initial.coverage[0]!.totals.chunks);

    // This is the historical version-1 record that crashed migration and query startup.
    await activeWindow.evaluate(async () => {
      const storage = globalThis.window.electronAPI?.storage;
      if (!storage) {
        throw new Error('Electron storage bridge is not available');
      }
      await storage.setItem(
        'vector-preferences.v1',
        JSON.stringify({
          state: { reinitEveryN: 200, verboseOrtLogs: false },
          version: 1,
        })
      );
    });
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-migration');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    expect(await getRendererTimeOrigin(activeWindow)).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          await activeWindow.evaluate(async () => {
            const saved =
              await globalThis.window.electronAPI?.storage.getItem('vector-preferences.v1');
            return saved ? JSON.parse(saved) : null;
          })
      )
      .toMatchObject({ state: { devicePref: 'webgpu', devicePrefConfigured: false }, version: 3 });

    // The explicit native WASM plan survives independently of the migrated legacy device choice.
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-search');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await waitForNativeCollectionCoverage(activeWindow, fixture.embeddingSetId, fixture.fileCount);
    const searchPanel = await openWorkspaceSearchPanel(activeWindow);
    await selectWorkspaceSearchCollection(searchPanel, collectionName);
    const timeOriginBeforeSearch = await getRendererTimeOrigin(activeWindow);
    await runWorkspaceSemanticSearch(searchPanel, 'desktop chunking backfill');
    await activeWindow.waitForTimeout(3000);
    expect(await getRendererTimeOrigin(activeWindow)).toBe(timeOriginBeforeSearch);
    const searchSnapshot = await waitForWorkspaceSemanticSearchResults(searchPanel, {
      context: async () =>
        `stale vector-preferences store\nalerts=${JSON.stringify(await getVisibleAlertTexts(activeWindow))}`,
    });
    expect(searchSnapshot.resultFileCount).toBeGreaterThan(0);
    expect(searchSnapshot.emptyState).toBe(false);
  });
});
