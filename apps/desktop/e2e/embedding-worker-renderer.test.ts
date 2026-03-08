import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { reloadRenderer, waitForAppReady } from './utils/electron-helpers';
import { showDatabaseDemoPanel } from './utils/layout-helpers';

interface BufferedLogRecord {
  args: readonly unknown[];
  message?: string;
}

interface EmbeddingHostStatus {
  active: boolean;
  lastError: string | null;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface QueueStatsRow {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

interface EmbeddingSetCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

interface EmbeddingSetCountsRow {
  embeddedChunks: number | string | null;
  fileCount: number | string | null;
  totalChunks: number | string | null;
}

test.describe('Embedding Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  const ERROR_LOCATOR = '[data-testid="db-init-error"]';

  async function isDatabaseError(page: Page): Promise<boolean> {
    try {
      return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  async function assertToolsPanelResponsive(page: Page): Promise<void> {
    const assistantTab = page.getByRole('tab', { name: /assistant/i });
    const databaseTab = page.getByRole('tab', { name: /database/i });

    await expect(assistantTab).toBeVisible({ timeout: 10_000 });
    await assistantTab.click({ timeout: 5000 });
    await expect(assistantTab).toHaveAttribute('data-state', 'active');

    await expect(databaseTab).toBeVisible({ timeout: 10_000 });
    await databaseTab.click({ timeout: 5000 });
    await expect(databaseTab).toHaveAttribute('data-state', 'active');
  }

  async function getEmbeddingHostStatus(page: Page): Promise<EmbeddingHostStatus> {
    return await page.evaluate<EmbeddingHostStatus>(async () => {
      const host = (
        window as Window & {
          embeddingHost?: {
            getStatus?: () => Promise<EmbeddingHostStatus>;
          };
        }
      ).embeddingHost;
      if (!host?.getStatus) {
        throw new Error('Embedding host bridge is not available');
      }
      return await host.getStatus();
    });
  }

  async function resetEmbeddingHost(page: Page): Promise<EmbeddingHostStatus> {
    return await page.evaluate<EmbeddingHostStatus>(async () => {
      const host = (
        window as Window & {
          embeddingHost?: {
            reset?: () => Promise<EmbeddingHostStatus>;
          };
        }
      ).embeddingHost;
      if (!host?.reset) {
        throw new Error('Embedding host reset bridge is not available');
      }
      return await host.reset();
    });
  }

  async function waitForEmbeddingHostState(
    page: Page,
    predicate: (status: EmbeddingHostStatus) => boolean,
    timeoutMs = 15_000
  ): Promise<EmbeddingHostStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await getEmbeddingHostStatus(page);
      if (predicate(status)) {
        return status;
      }
      await page.waitForTimeout(250);
    }
    throw new Error('Timed out waiting for embedding host state');
  }

  async function waitForActiveProcessingOrFatalError(
    page: Page,
    timeoutMs = 60_000
  ): Promise<'error' | 'running'> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const [status, queueStats] = await Promise.all([
        getEmbeddingHostStatus(page),
        getEmbeddingQueueStats(page),
      ]);

      if (status.state === 'error') {
        return 'error';
      }

      if (status.active && queueStats.running > 0 && queueStats.running <= 4) {
        return 'running';
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for active embedding processing or fatal host error');
  }

  async function waitForBackfillButtonEnabled(
    page: Page,
    backfillButton: ReturnType<Page['locator']>,
    timeoutMs = 15_000
  ): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const [enabled, queueStats] = await Promise.all([
        backfillButton.isEnabled(),
        getEmbeddingQueueStats(page),
      ]);

      if (enabled && queueStats.queued === 0 && queueStats.running === 0) {
        return;
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for the backfill button to become enabled');
  }

  async function waitForBoundedBackfillEnqueueOrFatalError(
    page: Page,
    timeoutMs = 15_000
  ): Promise<'error' | 'queued'> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const [status, queueStats] = await Promise.all([
        getEmbeddingHostStatus(page),
        getEmbeddingQueueStats(page),
      ]);

      if (status.state === 'error') {
        return 'error';
      }

      const totalObserved =
        queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
      if (totalObserved > 0 && queueStats.queued + queueStats.running <= 64) {
        return 'queued';
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for bounded backfill enqueue or fatal host error');
  }

  async function getEmbeddingHostPage(window: Page): Promise<Page> {
    const context = window.context();
    const startedAt = Date.now();

    while (Date.now() - startedAt < 15_000) {
      const hostPage = context
        .pages()
        .find((page) => page.url().includes('mode=embedding-host') && !page.isClosed());

      if (hostPage) {
        await hostPage.waitForLoadState('domcontentloaded');
        return hostPage;
      }

      await window.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for hidden embedding host page');
  }

  async function getRendererLogRecords(page: Page): Promise<BufferedLogRecord[]> {
    return await page.evaluate<BufferedLogRecord[]>(() => {
      const logBuffer = (
        window as Window & {
          __brainstrikeRendererLogBuffer?: {
            getRecords?: () => readonly BufferedLogRecord[];
          };
        }
      ).__brainstrikeRendererLogBuffer;

      if (!logBuffer?.getRecords) {
        throw new Error('Renderer log buffer is not available');
      }

      return [...logBuffer.getRecords()];
    });
  }

  function recordContainsText(record: BufferedLogRecord, text: string): boolean {
    if (typeof record.message === 'string' && record.message.includes(text)) {
      return true;
    }

    return record.args.some((arg) => typeof arg === 'string' && arg.includes(text));
  }

  function countRecordsContainingText(records: readonly BufferedLogRecord[], text: string): number {
    return records.filter((record) => recordContainsText(record, text)).length;
  }

  async function createTestBackfillJob(page: Page): Promise<{
    chunkId: string;
    embeddingSetId: string;
    jobId: string;
  }> {
    return await page.evaluate<{ chunkId: string; embeddingSetId: string; jobId: string }>(
      async () => {
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
          throw new Error('Database API not available');
        }

        const now = new Date().toISOString();
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const fileRecordId = `test-file-${randomSuffix}`;
        const chunkId = `test-chunk-${randomSuffix}`;
        const embeddingSetId = `test-set-${randomSuffix}`;
        const jobId = `test-job-${randomSuffix}`;
        const modelId = 'Xenova/all-MiniLM-L6-v2';
        const modelKey = `local::${modelId}`;
        const expectedDimension = 384;

        await api.db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [embeddingSetId, modelKey, modelId, expectedDimension, 'cosine', now]
        );

        await api.db.query(
          `INSERT INTO file_records (id, path, name, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [
            fileRecordId,
            `/test/${fileRecordId}.txt`,
            `${fileRecordId}.txt`,
            100,
            'Test content for embedding host validation',
            `hash-${randomSuffix}`,
            16,
            now,
          ]
        );

        await api.db.query(
          `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $8)`,
          [
            chunkId,
            fileRecordId,
            0,
            'Test content for embedding host validation',
            `chunk-hash-${randomSuffix}`,
            16,
            16,
            now,
          ]
        );

        await api.db.query(
          `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
          [
            jobId,
            JSON.stringify({
              chunkId,
              embeddingSetId,
              modelKey,
              expectedDimension,
            }),
            now,
          ]
        );

        return { chunkId, embeddingSetId, jobId };
      }
    );
  }

