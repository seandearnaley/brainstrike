import type {
  ElectronApplication,
  LargeCollectionListFixture,
  Page,
} from './embedding-worker-renderer.shared';
import {
  createLargeCollectionListFixture,
  ERROR_LOCATOR,
  expect,
  forceRendererGarbageCollection,
  getDatabaseDemoImportSnapshot,
  growth,
  isDatabaseError,
  LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB,
  LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB,
  readRendererHeapSnapshot,
  reloadRendererInTest,
  showDatabaseDemoPanel,
  test,
  waitForTrackedRuntimeWorkingSetMB,
} from './embedding-worker-renderer.shared';

const LIVE_QUERY_MUTATION_COUNT = 100;
const LIVE_QUERY_MUTATION_PAYLOAD_BYTES = 8192;
const LIVE_QUERY_SWITCH_CYCLE_COUNT = 10;
const LIVE_QUERY_TEST_FILE_COUNT = 50;
const LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB = LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB;
const LIVE_QUERY_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB =
  LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB;

interface DatabaseMemoryTestSnapshot {
  activeCollectionId: string | null;
  activeLiveSubscriptions: number;
  cache: {
    cachedCollectionCountEntries: number;
    cachedChunkPageEntries: number;
    cachedRecordPageEntries: number;
    cachedRecordTotalEntries: number;
    loadedRecordPageEntries: number;
  };
  liveUpdateCount: number;
  recordIds: string[];
}

interface RemoteLiveQueryDiagnostics {
  hostLiveQueryCount: number;
  ipcLiveQueryCount: number;
  managerLiveQueryCount: number;
}

interface VisibleMemorySnapshot {
  heapUsedMB: number;
  label: string;
  workingSetMB: number;
}

async function getDatabaseMemoryTestSnapshot(page: Page): Promise<DatabaseMemoryTestSnapshot> {
  return await page.evaluate<DatabaseMemoryTestSnapshot>(() => {
    const hooks = (
      window as Window & {
        __brainstrikeDatabaseDemoTestHooks__?: {
          getMemorySnapshot?: () => DatabaseMemoryTestSnapshot;
        };
      }
    ).__brainstrikeDatabaseDemoTestHooks__;
    if (!hooks?.getMemorySnapshot) {
      throw new Error('Database memory test snapshot is unavailable in desktop test mode.');
    }
    return hooks.getMemorySnapshot();
  });
}

async function getRemoteLiveQueryDiagnostics(
  app: ElectronApplication
): Promise<RemoteLiveQueryDiagnostics> {
  return await app.evaluate<RemoteLiveQueryDiagnostics>(async () => {
    const diagnosticsKey = '__brainstrike_e2e_db_live_query_diagnostics__' as const;
    const diagnostics = (
      globalThis as typeof globalThis &
        Partial<
          Record<
            typeof diagnosticsKey,
            () => Promise<RemoteLiveQueryDiagnostics> | RemoteLiveQueryDiagnostics
          >
        >
    )[diagnosticsKey];
    if (!diagnostics) {
      throw new Error('Remote live-query diagnostics are unavailable outside desktop test mode.');
    }
    return await diagnostics();
  });
}

async function queryDatabase(page: Page, sql: string, params: unknown[] = []): Promise<void> {
  await page.evaluate<void, { params: unknown[]; sql: string }>(
    async ({ params: queryParams, sql: query }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database query API is unavailable in desktop test mode.');
      }
      await api.db.query(query, queryParams);
    },
    { params, sql }
  );
}

async function seedLiveQueryPayload(page: Page, collectionId: string): Promise<void> {
  const payload = 'm'.repeat(LIVE_QUERY_MUTATION_PAYLOAD_BYTES);
  await queryDatabase(
    page,
    `UPDATE file_records
     SET content_hash = $1 || id,
         updated_at = clock_timestamp()
     WHERE embedding_set_id = $2`,
    [payload, collectionId]
  );
}

async function selectMemoryCollection(page: Page, collectionId: string): Promise<void> {
  const option = page.locator(`#collection-option-${collectionId}`);
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click({ timeout: 5000 });
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(
      async () => {
        const snapshot = await getDatabaseMemoryTestSnapshot(page);
        return {
          activeCollectionId: snapshot.activeCollectionId,
          recordsBelongToCollection: snapshot.recordIds.every((id) =>
            id.startsWith(`${collectionId}-file-`)
          ),
          visibleRecordCount: snapshot.recordIds.length,
        };
      },
      { timeout: 30_000 }
    )
    .toEqual({
      activeCollectionId: collectionId,
      recordsBelongToCollection: true,
      visibleRecordCount: LIVE_QUERY_TEST_FILE_COUNT,
    });
}

