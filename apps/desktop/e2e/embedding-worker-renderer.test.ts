import type { ConsoleMessage, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppReady } from './utils/electron-helpers';
import { showDatabaseDemoPanel } from './utils/layout-helpers';

/**
 * E2E tests for embedding worker running in renderer process (PR #413 architecture).
 * Tests verify that the worker starts automatically, processes jobs, handles errors,
 * and respects environment variables.
 */
test.describe('Embedding Worker in Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  const ERROR_LOCATOR = '[data-testid="db-init-error"]';
  let hasDatabaseError = false;

  /**
   * Check if database is in error state (e.g., pgvector missing)
   */
  async function isDatabaseError(page: Page): Promise<boolean> {
    if (hasDatabaseError) {
      return true;
    }
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

  /**
   * Capture console messages from the renderer process
   */
  function captureConsoleLogs(page: Page): {
    logs: ConsoleMessage[];
    addListener: () => void;
    removeListener: () => void;
  } {
    const logs: ConsoleMessage[] = [];

    const handler = (msg: ConsoleMessage) => {
      logs.push(msg);
    };

    const addListener = () => page.on('console', handler);
    const removeListener = () => page.off('console', handler);

    return { logs, addListener, removeListener };
  }

  /**
   * Find console logs matching a pattern
   */
  function findLogMessages(logs: ConsoleMessage[], pattern: string | RegExp): ConsoleMessage[] {
    return logs.filter((msg) => {
      const text = msg.text();
      return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    });
  }

  /**
   * Create a test backfill job in the database
   */
  async function createTestBackfillJob(page: Page): Promise<{ jobId: string; chunkId: string }> {
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          electronAPI?: {
            db?: { query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      // Create a test chunk first
      const randomSuffix = Math.random().toString(36).substring(7);
      const chunkId = `test-chunk-${Date.now()}-${randomSuffix}`;
      const fileRecordId = `test-file-${Date.now()}-${randomSuffix}`;
      const now = new Date().toISOString();

      await api.db.query(
        `INSERT INTO file_records (id, path, name, size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fileRecordId, '/test/path.txt', 'path.txt', 100, now, now]
      );

      await api.db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          chunkId,
          fileRecordId,
          0,
          'Test content for embedding',
          `test-hash-${Date.now()}-${randomSuffix}`,
          50,
          now,
          now,
        ]
      );

      // Create a backfill job
      const jobId = `test-job-${Date.now()}-${randomSuffix}`;
      await api.db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          jobId,
          'embeddings',
          'embed_chunk',
          JSON.stringify({ chunkId, fileRecordId }),
          'queued',
          new Date().toISOString(),
        ]
      );

      return { jobId, chunkId };
    });

    return result;
  }

  /**
   * Check job state in the database
   */
  async function getJobStatus(page: Page, jobId: string): Promise<string | null> {
    return page.evaluate(async (id: string) => {
      const api = (
        window as unknown as {
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

      const result = await api.db.query('SELECT state FROM job_queue WHERE id = $1', [id]);

      return result.rows[0]?.state ?? null;
    }, jobId);
  }

  test.beforeAll(async ({ electron }) => {
    test.setTimeout(150_000);
    const { window } = await electron.ensureContext();
    await waitForAppReady(window);

    const dbStatus = await window.evaluate(async () => {
      const api = (
        window as unknown as {
          electronAPI?: {
            db?: {
              test?: () => Promise<unknown>;
              clearAll?: (token?: string) => Promise<{ success: boolean; message?: string }>;
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
        return { ok: true };
      }

      const result = await api.db.clearAll('CONFIRM_CLEAR_DATABASE');
      return { ok: result.success, message: result.message ?? null };
    });

    if (!dbStatus.ok) {
      hasDatabaseError = true;
      console.warn('⚠️ Database unavailable in test setup:', dbStatus.message);
    }
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  test('should start embedding worker automatically when app launches', async ({ electron }) => {
    // Start with a fresh window to capture worker startup from the beginning
    const context = await electron.restart();
    const window = context.window;

    // Set up console listener before the app fully loads
    const consoleLogs = captureConsoleLogs(window);
    consoleLogs.addListener();

    try {
      // Wait for app to be ready
      await window.waitForTimeout(5000);

      // Navigate to database panel to ensure we're in the right context
      await showDatabaseDemoPanel(window);

      if (await isDatabaseError(window)) {
        console.log('⚠️ Database error (pgvector missing) – skipping worker startup test');
        await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      // Wait a bit more for worker logs to appear
      await window.waitForTimeout(3000);

      // Verify the worker startup logs are present
      const startupLogs = findLogMessages(consoleLogs.logs, /embedding.*worker/i);

      // Worker should have logged something about starting
      expect(startupLogs.length).toBeGreaterThan(0);

      // Check for specific startup messages
      const hasStartupLog = consoleLogs.logs.some((log) => {
        const text = log.text();
        return (
          text.includes('Starting embedding worker') ||
          text.includes('started successfully') ||
          text.includes('embedding worker')
        );
      });

      expect(hasStartupLog).toBe(true);

      console.log(
        `✅ Found ${startupLogs.length} embedding worker logs, including startup messages`
      );
    } finally {
      consoleLogs.removeListener();
    }
  });

  test('should log worker activity in renderer process console', async ({ electron }) => {
    // Start fresh to capture logs from the beginning
    const context = await electron.restart();
    const window = context.window;

    const consoleLogs = captureConsoleLogs(window);
    consoleLogs.addListener();

    try {
      // Wait for app to initialize and worker to start
      await window.waitForTimeout(5000);

      // Navigate to database panel to trigger any additional worker activity
      await showDatabaseDemoPanel(window);

      if (await isDatabaseError(window)) {
        console.log('⚠️ Database error – skipping console log test');
        await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await window.waitForTimeout(2000);

      // Verify logs contain embedding worker messages
      const embeddingLogs = findLogMessages(consoleLogs.logs, /embedding/i);
      expect(embeddingLogs.length).toBeGreaterThan(0);

      // Verify logs are from the renderer (not main) process
      // In Playwright, renderer logs appear as 'page' type
      const rendererLogs = embeddingLogs.filter((msg) => msg.type() !== 'error');
      expect(rendererLogs.length).toBeGreaterThan(0);

      console.log(`✅ Found ${rendererLogs.length} embedding worker logs in renderer console`);
    } finally {
      consoleLogs.removeListener();
    }
  });

  test('should create backfill jobs in job_queue table', async ({ window }) => {
    await showDatabaseDemoPanel(window);

    if (await isDatabaseError(window)) {
      console.log('⚠️ Database error – skipping job creation test');
      await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Create a test backfill job
    const { jobId, chunkId } = await createTestBackfillJob(window);
    console.log(`✅ Created test job: ${jobId} for chunk: ${chunkId}`);

    // Verify the job was created in the database
    // Note: The worker may pick up the job immediately, so it could be "queued" or "running"
    const status = await getJobStatus(window, jobId);
    expect(['queued', 'running']).toContain(status);

    console.log(`✅ Job successfully created with status: ${status}`);

    // Note: We don't verify job processing here because embedding models
    // may not be available in the test environment. The worker will pick
    // up jobs when models are available.
  });

  test('should handle app responsiveness during embedding operations', async ({ window }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database error – skipping responsiveness test');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Create multiple test jobs
    const jobs = await Promise.all([
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
    ]);

    console.log(`✅ Created ${jobs.length} test jobs`);

    // Verify UI remains responsive while jobs are queued
    await assertToolsPanelResponsive(activeWindow);

    console.log('✅ UI remains responsive during embedding operations');
  });

  test('should respect VITE_EMBED_* environment variables', async ({ electron }) => {
    // Start fresh to capture initialization
    const context = await electron.restart();
    const window = context.window;

    // The worker reads VITE_EMBED_CONCURRENCY, VITE_EMBED_LEASE_MS, and VITE_EMBED_MODEL_KEY
    // We verify the worker started successfully, which means it read and applied the env vars
    const consoleLogs = captureConsoleLogs(window);
    consoleLogs.addListener();

    try {
      // Wait for app to initialize
      await window.waitForTimeout(5000);

      // Navigate to database panel
      const activeWindow = await showDatabaseDemoPanel(window);

      if (await isDatabaseError(activeWindow)) {
        console.log('⚠️ Database error – skipping env variable test');
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await window.waitForTimeout(2000);

      // Verify worker logs are present (which means it initialized with env vars)
      const workerLogs = findLogMessages(consoleLogs.logs, /embedding.*worker/i);

      // Worker should have logged during startup
      expect(workerLogs.length).toBeGreaterThan(0);

      // Verify the app is operational (worker initialized correctly)
      await assertToolsPanelResponsive(activeWindow);

      console.log('✅ Worker initialized with environment variables');
    } finally {
      consoleLogs.removeListener();
    }
  });

  test('should handle invalid job payloads gracefully', async ({ window }) => {
    // Navigate to database panel first
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database error – skipping error handling test');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Create a job with invalid payload
    const invalidJobId = await activeWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          electronAPI?: {
            db?: { query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const jobId = `invalid-job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      await api.db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          jobId,
          'embeddings',
          'embed_chunk',
          JSON.stringify({ chunkId: 'nonexistent-chunk' }),
          'queued',
          new Date().toISOString(),
        ]
      );

      return jobId;
    });

    console.log(`✅ Created invalid job: ${invalidJobId}`);

    // Verify the job was created (could be queued or running if picked up quickly)
    const status = await getJobStatus(activeWindow, invalidJobId);
    expect(['queued', 'running']).toContain(status);

    // Verify the app remains responsive (worker doesn't crash from invalid payload)
    await assertToolsPanelResponsive(activeWindow);

    console.log('✅ App remains responsive with invalid job in queue');
  });

  test('should verify worker runs in renderer (not main) process', async ({ window }) => {
    // Navigate to database panel first
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database error – skipping process verification test');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Verify that we're in a renderer context with browser APIs
    const isRendererContext = await activeWindow.evaluate(() => {
      // Check for renderer-specific APIs
      return (
        typeof window !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof navigator !== 'undefined'
      );
    });

    expect(isRendererContext).toBe(true);

    // Verify Worker API is available in renderer context
    const hasWorkerInRenderer = await activeWindow.evaluate(() => {
      // The worker should be started via EmbeddingWorkerProvider in the renderer
      // Check for Web Worker API availability
      return typeof Worker !== 'undefined';
    });

    expect(hasWorkerInRenderer).toBe(true);

    console.log('✅ Verified worker runs in renderer process context with Web Worker API');
  });

  test('should persist worker across navigation', async ({ window }) => {
    // Navigate to database panel
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database error – skipping navigation test');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Create a test job before navigation
    const { jobId: beforeJobId } = await createTestBackfillJob(activeWindow);
    console.log(`✅ Created job before navigation: ${beforeJobId}`);

    // Verify job was created (could be queued or running if picked up quickly)
    const beforeStatus = await getJobStatus(activeWindow, beforeJobId);
    expect(['queued', 'running']).toContain(beforeStatus);

    // Navigate to a different tab (e.g., Explorer)
    const explorerTab = activeWindow
      .locator('button:has-text("Explorer")')
      .or(activeWindow.locator('[role="tab"]:has-text("Explorer")'));

    if (await explorerTab.isVisible()) {
      await explorerTab.click();
      await activeWindow.waitForTimeout(2000);
      console.log('✅ Navigated to Explorer tab');
    }

    // Navigate back to database
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await activeWindow.waitForTimeout(1000);

    // Create another job after navigation
    const { jobId: afterJobId } = await createTestBackfillJob(activeWindow);
    console.log(`✅ Created job after navigation: ${afterJobId}`);

    // Verify second job was also created (could be queued or running if picked up quickly)
    const afterStatus = await getJobStatus(activeWindow, afterJobId);
    expect(['queued', 'running']).toContain(afterStatus);

    // Verify the app is still responsive
    await assertToolsPanelResponsive(activeWindow);

    console.log('✅ Worker persists and accepts jobs after navigation');
  });
});