  async function createInvalidJob(page: Page): Promise<string> {
    return await page.evaluate<string>(async () => {
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
        throw new Error('Database API not available');
      }

      const now = new Date().toISOString();
      const jobId = `invalid-job-${Math.random().toString(36).slice(2, 10)}`;
      await api.db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 1, 0, $3, $3)`,
        [jobId, JSON.stringify({ chunkId: 'missing-canonical-fields' }), now]
      );
      return jobId;
    });
  }

  async function clearEmbeddingQueue(page: Page): Promise<void> {
    await page.evaluate(async () => {
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
        throw new Error('Database API not available');
      }

      await api.db.query(`DELETE FROM job_queue WHERE queue = 'embeddings'`);
    });
  }

  async function createLargeBackfillFixture(
    page: Page,
    chunkCount: number,
    options?: { persistActiveSet?: boolean }
  ): Promise<{ embeddingSetId: string }> {
    return await page.evaluate<
      { embeddingSetId: string },
      { chunkCount: number; persistActiveSet: boolean }
    >(
      async ({ chunkCount: count, persistActiveSet }) => {
        const api = (
          window as Window & {
            electronAPI?: {
              db?: {
                query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
              };
              storage?: {
                setItem?: (key: string, value: string) => Promise<void>;
              };
            };
          }
        ).electronAPI;

        if (!api?.db?.query) {
          throw new Error('Database API not available');
        }
        if (!api?.storage?.setItem) {
          throw new Error('Storage API not available');
        }

        const now = new Date().toISOString();
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const embeddingSetId = `large-set-${randomSuffix}`;
        const fileRecordId = `large-file-${randomSuffix}`;
        const modelId = 'Xenova/all-MiniLM-L6-v2';
        const modelKey = `local::${modelId}`;

        await api.db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [embeddingSetId, modelKey, modelId, 384, 'cosine', 'Large Backfill', now]
        );

        await api.db.query(
          `INSERT INTO file_records (
           id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            fileRecordId,
            `/test/${fileRecordId}.txt`,
            `${fileRecordId}.txt`,
            count * 32,
            'Large backfill file',
            `file-hash-${randomSuffix}`,
            count * 8,
            embeddingSetId,
            now,
          ]
        );

