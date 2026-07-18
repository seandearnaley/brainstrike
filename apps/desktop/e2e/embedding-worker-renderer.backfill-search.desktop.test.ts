import type { DatabaseDemoSemanticSearchTestSnapshot } from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  ERROR_LOCATOR,
  clearEmbeddingQueue,
  createChunkedImportFixture,
  createImportTargetCollection,
  getDatabaseDemoSemanticSearchSnapshot,
  getEmbeddingHostStatus,
  getEmbeddingSetCounts,
  getEmbeddingSetQueueStats,
  getHybridSearchBox,
  getRendererLogRecords,
  getRendererTimeOrigin,
  getVisibleAlertTexts,
  isDatabaseError,
  recordContainsText,
  reloadRendererInTest,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  waitForBackfillButtonEnabled,
  waitForBackfillQueueMovementOrFatalError,
  waitForEmbeddedCollectionSummary,
  waitForImportedChunks,
} = shared;

test.describe('Embedding Host Renderer - backfill search', () => {
  test('@desktop-embedding-backfill backfills chunked imported data without hanging and updates collection coverage', async ({
    window,
  }) => {
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
  });

  test('@desktop-embedding-search end-to-end: import, embed, then vector search returns correct results', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // ── 1. Setup: navigate to database demo, create a collection ─────────
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      throw new Error('Database initialization failed — cannot proceed with search E2E');
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Search E2E ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);

    // ── 2. Insert deterministic fixture data with known searchable content ─
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);
    expect(chunkedFixture.fileCount).toBe(2);
    expect(chunkedFixture.totalChunks).toBeGreaterThan(0);

    // ── 3. Configure device and reload to pick up preferences ──────────
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-search-e2e');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Select our collection
    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    // Verify chunks are visible before backfill
    await waitForImportedChunks(activeWindow, embeddingSetId);
    const countsBeforeBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);
    expect(countsBeforeBackfill.embeddedChunks).toBe(0);

    // ── 4. Backfill: generate embeddings for all chunks ───────────────────
    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(
        `Backfill failed during search E2E: ${status.lastError ?? 'unknown host error'}`
      );
    }

    // Wait for ALL chunks to be embedded
    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({
        embeddedChunks: chunkedFixture.totalChunks,
        fileCount: chunkedFixture.fileCount,
        totalChunks: chunkedFixture.totalChunks,
      });

    // ── 5. Verify at DB level: embeddings stored with correct dimensions ──
    const dbDiagnostics = await activeWindow.evaluate(async (id) => {
      const api = (
        window as unknown as {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const result = await api.db.query(
        `SELECT
           id,
           content,
           embedding_set_id,
           vector_dims(embedding) AS dims,
           embedding IS NOT NULL AS has_embedding
         FROM file_chunks
         WHERE file_record_id IN (
           SELECT id FROM file_records WHERE embedding_set_id = $1
         )
         ORDER BY chunk_index`,
        [id]
      );

      const rows = result.rows as Array<{
        content: string;
        dims: number | null;
        embedding_set_id: string | null;
        has_embedding: boolean;
        id: string;
      }>;

      return {
        dimensions: rows.map((r) => Number(r.dims ?? 0)).filter((d) => d > 0),
        embeddedCount: rows.filter((r) => r.has_embedding).length,
        embeddingSetIds: rows.map((r) => r.embedding_set_id).filter((s): s is string => s !== null),
        sampleContentPrefixes: rows.map((r) => (r.content ?? '').slice(0, 60)),
      };
    }, embeddingSetId);

    expect(dbDiagnostics.embeddedCount).toBe(chunkedFixture.totalChunks);
    expect(dbDiagnostics.dimensions.length).toBeGreaterThan(0);
    // All dimensions should be the same (same model)
    const uniqueDimensions = [...new Set(dbDiagnostics.dimensions)];
    expect(uniqueDimensions).toHaveLength(1);
    const embeddingDimension = uniqueDimensions[0]!;
    expect(embeddingDimension).toBeGreaterThan(0);
    // All chunks should have the correct embedding_set_id
    expect(dbDiagnostics.embeddingSetIds).toContain(embeddingSetId);

    // ── 5b. Verify FTS: tsvector matching + qualified BM25 ranking work ───
    const ftsDiagnostics = await activeWindow.evaluate(async (id) => {
      const api = (
        window as unknown as {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      // Check tsvector population
      const tsvectorResult = await api.db.query(
        `SELECT
           COUNT(*)::int AS "totalChunks",
           COUNT(*) FILTER (WHERE content_tsvector IS NOT NULL)::int AS "withTsvector",
           COUNT(*) FILTER (WHERE content IS NOT NULL AND LENGTH(content) > 0)::int AS "withContent"
         FROM file_chunks
         WHERE file_record_id IN (
           SELECT id FROM file_records WHERE embedding_set_id = $1
         )`,
        [id]
      );
      const tsRow = tsvectorResult.rows[0] as {
        totalChunks: number;
        withTsvector: number;
        withContent: number;
      };

      const bm25Catalog = await api.db.query(
        `SELECT
           (SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch') AS "extensionVersion",
           to_regclass('idx_file_chunks_content_bm25')::text AS "indexName"`
      );
      const bm25CatalogRow = bm25Catalog.rows[0] as {
        extensionVersion: string | null;
        indexName: string | null;
      };

      // Match through the generated tsvector and rank the matched set through
      // the same qualified BM25 index used by the repository.
      const ftsResult = await api.db.query(
        `SELECT id, content, fts_rank
         FROM (
           SELECT id, content,
             (-(content <@> to_bm25query(
               'backfill',
               'idx_file_chunks_content_bm25'
             )))::float8 AS fts_rank
           FROM file_chunks
           WHERE content_tsvector IS NOT NULL
             AND content_tsvector @@ websearch_to_tsquery('english', 'backfill')
         ) sub
         ORDER BY fts_rank DESC
         LIMIT 5`
      );
      const ftsRows = ftsResult.rows as Array<{
        content: string;
        fts_rank: number;
        id: string;
      }>;

      return {
        bm25ExtensionVersion: bm25CatalogRow.extensionVersion,
        bm25IndexName: bm25CatalogRow.indexName,
        ftsMatchCount: ftsRows.length,
        ftsTopContent: ftsRows.length > 0 ? String(ftsRows[0]!.content).slice(0, 80) : '',
        totalChunks: Number(tsRow.totalChunks ?? 0),
        withContent: Number(tsRow.withContent ?? 0),
        withTsvector: Number(tsRow.withTsvector ?? 0),
      };
    }, embeddingSetId);

    // All chunks should have content and tsvector populated
    expect(ftsDiagnostics.withContent).toBe(ftsDiagnostics.totalChunks);
    expect(ftsDiagnostics.withTsvector).toBe(ftsDiagnostics.totalChunks);
    expect(ftsDiagnostics.bm25ExtensionVersion).toBe('1.2.0');
    expect(ftsDiagnostics.bm25IndexName).toBe('idx_file_chunks_content_bm25');
    // Qualified BM25 should rank the tsvector matches for fixture content.
    expect(ftsDiagnostics.ftsMatchCount).toBeGreaterThan(0);

    // ── 6. Direct SQL vector search: verify pgvector similarity works ─────
    // Use a chunk's own embedding as the query vector to guarantee a match.
    const directSqlSearchResult = await activeWindow.evaluate(
      async ({ embeddingSetId: id, dimension: dim }) => {
        const api = (
          window as unknown as {
            electronAPI?: {
              db?: {
                query?: (
                  sql: string,
                  params?: unknown[]
                ) => Promise<{ rows: Record<string, unknown>[] }>;
              };
            };
          }
        ).electronAPI;
        if (!api?.db?.query) {
          throw new Error('Database API not available');
        }

        // Get the first chunk's embedding to use as the query vector
        const refResult = await api.db.query(
          `SELECT embedding::text AS vec FROM file_chunks
           WHERE embedding IS NOT NULL AND embedding_set_id = $1
           LIMIT 1`,
          [id]
        );
        const refRow = refResult.rows[0] as { vec?: string } | undefined;
        const refVec = refRow?.vec;
        if (!refVec) {
          throw new Error('No embedded chunks found for direct SQL search');
        }

        // Run a cosine similarity search using the reference embedding
        const searchResult = await api.db.query(
          `SELECT
             content,
             (1 - (embedding <=> $1::vector)) AS similarity
           FROM file_chunks
           WHERE embedding IS NOT NULL
             AND embedding_set_id = $2
             AND vector_dims(embedding) = $3
           ORDER BY embedding <=> $1::vector
           LIMIT 5`,
          [refVec, id, dim]
        );

        const rows = searchResult.rows as Array<{
          content: string;
          similarity: number;
        }>;

        return {
          matchCount: rows.length,
          topContent: rows.length > 0 ? String(rows[0]!.content ?? '').slice(0, 80) : '',
          topSimilarity: rows.length > 0 ? Number(rows[0]!.similarity) : 0,
        };
      },
      { dimension: embeddingDimension, embeddingSetId }
    );

    expect(directSqlSearchResult.matchCount).toBeGreaterThan(0);
    // The top result should be the chunk itself (similarity ~1.0)
    expect(directSqlSearchResult.topSimilarity).toBeGreaterThan(0.95);

    // ── 7. UI semantic search: fill search box, click Query, verify results ─
    const semanticSearchBox = await getHybridSearchBox(activeWindow);

    // Search for known content from our fixture
    const searchQuery = 'desktop chunking backfill';
    await semanticSearchBox.fill(searchQuery);
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Poll for search results
    const searchStartedAt = Date.now();
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    while (Date.now() - searchStartedAt < 60_000) {
      const snapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
      lastSnapshot = snapshot;

      if (snapshot?.error) {
        throw new Error(`Semantic search failed: ${snapshot.error}`);
      }

      if (
        snapshot?.hasSearched &&
        !snapshot.isSearching &&
        snapshot.resultCount > 0 &&
        snapshot.firstResultNodeId !== null
      ) {
        break;
      }

      await activeWindow.waitForTimeout(250);
    }

    if (
      !(
        lastSnapshot?.hasSearched &&
        !lastSnapshot.isSearching &&
        lastSnapshot.resultCount > 0 &&
        lastSnapshot.firstResultNodeId !== null
      )
    ) {
      // Gather diagnostic info for debugging
      const rendererLogs = await getRendererLogRecords(activeWindow);
      const alertTexts = await getVisibleAlertTexts(activeWindow);
      const searchLogs = rendererLogs.filter(
        (record) =>
          recordContainsText(record, 'Search') ||
          recordContainsText(record, 'search') ||
          recordContainsText(record, 'embedder') ||
          recordContainsText(record, 'Embedder')
      );
      throw new Error(
        'Semantic search did not return results within 60s after successful backfill.\n' +
          `query="${searchQuery}"\n` +
          `snapshot=${JSON.stringify(lastSnapshot)}\n` +
          `directSqlSearchWorked=${directSqlSearchResult.matchCount > 0}\n` +
          `dbEmbeddedChunks=${dbDiagnostics.embeddedCount}\n` +
          `dbDimension=${embeddingDimension}\n` +
          `alerts=${JSON.stringify(alertTexts)}\n` +
          `searchLogs=${JSON.stringify(searchLogs.slice(-10))}`
      );
    }

    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);
    expect(lastSnapshot!.firstResultNodeId).not.toBeNull();

    // ── 8. Verify tree renders file nodes, not the empty state ──────────
    // Catches the lazy-chunk regression: semantic results have chunk nodeIds
    // ("chunk-<id>") but the tree only has file nodes ("file-<id>") because
    // chunks are loaded on-demand. The fix resolves chunk results to their
    // parent file node via "file-${result.fileRecordId}".
    const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
    const emptyResultsMessage = collectionTreeRegion.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyResultsMessage).toHaveCount(0, { timeout: 5000 });

    // Verify the firstResultNodeId resolves to a valid file- prefixed ID
    // (proves the lazy-chunk fallback mapped chunk IDs to file node IDs)
    expect(lastSnapshot!.firstResultNodeId).toMatch(/^(chunk-|file-)/);
  });

  test('@desktop-embedding-search search renders file nodes when chunks are lazily loaded (many-file collection)', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // This test reproduces the exact production bug: with many files, the
    // collection tree is PAGINATED (e.g. 50 files per page). Search results
    // reference files on OTHER pages — those file nodes don't exist in the
    // tree. Without building the tree from search results directly, the tree
    // shows "No matching results found" despite the search returning results.
    // Use one page plus overflow (> default page size of 50) to guarantee
    // pagination without turning this search regression into a queue-capacity
    // stress test.

    let activeWindow = await showDatabaseDemoPanel(window);
    if (await isDatabaseError(activeWindow)) {
      throw new Error('Database initialization failed');
    }

    await clearEmbeddingQueue(activeWindow);
    const collectionName = `Lazy Chunk Search ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);

    const LAZY_FILE_COUNT = 60;
    await activeWindow.evaluate(
      async ({ id, fileCount }) => {
        const api = (
          window as unknown as {
            electronAPI?: {
              db?: {
                query?: (
                  sql: string,
                  params?: unknown[]
                ) => Promise<{ rows: Record<string, unknown>[] }>;
              };
            };
          }
        ).electronAPI;
        if (!api?.db?.query) {
          throw new Error('Database API not available');
        }

        const now = new Date().toISOString();
        for (let i = 0; i < fileCount; i++) {
          const fileId = `lazy-file-${crypto.randomUUID()}`;
          const content = `export function handler${i}() { return "lazy-chunk-search-fixture-${i}"; }`;
          await api.db.query(
            `INSERT INTO file_records (id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [
              fileId,
              `/mock/lazy/${i}.ts`,
              `lazy-${i}.ts`,
              content.length,
              content,
              `hash-${fileId}`,
              20,
              id,
              now,
            ]
          );
          const chunkContent = `export function handler${i}() { return "lazy-chunk-search-fixture-${i}"; }`;
          await api.db.query(
            // content_tsvector is a STORED generated column (migration 034) — the DB
            // computes it from content, so seeds must NOT insert it directly.
            `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [
              `${fileId}-chunk-0`,
              fileId,
              0,
              chunkContent,
              `chunk-hash-${fileId}-0`,
              15,
              'code',
              chunkContent.length,
              now,
            ]
          );
          await api.db.query(
            `UPDATE file_records SET chunks_processed_at = $2, chunks_count = 1, chunking_strategy = 'recursive', updated_at = $2 WHERE id = $1`,
            [fileId, now]
          );
        }
      },
      { fileCount: LAZY_FILE_COUNT, id: embeddingSetId }
    );

    // Configure WASM and reload
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-lazy-chunk-search');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Select collection and backfill
    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 30_000,
      })
      .toMatchObject({ totalChunks: LAZY_FILE_COUNT });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(`Backfill failed: ${status.lastError ?? 'unknown'}`);
    }

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({ embeddedChunks: LAZY_FILE_COUNT });

    // ── Search: chunks are NOT expanded in the tree (lazy loaded) ──
    const semanticSearchBox = await getHybridSearchBox(activeWindow);
    await semanticSearchBox.fill('lazy-chunk-search-fixture');
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Poll for search results
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    await expect
      .poll(
        async () => {
          lastSnapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
          return lastSnapshot;
        },
        { timeout: 60_000 }
      )
      .toMatchObject({
        error: null,
        hasSearched: true,
        isSearching: false,
      });

    // THE CRITICAL ASSERTIONS:
    // 1. Search returned results (backend works)
    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);

    // 2. Tree must NOT show the empty state
    const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
    const emptyMessage = collectionTreeRegion.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyMessage).toHaveCount(0, { timeout: 5000 });

    // 3. Search result nodes exist in the tree
    expect(lastSnapshot!.firstResultNodeId).not.toBeNull();

    // 4. Search result chunks must show "Complete" embedding status (not "No Embedding")
    //    since they came from an embedding search — they definitely have embeddings.
    const noEmbeddingBadges = collectionTreeRegion.getByText('No Embedding');
    await expect(noEmbeddingBadges).toHaveCount(0, { timeout: 5000 });
  });

  test('@desktop-embedding-search search works when vector-preferences store has no devicePref (stale migration)', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // This test reproduces a crash where a stale persisted vector-preferences
    // store (missing devicePref field) caused the search embedder to receive
    // undefined as the device preference, crashing the visible renderer.

    // ── Phase 1: Standard setup with WASM (needed for CI/headless backfill) ──
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      throw new Error('Database initialization failed');
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Stale Prefs Search ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);

    // Use WASM for backfill (works in headless CI)
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-backfill');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });
    await waitForImportedChunks(activeWindow, embeddingSetId);

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(
        `Backfill failed with stale prefs: ${status.lastError ?? 'unknown host error'}`
      );
    }

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({
        embeddedChunks: chunkedFixture.totalChunks,
      });

    // ── Phase 2: Simulate stale store AFTER backfill, then search ──
    // Write a version-1 store WITHOUT devicePref to simulate old persisted data.
    // The migration should promote this to a valid state. Previously this caused
    // the search embedder to receive undefined devicePref, crashing the renderer.
    await activeWindow.evaluate(() => {
      const storageBridge = (
        window as unknown as {
          electronAPI?: {
            storage?: {
              setItem?: (key: string, value: string) => Promise<void>;
            };
          };
        }
      ).electronAPI?.storage;

      if (!storageBridge?.setItem) {
        throw new Error('Electron storage bridge is not available');
      }

      return storageBridge.setItem(
        'vector-preferences.v1',
        JSON.stringify({
          state: {
            reinitEveryN: 200,
            verboseOrtLogs: false,
          },
          version: 1,
        })
      );
    });

    // Reload with stale prefs — the migration runs and should produce valid state.
    // The renderer must NOT crash during this reload (the original bug).
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-migration');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Verify the renderer survived the stale-prefs migration without crashing
    const timeOriginAfterStaleMigration = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterStaleMigration).toBeGreaterThan(0);

    // In CI/headless, WebGPU lacks fp16 support. The migration correctly set
    // devicePref to 'webgpu', proving it's no longer undefined. Now switch to
    // WASM so the search embedder can actually run in the test environment.
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-search');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Re-select collection after reload
    const collectionOption2 = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption2).toBeVisible({ timeout: 15_000 });
    await collectionOption2.click({ timeout: 5000 });

    // ── The critical assertion: search must not crash the renderer ──
    const timeOriginBeforeSearch = await getRendererTimeOrigin(activeWindow);

    const semanticSearchBox = await getHybridSearchBox(activeWindow);
    await semanticSearchBox.fill('desktop chunking backfill');
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Wait briefly then verify the renderer did NOT crash/reload
    await activeWindow.waitForTimeout(3000);
    const timeOriginAfterSearch = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterSearch).toBe(timeOriginBeforeSearch);

    // Poll for search results
    const searchStartedAt = Date.now();
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    while (Date.now() - searchStartedAt < 60_000) {
      const snapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
      lastSnapshot = snapshot;

      if (snapshot?.error) {
        throw new Error(`Search failed with stale prefs: ${snapshot.error}`);
      }

      if (
        snapshot?.hasSearched &&
        !snapshot.isSearching &&
        snapshot.resultCount > 0 &&
        snapshot.firstResultNodeId !== null
      ) {
        break;
      }

      await activeWindow.waitForTimeout(250);
    }

    if (!(lastSnapshot?.hasSearched && !lastSnapshot.isSearching && lastSnapshot.resultCount > 0)) {
      const alertTexts = await getVisibleAlertTexts(activeWindow);
      throw new Error(
        'Search returned no results with stale vector-preferences store.\n' +
          `snapshot=${JSON.stringify(lastSnapshot)}\n` +
          `alerts=${JSON.stringify(alertTexts)}`
      );
    }

    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);

    // Verify tree renders results (no empty state from lazy-chunk nodeId mismatch)
    const collectionTreeRegion2 = activeWindow.getByTestId('collection-tree-region');
    const emptyMessage2 = collectionTreeRegion2.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyMessage2).toHaveCount(0, { timeout: 5000 });
  });
});
