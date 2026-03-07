import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppReady } from './utils/electron-helpers';
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

  test('starts the hidden embedding host automatically on app launch', async ({ electron }) => {
    const context = await electron.restart();
    const window = context.window;
    await waitForAppReady(window);

    if (await isDatabaseError(window)) {
      await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const status = await waitForEmbeddingHostState(
      window,
      (current) => current.state === 'running' || current.state === 'error'
    );

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

  test('fails invalid job payloads without taking down the embedding host or visible UI', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

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

    const before = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, before.jobId)).not.toBeNull();

    const assistantTab = activeWindow.getByRole('tab', { name: /assistant/i });
    await assistantTab.click({ timeout: 5000 });
    await expect(assistantTab).toHaveAttribute('data-state', 'active');

    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const after = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, after.jobId)).not.toBeNull();

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('running');
  });
});
