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
  readRendererHeapSnapshot,
  reloadRendererInTest,
  showDatabaseDemoPanel,
  test,
  waitForTrackedRuntimeWorkingSetMB,
} from './embedding-worker-renderer.shared';

// Routine coverage exercises replacement, midpoint collection, and later
// collection with more generations than the retained-array bound. The longer
// drift observation remains in the explicit stress command.
const stress = process.env['BRAINSTRIKE_TEST_STRESS'] === '1';
const LIVE_QUERY_MUTATION_COUNT = stress ? 100 : 12;
const LIVE_QUERY_MUTATION_PAYLOAD_BYTES = 8192;
const LIVE_QUERY_SWITCH_CYCLE_COUNT = stress ? 10 : 3;
const LIVE_QUERY_TEST_FILE_COUNT = 50;
const LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB = 16;
const LIVE_QUERY_MUTATION_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB = 32;
const LIVE_QUERY_SWITCH_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB = 48;
// Selecting a collection enables the three DatabaseDemo data queries plus the
// active-set queue-count and coverage queries owned by useEmbeddingControls.
const ACTIVE_COLLECTION_LIVE_QUERY_DELTA = 5;

interface RecordArrayRetentionSnapshot {
  aliveGenerations: number[];
  collectedGenerationCount: number;
  currentGeneration: number | null;
  droppedGenerationCount: number;
  trackedGenerationCount: number;
}

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
  recordArrayRetention: RecordArrayRetentionSnapshot;
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

const EMPTY_DATABASE_DEMO_CACHE = {
  cachedChunkPageEntries: 0,
  cachedCollectionCountEntries: 0,
  cachedRecordPageEntries: 0,
  cachedRecordTotalEntries: 0,
  loadedRecordPageEntries: 0,
} as const;

function expectedDatabaseDemoCache(collectionCount: number): DatabaseMemoryTestSnapshot['cache'] {
  return {
    cachedChunkPageEntries: collectionCount,
    cachedCollectionCountEntries: collectionCount,
    cachedRecordPageEntries: collectionCount,
    cachedRecordTotalEntries: collectionCount,
    loadedRecordPageEntries: collectionCount,
  };
}

function requireCurrentRecordArrayGeneration(
  snapshot: DatabaseMemoryTestSnapshot,
  context: string
): number {
  const generation = snapshot.recordArrayRetention.currentGeneration;
  if (generation === null) {
    throw new Error(`Expected a current record-array generation after ${context}.`);
  }
  return generation;
}