        for (let index = 0; index < count; index += 1) {
          await api.db.query(
            `INSERT INTO file_chunks (
             id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $8)`,
            [
              `${fileRecordId}-chunk-${index}`,
              fileRecordId,
              index,
              `Chunk ${index} content for backfill responsiveness`,
              `chunk-hash-${randomSuffix}-${index}`,
              8,
              8,
              now,
            ]
          );
        }

        if (persistActiveSet) {
          await api.storage.setItem(
            'vector-status-ui.v1',
            JSON.stringify({
              state: { activeEmbeddingSetId: embeddingSetId },
              version: 1,
            })
          );
        }

        return { embeddingSetId };
      },
      { chunkCount, persistActiveSet: options?.persistActiveSet ?? true }
    );
  }

  async function getJobStatus(page: Page, jobId: string): Promise<string | null> {
    return await page.evaluate<string | null, string>(async (id) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: { state: string }[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      const result = (await api.db.query('SELECT state FROM job_queue WHERE id = $1', [id])) as {
        rows: Array<{ state?: string }>;
      };
      return result.rows[0]?.state ?? null;
    }, jobId);
  }

  async function getEmbeddingQueueStats(page: Page): Promise<QueueStatsRow> {
    return await page.evaluate<QueueStatsRow>(async () => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: QueueStatsRow[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      const result = await api.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
           COUNT(*) FILTER (WHERE state = 'running')::int AS running,
           COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
         FROM job_queue
         WHERE queue = 'embeddings'`
      );
      const row = result.rows[0] as QueueStatsRow | undefined;
      if (!row) {
        throw new Error('Queue stats query returned no rows');
      }
      return row;
    });
  }

  async function getEmbeddingSetQueueStats(
    page: Page,
    embeddingSetId: string
  ): Promise<QueueStatsRow> {
    return await page.evaluate<QueueStatsRow, string>(async (id) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: QueueStatsRow[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      const result = await api.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
           COUNT(*) FILTER (WHERE state = 'running')::int AS running,
           COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
         FROM job_queue
         WHERE queue = 'embeddings'
           AND job_type = 'embed_chunk'
           AND payload->>'embeddingSetId' = $1`,
        [id]
      );
      const row = result.rows[0] as QueueStatsRow | undefined;
      if (!row) {
        throw new Error('Embedding-set queue stats query returned no rows');
      }
      return row;
    }, embeddingSetId);
  }

  async function getEmbeddingSetCounts(
    page: Page,
    embeddingSetId: string
  ): Promise<EmbeddingSetCounts> {
    return await page.evaluate<EmbeddingSetCounts, string>(async (id) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, number | string | null>[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const result = await api.db.query(
        `SELECT
           COUNT(DISTINCT fr.id)::int AS "fileCount",
           COUNT(c.id)::int AS "totalChunks",
           COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS "embeddedChunks"
         FROM file_records fr
         LEFT JOIN file_chunks c ON c.file_record_id = fr.id
         WHERE fr.embedding_set_id = $1`,
        [id]
      );
      const row = result.rows[0] as EmbeddingSetCountsRow | undefined;
      if (!row) {
        throw new Error('Embedding-set counts query returned no rows');
      }
      return {
        fileCount: Number(row['fileCount'] ?? 0),
        totalChunks: Number(row['totalChunks'] ?? 0),
        embeddedChunks: Number(row['embeddedChunks'] ?? 0),
      };
    }, embeddingSetId);
  }

  interface CollectionSummaryCounts {
    embeddedChunks: number;
    fileCount: number;
    totalChunks: number;
  }

  function parseCollectionSummaryCounts(summaryText: string): CollectionSummaryCounts {
    const normalized = summaryText.replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /(\d+)\s+files?.*?(\d+)\s+chunks?.*?(\d+)\s*\/\s*(\d+)\s+embedded/i
    );

    if (!match) {
      throw new Error(`Unable to parse collection summary counts from: ${summaryText}`);
    }

    return {
      fileCount: Number(match[1]),
      totalChunks: Number(match[2]),
      embeddedChunks: Number(match[3]),
    };
  }

  async function getCollectionSummaryCounts(
    page: Page,
    collectionName: string
  ): Promise<CollectionSummaryCounts> {
    const option = page.getByRole('option').filter({ hasText: collectionName }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    const text = await option.innerText();
    return parseCollectionSummaryCounts(text);
  }

  async function createImportTargetCollection(
    page: Page,
    collectionName?: string
  ): Promise<{ collectionName: string; embeddingSetId: string }> {
    return await page.evaluate(async (name) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
            storage?: {
              setItem?: (key: string, value: string) => Promise<void>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      if (!api?.storage?.setItem) {
        throw new Error('Storage API not available');
      }

      const now = new Date().toISOString();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const embeddingSetId = `import-set-${randomSuffix}`;
      const modelId = 'Xenova/all-MiniLM-L6-v2';
      const modelKey = `local::${modelId}`;

      await api.db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [embeddingSetId, modelKey, modelId, 384, 'cosine', name ?? 'Import Backfill Test', now]
      );

      await api.storage.setItem(
        'vector-status-ui.v1',
        JSON.stringify({
          state: { activeEmbeddingSetId: embeddingSetId },
          version: 1,
        })
      );

      return { embeddingSetId, collectionName: name ?? 'Import Backfill Test' };
    }, collectionName);
  }

  async function getRendererTimeOrigin(page: Page): Promise<number> {
    return await page.evaluate(() => window.performance.timeOrigin);
  }

  async function setVectorDevicePreference(
    page: Page,
    devicePref: 'wasm' | 'webgpu'
  ): Promise<void> {
    await page.evaluate((nextDevicePref) => {
      const storageBridge = (
        window as Window & {
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
            devicePref: nextDevicePref,
            devicePrefConfigured: true,
            reinitEveryN: 200,
            verboseOrtLogs: false,
          },
          version: 3,
        })
      );
    }, devicePref);
  }

  async function waitForImportedChunks(page: Page, embeddingSetId: string): Promise<void> {
    await expect
      .poll(async () => await getEmbeddingSetCounts(page, embeddingSetId), {
        timeout: 30_000,
      })
      .toMatchObject({
        fileCount: 2,
        totalChunks: expect.any(Number),
      });

    const counts = await getEmbeddingSetCounts(page, embeddingSetId);
    expect(counts.totalChunks).toBeGreaterThan(0);
  }

  async function createChunkedImportFixture(
    page: Page,
    embeddingSetId: string
  ): Promise<{ fileCount: number; totalChunks: number }> {
    return await page.evaluate<
      { fileCount: number; totalChunks: number },
      { embeddingSetId: string }
    >(
      async ({ embeddingSetId: id }) => {
        const api = (
          window as Window & {
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
        const files = [
          {
            id: `import-file-${crypto.randomUUID()}`,
            name: 'mock-file1.txt',
            path: '/mock/test/directory/mock-file1.txt',
            chunks: [
              'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.',
              'The second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
            ],
            content:
              'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.\nThe second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
            strategy: 'sentence',
          },
          {
            id: `import-file-${crypto.randomUUID()}`,
            name: 'mock-file2.ts',
            path: '/mock/test/directory/mock-file2.ts',
            chunks: [
              'export function fixtureValue(): string { return "desktop import backfill regression"; }',
              'export const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
            ],
            content:
              'export function fixtureValue(): string { return "desktop import backfill regression"; }\nexport const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
            strategy: 'recursive',
          },
        ] as const;

        let totalChunks = 0;

        for (const file of files) {
          await api.db.query(
            `INSERT INTO file_records (
             id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [
              file.id,
              file.path,
              file.name,
              file.content.length,
              file.content,
              `content-hash-${file.id}`,
              Math.max(1, Math.ceil(file.content.length / 8)),
              id,
              now,
            ]
          );

          for (const [chunkIndex, chunkContent] of file.chunks.entries()) {
            await api.db.query(
              `INSERT INTO file_chunks (
               id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
              [
                `${file.id}-chunk-${chunkIndex}`,
                file.id,
                chunkIndex,
                chunkContent,
                `chunk-hash-${file.id}-${chunkIndex}`,
                Math.max(1, Math.ceil(chunkContent.length / 8)),
                file.name.endsWith('.ts') ? 'code' : 'text',
                chunkContent.length,
                now,
              ]
            );
          }

          await api.db.query(
            `UPDATE file_records
              SET chunks_processed_at = $2,
                  chunks_count = $3,
                  chunking_strategy = $4,
                  updated_at = $2
            WHERE id = $1`,
            [file.id, now, file.chunks.length, file.strategy]
          );

          totalChunks += file.chunks.length;
        }

        return { fileCount: files.length, totalChunks };
      },
      { embeddingSetId }
    );
  }

  async function waitForEmbeddedCollectionSummary(
    page: Page,
    collectionName: string,
    timeoutMs = 90_000
  ): Promise<CollectionSummaryCounts> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const summary = await getCollectionSummaryCounts(page, collectionName);
      if (summary.totalChunks > 0 && summary.embeddedChunks === summary.totalChunks) {
        return summary;
      }
      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for collection summary to reach full embedding coverage');
  }

  async function waitForBackfillQueueMovementOrFatalError(
    page: Page,
    embeddingSetId: string,
    timeoutMs = 30_000
  ): Promise<'error' | 'queued'> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const [status, queueStats] = await Promise.all([
        getEmbeddingHostStatus(page),
        getEmbeddingSetQueueStats(page, embeddingSetId),
      ]);

      if (status.state === 'error') {
        return 'error';
      }

      const totalObserved =
        queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
      if (totalObserved > 0) {
        return 'queued';
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for set-scoped backfill queue movement or fatal host error');
  }

  test.beforeAll(async ({ electron }) => {
    test.setTimeout(150_000);
    const { window: appWindow } = await electron.ensureContext();
    await waitForAppReady(appWindow);

    const dbStatus = await appWindow.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          electronAPI?: {
            db?: {
              clearAll?: (token?: string) => Promise<{ message?: string; success: boolean }>;
              test?: () => Promise<unknown>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.test) {
        return { ok: false, message: 'Database API not available' };
      }

      try {
        await api.db.test();
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }

      if (!api.db.clearAll) {
        return { ok: true, message: null };
      }

      const result = await api.db.clearAll('CONFIRM_CLEAR_DATABASE');
      return { ok: result.success, message: result.message ?? null };
    });

    if (!dbStatus.ok) {
      console.warn('Database unavailable in test setup:', dbStatus.message);
    }
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  test('defers hidden embedding host startup until first use', async ({ electron }) => {
    const context = await electron.restart();
    const window = context.window;
    await waitForAppReady(window);

    if (await isDatabaseError(window)) {
      await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const initialStatus = await window.evaluate(async () => {
      const api = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            getStatus?: () => Promise<{
              active: boolean;
              lastError: string | null;
              runtimeId: string;
              runtimeKind: 'embedding-host';
              state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
            }>;
          };
        }
      ).embeddingHost;

      if (!api?.getStatus) {
        throw new Error('Embedding host bridge is not available');
      }

      return api.getStatus();
    });

    expect(initialStatus.state).toBe('stopped');
    expect(initialStatus.lastError).toBeNull();

    const status = await window.evaluate(async () => {
      const api = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            ensureStarted?: () => Promise<{
              active: boolean;
              lastError: string | null;
              runtimeId: string;
              runtimeKind: 'embedding-host';
              state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
            }>;
          };
        }
      ).embeddingHost;

      if (!api?.ensureStarted) {
        throw new Error('Embedding host bridge is not available');
      }

      return api.ensureStarted();
    });

    expect(status.state).toBe('running');
    expect(status.lastError).toBeNull();

    const hostPage = await getEmbeddingHostPage(window);
    await hostPage.waitForTimeout(1000);
    const hostLogs = await getRendererLogRecords(hostPage);

    expect(
      hostLogs.some((record) =>
        recordContainsText(
          record,
          'Deferring local embedding model initialization until first claimed job'
        )
      )
    ).toBe(true);
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Warmup job submission failed'))
    ).toBe(false);
    expect(
      hostLogs.some((record) => recordContainsText(record, 'worker_model_dimension_notice'))
    ).toBe(false);
    expect(
      hostLogs.some((record) =>
        recordContainsText(record, 'Failed to create WebGPU Context Provider')
      )
    ).toBe(false);
    expect(hostLogs.some((record) => recordContainsText(record, 'Pipeline load failed'))).toBe(
      false
    );
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Workerpool embedding task failed'))
    ).toBe(false);
  });

  test('keeps the visible UI responsive while jobs are queued for the hidden host', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const jobs = await Promise.all([
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
    ]);

    expect(jobs).toHaveLength(3);
    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('running');
  });

  test('keeps the visible UI responsive while a large backfill is being enqueued', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    const fixture = await createLargeBackfillFixture(activeWindow, 160);
    await reloadRenderer(activeWindow, 'embedding-worker-large-backfill-fixture');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);

    await backfillButton.click({ timeout: 5000 });
    await assertToolsPanelResponsive(activeWindow);

    const enqueueState = await waitForBoundedBackfillEnqueueOrFatalError(activeWindow);
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    if (enqueueState === 'queued') {
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
      expect(
        queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded
      ).toBeGreaterThan(0);
      return;
    }

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
  });

  test('keeps the visible UI responsive while the hidden host is actively processing a backfill', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    const fixture = await createLargeBackfillFixture(activeWindow, 96, { persistActiveSet: false });
    await reloadRenderer(activeWindow, 'embedding-worker-host-processing-fixture');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });
    await expect(
      activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Starting…' })
    ).toHaveCount(0);

    const finalState = await waitForActiveProcessingOrFatalError(activeWindow);
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    if (finalState === 'running') {
      expect(queueStats.queued + queueStats.running).toBeGreaterThan(0);
      expect(queueStats.running).toBeLessThanOrEqual(4);
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
    } else {
      const status = await getEmbeddingHostStatus(activeWindow);
      const hostPage = await getEmbeddingHostPage(activeWindow);
      await hostPage.waitForTimeout(1000);
      const hostLogs = await getRendererLogRecords(hostPage);

      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      expect(countRecordsContainingText(hostLogs, 'Pipeline load failed')).toBeLessThanOrEqual(1);
      expect(
        countRecordsContainingText(hostLogs, 'Embedding worker streaming failed')
      ).toBeLessThanOrEqual(1);
      expect(queueStats.running).toBe(0);
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
      expect(
        countRecordsContainingText(
          hostLogs,
          'Stopping embedding worker after fatal local model error'
        )
      ).toBeLessThanOrEqual(1);
    }

    await assertToolsPanelResponsive(activeWindow);
    await activeWindow.waitForTimeout(500);
    await assertToolsPanelResponsive(activeWindow);
  });

  test('backfills chunked imported data without hanging and updates collection coverage', async ({
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
    await reloadRenderer(activeWindow, 'embedding-worker-import-backfill-flow');
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
        fileCount: chunkedFixture.fileCount,
        totalChunks: expect.any(Number),
        embeddedChunks: expect.any(Number),
      });

    const countsAfterBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);
    expect(countsAfterBackfill.totalChunks).toBeGreaterThan(0);
    expect(countsAfterBackfill.embeddedChunks).toBe(countsAfterBackfill.totalChunks);

    const timeOriginAfterBackfill = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterBackfill).toBe(timeOriginBeforeBackfill);
    await expect(backfillButton).toContainText('Backfill', { timeout: 15_000 });
  });

  test('fails invalid job payloads without taking down the embedding host or visible UI', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await resetEmbeddingHost(activeWindow);
    await waitForEmbeddingHostState(activeWindow, (status) => status.state === 'running');

    const invalidJobId = await createInvalidJob(activeWindow);

    await expect
      .poll(async () => await getJobStatus(activeWindow, invalidJobId), {
        timeout: 15_000,
      })
      .toBe('failed');

    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('running');
  });

  test('keeps the hidden host alive across visible-window navigation', async ({ window }) => {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const hostPageBefore = await getEmbeddingHostPage(activeWindow);
    const before = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, before.jobId)).not.toBeNull();

    const assistantTab = activeWindow.getByRole('tab', { name: /assistant/i });
    await assistantTab.click({ timeout: 5000 });
    await expect(assistantTab).toHaveAttribute('data-state', 'active');

    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPageAfter = await getEmbeddingHostPage(activeWindow);
    expect(hostPageAfter).toBe(hostPageBefore);

    const after = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, after.jobId)).not.toBeNull();

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state === 'running' || status.state === 'error').toBe(true);
    if (status.state === 'error') {
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    }
  });
});
