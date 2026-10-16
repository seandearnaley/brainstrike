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
  getRendererTimeOrigin,
  getVisibleAlertTexts,
  openWorkspaceSearchPanel,
  reloadRendererInTest,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  waitForWorkspaceSemanticSearchResults,
} = shared;

test.describe('Embedding Host Renderer - search', () => {
  test('@desktop-embedding-search end-to-end: import, embed, then vector search returns correct results', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(300_000);
    const activeWindow = await showDatabaseDemoPanel(window);
    const collectionName = `Search E2E ${Date.now()}`;
    const fixture = await createNativeImportedSearchFixture(activeWindow, collectionName);
    expect(fixture.fileCount).toBe(2);
    // No "nothing embedded yet" pre-check: the native owner publishes no coverage
    // until a vector profile exists, so there is nothing to ask before the next
    // line configures one. The collection is created fresh under a unique name,
    // so it cannot carry vectors in; that embedding actually ran is proved by the
    // coverage and diagnostics assertions below (vectors === chunks, chunks > 0).

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