function addActiveCollectionLiveQueryOwnership(
  preWarmRemote: RemoteLiveQueryDiagnostics,
  preWarmRendererCount: number
): RemoteLiveQueryDiagnostics & { readonly rendererLiveQueryCount: number } {
  return {
    hostLiveQueryCount: preWarmRemote.hostLiveQueryCount + ACTIVE_COLLECTION_LIVE_QUERY_DELTA,
    ipcLiveQueryCount: preWarmRemote.ipcLiveQueryCount + ACTIVE_COLLECTION_LIVE_QUERY_DELTA,
    managerLiveQueryCount: preWarmRemote.managerLiveQueryCount + ACTIVE_COLLECTION_LIVE_QUERY_DELTA,
    rendererLiveQueryCount: preWarmRendererCount + ACTIVE_COLLECTION_LIVE_QUERY_DELTA,
  };
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

async function selectMemoryCollection(
  page: Page,
  collectionId: string
): Promise<DatabaseMemoryTestSnapshot> {
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
  return await getDatabaseMemoryTestSnapshot(page);
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

async function expectLiveQueryOwnership(
  app: ElectronApplication,
  page: Page,
  expected: RemoteLiveQueryDiagnostics & { readonly rendererLiveQueryCount: number }
): Promise<void> {
  await expect
    .poll(
      async () => {
        const [remote, renderer] = await Promise.all([
          getRemoteLiveQueryDiagnostics(app),
          getDatabaseMemoryTestSnapshot(page),
        ]);
        return {
          ...remote,
          rendererLiveQueryCount: renderer.activeLiveSubscriptions,
        };
      },
      { timeout: 30_000 }
    )
    .toEqual(expected);
}

async function mutateCollectionProbe(
  page: Page,
  collectionId: string,
  operation: 'delete' | 'insert'
): Promise<string> {
  const probeId = `${collectionId}-current-live-probe`;
  if (operation === 'delete') {
    await queryDatabase(page, 'DELETE FROM file_records WHERE id = $1', [probeId]);
    return probeId;
  }

  const now = new Date().toISOString();
  await queryDatabase(
    page,
    `INSERT INTO file_records (
       id, path, name, size, content, content_hash, embedding_set_id,
       created_at, updated_at, chunks_count, token_count
     )
     VALUES ($1, $2, $3, $4, '', $5, $6, $7, $7, 0, 0)`,
    [
      probeId,
      `/list/${collectionId}/current-live-probe.ts`,
      'current-live-probe.ts',
      LIVE_QUERY_MUTATION_PAYLOAD_BYTES,
      `current-live-${'q'.repeat(LIVE_QUERY_MUTATION_PAYLOAD_BYTES)}`,
      collectionId,
      now,
    ]
  );
  return probeId;
}

async function expectCurrentLiveProbeState(
  page: Page,
  args: {
    readonly minimumLiveUpdateCount: number;
    readonly present: boolean;
    readonly probeId: string;
  }
): Promise<void> {
  await expect
    .poll(
      async () => {
        const [importSnapshot, memorySnapshot] = await Promise.all([
          getDatabaseDemoImportSnapshot(page),
          getDatabaseMemoryTestSnapshot(page),
        ]);
        return {
          liveUpdateCountReached: memorySnapshot.liveUpdateCount >= args.minimumLiveUpdateCount,
          probePresent: memorySnapshot.recordIds.includes(args.probeId),
          totalRecords: importSnapshot?.recordPagination.totalRecords ?? null,
        };
      },
      { timeout: 30_000 }
    )
    .toEqual({
      liveUpdateCountReached: true,
      probePresent: args.present,
      totalRecords: LIVE_QUERY_TEST_FILE_COUNT + (args.present ? 1 : 0),
    });
}

test.describe('Database live-query memory', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-memory releases superseded live-query results across committed mutations', async ({
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
    const preWarmMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const preWarmRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    // Reload idempotence: the main process reaps an owner's live subscriptions
    // on 'did-navigate', so a second reload + panel mount must reproduce every
    // main-side ownership count exactly — reloads may not accrete orphans. The
    // renderer count gates the sample so it cannot pass on the transient
    // window before the fresh page has re-registered its own subscriptions.
    await reloadRendererInTest(activeWindow, 'database-live-query-reload-reap-idempotence');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await expectLiveQueryOwnership(electronApp.app, activeWindow, {
      ...preWarmRemoteDiagnostics,
      rendererLiveQueryCount: preWarmMemoryDiagnostics.activeLiveSubscriptions,
    });
    // Re-read after the second reload so every assertion below describes the
    // realm the rest of the test actually runs in, not the reloaded-away one.
    const postReloadMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const expectedActiveOwnership = addActiveCollectionLiveQueryOwnership(
      preWarmRemoteDiagnostics,
      postReloadMemoryDiagnostics.activeLiveSubscriptions
    );
    expect(postReloadMemoryDiagnostics).toMatchObject({
      activeCollectionId: null,
      cache: EMPTY_DATABASE_DEMO_CACHE,
      recordArrayRetention: {
        aliveGenerations: [],
        currentGeneration: null,
        droppedGenerationCount: 0,
        trackedGenerationCount: 0,
      },
      recordIds: [],
    });
    await selectMemoryCollection(activeWindow, fixture.embeddingSetId);
    await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);

    const baselineMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'live-query-mutations-baseline'
    );
    const baselineMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const baselineRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    const baselineRecordArrayGeneration = requireCurrentRecordArrayGeneration(
      baselineMemoryDiagnostics,
      'the mutation baseline'
    );
    expect(baselineMemoryDiagnostics.cache).toEqual(expectedDatabaseDemoCache(1));
    expect(baselineMemoryDiagnostics.recordArrayRetention).toMatchObject({
      aliveGenerations: expect.arrayContaining([baselineRecordArrayGeneration]),
      droppedGenerationCount: 0,
    });
    const probeId = `${fixture.embeddingSetId}-mutation-probe`;
    const probePath = `/list/${fixture.embeddingSetId}/mutation-probe.ts`;
    const payload = 'p'.repeat(LIVE_QUERY_MUTATION_PAYLOAD_BYTES);
    let midpointMemory: VisibleMemorySnapshot | null = null;
    let midpointRecordArrayGeneration: number | null = null;

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
        const midpointDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
        midpointRecordArrayGeneration = requireCurrentRecordArrayGeneration(
          midpointDiagnostics,
          'the mutation midpoint'
        );
        expect(midpointDiagnostics.recordArrayRetention.aliveGenerations).not.toContain(
          baselineRecordArrayGeneration
        );
      }
    }

    if (!(midpointMemory && midpointRecordArrayGeneration !== null)) {
      throw new Error('Expected a visible-memory midpoint after half the committed mutations.');
    }

    await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);
    const finalMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'live-query-mutations-final'
    );
    const finalMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);

    console.log(
      JSON.stringify({
        baselineMemory,
        baselineMemoryDiagnostics,
        baselineRemoteDiagnostics,
        finalMemory,
        finalMemoryDiagnostics,
        midpointMemory,
        mutationCount: LIVE_QUERY_MUTATION_COUNT,
        postReloadMemoryDiagnostics,
        preWarmMemoryDiagnostics,
        preWarmRemoteDiagnostics,
        type: 'desktop-live-query-mutation-memory',
      })
    );

    expect(finalMemoryDiagnostics.cache).toEqual(baselineMemoryDiagnostics.cache);
    expect(finalMemoryDiagnostics.recordIds).not.toContain(probeId);
    expect(finalMemoryDiagnostics.recordArrayRetention.droppedGenerationCount).toBe(0);
    expect(
      finalMemoryDiagnostics.recordArrayRetention.trackedGenerationCount
    ).toBeGreaterThanOrEqual(LIVE_QUERY_MUTATION_COUNT + 1);
    expect(
      finalMemoryDiagnostics.recordArrayRetention.collectedGenerationCount
    ).toBeGreaterThanOrEqual(LIVE_QUERY_MUTATION_COUNT - 3);
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations).not.toContain(
      baselineRecordArrayGeneration
    );
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations).not.toContain(
      midpointRecordArrayGeneration
    );
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations).toContain(
      requireCurrentRecordArrayGeneration(finalMemoryDiagnostics, 'the final committed mutation')
    );
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations.length).toBeLessThanOrEqual(
      4
    );
    expect(growth(finalMemory.heapUsedMB, baselineMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.heapUsedMB, midpointMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, baselineMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_MUTATION_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, midpointMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_MUTATION_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
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
    const preWarmMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const preWarmRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    const expectedActiveOwnership = addActiveCollectionLiveQueryOwnership(
      preWarmRemoteDiagnostics,
      preWarmMemoryDiagnostics.activeLiveSubscriptions
    );
    expect(preWarmMemoryDiagnostics).toMatchObject({
      activeCollectionId: null,
      cache: EMPTY_DATABASE_DEMO_CACHE,
      recordArrayRetention: {
        aliveGenerations: [],
        currentGeneration: null,
        droppedGenerationCount: 0,
        trackedGenerationCount: 0,
      },
      recordIds: [],
    });

    const warmRecordArrayGenerations: number[] = [];
    for (const fixture of fixtures) {
      const snapshot = await selectMemoryCollection(activeWindow, fixture.embeddingSetId);
      warmRecordArrayGenerations.push(
        requireCurrentRecordArrayGeneration(snapshot, `warming ${fixture.embeddingSetId}`)
      );
      await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);
    }
    expect(new Set(warmRecordArrayGenerations).size).toBe(fixtures.length);

    const baselineMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'collection-switch-baseline'
    );
    const baselineMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);
    const baselineRemoteDiagnostics = await getRemoteLiveQueryDiagnostics(electronApp.app);
    expect(baselineMemoryDiagnostics.cache).toEqual(expectedDatabaseDemoCache(fixtures.length));
    expect(baselineMemoryDiagnostics.activeLiveSubscriptions).toBe(
      expectedActiveOwnership.rendererLiveQueryCount
    );
    expect(baselineRemoteDiagnostics).toEqual({
      hostLiveQueryCount: expectedActiveOwnership.hostLiveQueryCount,
      ipcLiveQueryCount: expectedActiveOwnership.ipcLiveQueryCount,
      managerLiveQueryCount: expectedActiveOwnership.managerLiveQueryCount,
    });

    for (let cycle = 0; cycle < LIVE_QUERY_SWITCH_CYCLE_COUNT; cycle += 1) {
      for (const fixture of fixtures) {
        await selectMemoryCollection(activeWindow, fixture.embeddingSetId);
      }
      await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);
    }

    const finalCollectionId = fixtures.at(-1)?.embeddingSetId;
    if (!finalCollectionId) {
      throw new Error('Expected three seeded collection fixtures.');
    }
    const beforeCurrentLiveProof = await getDatabaseMemoryTestSnapshot(activeWindow);
    const probeId = await mutateCollectionProbe(activeWindow, finalCollectionId, 'insert');
    await expectCurrentLiveProbeState(activeWindow, {
      minimumLiveUpdateCount: beforeCurrentLiveProof.liveUpdateCount + 1,
      present: true,
      probeId,
    });
    await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);
    await mutateCollectionProbe(activeWindow, finalCollectionId, 'delete');
    await expectCurrentLiveProbeState(activeWindow, {
      minimumLiveUpdateCount: beforeCurrentLiveProof.liveUpdateCount + 2,
      present: false,
      probeId,
    });
    await expectLiveQueryOwnership(electronApp.app, activeWindow, expectedActiveOwnership);
    const finalMemory = await readVisibleMemorySnapshot(
      electronApp.app,
      activeWindow,
      'collection-switch-final'
    );
    const finalMemoryDiagnostics = await getDatabaseMemoryTestSnapshot(activeWindow);

    console.log(
      JSON.stringify({
        baselineMemory,
        baselineMemoryDiagnostics,
        baselineRemoteDiagnostics,
        cycleCount: LIVE_QUERY_SWITCH_CYCLE_COUNT,
        finalMemory,
        finalMemoryDiagnostics,
        preWarmMemoryDiagnostics,
        preWarmRemoteDiagnostics,
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
    expect(finalMemoryDiagnostics.cache).toEqual(expectedDatabaseDemoCache(fixtures.length));
    expect(finalMemoryDiagnostics.recordArrayRetention.droppedGenerationCount).toBe(0);
    expect(
      finalMemoryDiagnostics.recordArrayRetention.trackedGenerationCount
    ).toBeGreaterThanOrEqual(fixtures.length + LIVE_QUERY_SWITCH_CYCLE_COUNT * fixtures.length + 2);
    expect(
      finalMemoryDiagnostics.recordArrayRetention.collectedGenerationCount
    ).toBeGreaterThanOrEqual(LIVE_QUERY_SWITCH_CYCLE_COUNT * fixtures.length);
    for (const warmGeneration of warmRecordArrayGenerations) {
      expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations).not.toContain(
        warmGeneration
      );
    }
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations).toContain(
      requireCurrentRecordArrayGeneration(finalMemoryDiagnostics, 'the final live proof')
    );
    // CI-calibrated: the first ubuntu memory-baseline dispatch (run
    // 32274868755) held 7 recent generations alive at the final forced GC
    // (local runs hold 5) with 58/65 collected, zero drops, and every warm
    // generation removed — a slower runner keeps a couple more of the newest
    // arrays reachable, not a leak. One generation of headroom over the CI
    // worst; the bound stays constant while trackedGenerationCount grows with
    // cycle count, so unbounded retention still fails.
    expect(finalMemoryDiagnostics.recordArrayRetention.aliveGenerations.length).toBeLessThanOrEqual(
      8
    );
    expect(growth(finalMemory.heapUsedMB, baselineMemory.heapUsedMB)).toBeLessThan(
      LIVE_QUERY_VISIBLE_HEAP_DRIFT_LIMIT_MB
    );
    expect(growth(finalMemory.workingSetMB, baselineMemory.workingSetMB)).toBeLessThan(
      LIVE_QUERY_SWITCH_VISIBLE_WORKING_SET_DRIFT_LIMIT_MB
    );
  });
});