async function readVisibleMemorySnapshot(
  app: ElectronApplication,
  page: Page,
  label: string
): Promise<VisibleMemorySnapshot> {
  await forceRendererGarbageCollection(page);
  await forceRendererGarbageCollection(page);
  const [heap, workingSetMB] = await Promise.all([
    readRendererHeapSnapshot(page, label),
    waitForTrackedRuntimeWorkingSetMB(app, page, 'visible-ui'),
  ]);
  return { heapUsedMB: heap.usedMB, label, workingSetMB };
}

async function expectRemoteLiveQueryCounts(
  app: ElectronApplication,
  expected: RemoteLiveQueryDiagnostics
): Promise<void> {
  await expect
    .poll(async () => await getRemoteLiveQueryDiagnostics(app), { timeout: 30_000 })
    .toEqual(expected);
}

test.describe('Database live-query memory', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-memory releases superseded live-query results across 100 committed mutations', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);
    if (await isDatabaseError(activeWindow)) {
      throw new Error(
        `Database initialization failed before the live-query memory regression: ${await activeWindow
          .locator(ERROR_LOCATOR)
          .first()
          .textContent()}`
      );
    }

    const fixture = await createLargeCollectionListFixture(activeWindow, {
      fileCount: LIVE_QUERY_TEST_FILE_COUNT,
      persistActiveSet: false,
    });
    await seedLiveQueryPayload(activeWindow, fixture.embeddingSetId);
    await reloadRendererInTest(activeWindow, 'database-live-query-mutation-memory');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await selectMemoryCollection(activeWindow, fixture.embeddingSetId);

    const baselineMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const baselineRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    const baselineMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'live-query-mutations-baseline'
    );
    const probeId = `${fixture.embeddingSetId}-mutation-probe`;
    const probePath = `/list/${fixture.embeddingSetId}/mutation-probe.ts`;
    const payload = 'p'.repeat(LIVE_QUERY_MUTATION_PAYLOAD_BYTES);
    let midpointMemory: VisibleMemorySnapshot | null = null;

    for (let mutation = 0; mutation < LIVE_QUERY_MUTATION_COUNT; mutation += 1) {
      const insertProbe = mutation % 2 === 0;
      if (insertProbe) {
        const now = new Date().toISOString();
        await queryDatabase(
          activeWindow,
          `INSERT INTO file_records (
             id, path, name, size, content, content_hash, embedding_set_id,
             created_at, updated_at, chunks_count, token_count
           )
           VALUES ($1, $2, $3, $4, '', $5, $6, $7, $7, 0, 0)`,
          [
            probeId,
            probePath,
            'mutation-probe.ts',
            LIVE_QUERY_MUTATION_PAYLOAD_BYTES,
            `${payload}${mutation}`,
            fixture.embeddingSetId,
            now,
          ]
        );
      } else {
        await queryDatabase(activeWindow, 'DELETE FROM file_records WHERE id = $1', [probeId]);
      }

      await expect
        .poll(
          async () => {
            const [importSnapshot, memorySnapshot] = await Promise.all([
              getDatabaseDemoImportSnapshot(activeWindow),
              getDatabaseMemoryTestSnapshot(activeWindow),
            ]);
            return {
              hasProbe: memorySnapshot.recordIds.includes(probeId),
              totalRecords: importSnapshot?.recordPagination.totalRecords ?? null,
            };
          },
          { timeout: 30_000 }
        )
        .toEqual({
          hasProbe: insertProbe,
          totalRecords: LIVE_QUERY_TEST_FILE_COUNT + (insertProbe ? 1 : 0),
        });

      if (mutation === LIVE_QUERY_MUTATION_COUNT / 2 - 1) {
        midpointMemory = await readVisibleMemorySnapshot(
          electronApp.app,
          activeWindow,
          'live-query-mutations-midpoint'
        );
      }
    }

    if (!midpointMemory) {
      throw new Error('Expected a visible-memory midpoint after 50 committed mutations.');
    }

    await expectRemoteLiveQueryCounts(electronApp.app, baselineRemoteDiagnostics);
    await expect
      .poll(
        async () => (await getDatabaseMemoryTestSnapshot(activeWindow)).activeLiveSubscriptions,
        { timeout: 30_000 }
      )
      .toBe(baselineMemoryDiagnostics.activeLiveSubscriptions);

    const finalMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const finalMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'live-query-mutations-final'
    );

    console.log(
      JSON.stringify({
        baselineMemory,
        baselineMemoryDiagnostics,
        baselineRemoteDiagnostics,
        finalMemory,
        finalMemoryDiagnostics,
        midpointMemory,
        mutationCount: LIVE_QUERY_MUTATION_COUNT,
        type: 'desktop-live-query-mutation-memory',
      })
    );

    expect(
      finalMemoryDiagnostics.liveUpdateCount - baselineMemoryDiagnostics.liveUpdateCount
    ).toBeGreaterThanOrEqual(LIVE_QUERY_MUTATION_COUNT);
    expect(finalMemoryDiagnostics.cache).toEqual(baselineMemoryDiagnostics.cache);
    expect(finalMemoryDiagnostics.recordIds).not.toContain(probeId);
    expect(growth(finalMemory.heapUsedMB, baselineMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.heapUsedMB, midpointMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, baselineMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, midpointMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
    );
  });

  test('@desktop-embedding-memory keeps live-query handles and collection caches bounded during rapid three-collection switching', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);
    if (await isDatabaseError(activeWindow)) {
      throw new Error(
        `Database initialization failed before the collection-switch memory regression: ${await activeWindow
          .locator(ERROR_LOCATOR)
          .first()
          .textContent()}`
      );
    }

    const fixtures: LargeCollectionListFixture[] = [];
    for (let collection = 0; collection < 3; collection += 1) {
      const fixture = await createLargeCollectionListFixture(activeWindow, {
        fileCount: LIVE_QUERY_TEST_FILE_COUNT,
        persistActiveSet: false,
      });
      await seedLiveQueryPayload(activeWindow, fixture.embeddingSetId);
      fixtures.push(fixture);
    }

    await reloadRendererInTest(activeWindow, 'database-three-collection-switch-memory');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    for (const fixture of fixtures) {
      await selectMemoryCollection(activeWindow, fixture.embeddingSetId);
    }

    const baselineMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const baselineRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    const baselineMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'collection-switch-baseline'
    );

    for (let cycle = 0; cycle < LIVE_QUERY_SWITCH_CYCLE_COUNT; cycle += 1) {
      for (const fixture of fixtures) {
        await selectMemoryCollection(activeWindow, fixture.embeddingSetId);
      }
    }

    await expectRemoteLiveQueryCounts(electronApp.app, baselineRemoteDiagnostics);
    await expect
      .poll(
        async () => (await getDatabaseMemoryTestSnapshot(activeWindow)).activeLiveSubscriptions,
        { timeout: 30_000 }
      )
      .toBe(baselineMemoryDiagnostics.activeLiveSubscriptions);

    const finalMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const finalMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'collection-switch-final'
    );
    const finalCollectionId = fixtures.at(-1)?.embeddingSetId;
    if (!finalCollectionId) {
      throw new Error('Expected three seeded collection fixtures.');
    }

    console.log(
      JSON.stringify({
        baselineMemory,
        baselineMemoryDiagnostics,
        baselineRemoteDiagnostics,
        cycleCount: LIVE_QUERY_SWITCH_CYCLE_COUNT,
        finalMemory,
        finalMemoryDiagnostics,
        type: 'desktop-three-collection-switch-memory',
      })
    );

    expect(finalMemoryDiagnostics.activeCollectionId).toBe(finalCollectionId);
    expect(finalMemoryDiagnostics.recordIds).toHaveLength(LIVE_QUERY_TEST_FILE_COUNT);
    expect(
      finalMemoryDiagnostics.recordIds.every((id) => id.startsWith(`${finalCollectionId}-file-`))
    ).toBe(true);
    // Inactive pages are intentionally retained for fast revisits. The memory
    // contract is that switching overwrites the same three keyed entries and
    // releases superseded result arrays/handles instead of growing per switch.
    expect(finalMemoryDiagnostics.cache).toEqual(baselineMemoryDiagnostics.cache);
    expect(growth(finalMemory.heapUsedMB, baselineMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, baselineMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
    );
  });
});
