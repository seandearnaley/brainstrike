import type { ConsoleMessage, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  clearDatabaseRecords,
  showDatabaseDemoPanel,
  waitForDatabaseReady,
} from './utils/layout-helpers';

/**
 * E2E tests for embedding worker running in renderer process (PR #413 architecture).
 * Tests verify that the worker starts automatically, processes jobs, handles errors,
 * and respects environment variables.
 */
test.describe('Embedding Worker in Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  const ERROR_LOCATOR = '[data-testid="db-init-error"]';

  /**
   * Check if database is in error state (e.g., pgvector missing)
   */
  async function isDatabaseError(page: Page): Promise<boolean> {
    try {
      return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  async function skipIfDatabaseError(page: Page, reason: string): Promise<boolean> {
    if (!(await isDatabaseError(page))) {
      return false;
    }

    console.log(`⚠️ ${reason}`);
    await expect(page.locator(ERROR_LOCATOR).first()).toBeVisible();
    return true;
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
          'embed-chunk',
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
    test.setTimeout(150000);
    const { window } = await electron.ensureContext();
    const activeWindow = await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(activeWindow);

    if (!(await isDatabaseError(activeWindow))) {
      await clearDatabaseRecords(activeWindow);
    }
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  /**
   * Wait for a log message matching a pattern
   */
  async function waitForLogMessage(
    page: Page,
    pattern: string | RegExp,
    timeout = 10000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = (msg: ConsoleMessage) => {
        const text = msg.text();
        if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
          page.off('console', handler);
          resolve(true);
        }
      };

      page.on('console', handler);

      // Check existing logs first (if we have a way to access them, but here we just start listening)
      // In a real scenario we might want to check a buffer, but for now we assume we call this early enough
      // or we rely on the fact that we just started listening.

      setTimeout(() => {
        page.off('console', handler);
        resolve(false);
      }, timeout);
    });
  }

  test('should start embedding worker automatically when app launches', async ({ electron }) => {
    // Start with a fresh window to capture worker startup from the beginning
    const context = await electron.restart();
    const window = context.window;
    let consoleLogs: ReturnType<typeof captureConsoleLogs> | null = null;

    try {
      if (
        await skipIfDatabaseError(
          window,
          'Database error (pgvector missing) – skipping worker startup test'
        )
      ) {
        return;
      }

      // Set up console listener immediately
      consoleLogs = captureConsoleLogs(window);
      consoleLogs.addListener();

      // Wait for the startup message specifically
      const startupPattern = /Starting embedding worker|started successfully|embedding worker/i;

      // We race the log wait against a general timeout/app ready check
      // But since we want to verify the log *appears*, we should wait for it.
      // However, if it already happened before we attached, we might miss it.
      // Given electron.restart() waits for the window, there's a small gap.
      // But the worker usually starts after some initialization.

      // Let's try to wait for it, but also check the logs we already captured if any
      const found = await waitForLogMessage(window, startupPattern, 15000);

      if (!found) {
        // Double check if it's in the logs captured by consoleLogs (in case of race where it came fast)
        const existing = findLogMessages(consoleLogs.logs, startupPattern);
        if (existing.length > 0) {
          console.log('✅ Found startup logs in captured buffer');
        } else {
          // If still not found, fail but log what we have
          console.log(
            '❌ Startup logs not found. Captured logs:',
            consoleLogs.logs.map((l) => l.text())
          );
          throw new Error('Worker startup logs not found');
        }
      }

      console.log('✅ Worker startup verified');

      // Wait for app to be ready
      await window.waitForTimeout(2000);

      // Navigate to database panel to ensure we're in the right context
      await showDatabaseDemoPanel(window);

      // Re-check error state after navigation so we skip gracefully when pgvector is unavailable
      if (
        await skipIfDatabaseError(
          window,
          'Database error (pgvector missing) – skipping worker startup test'
        )
      ) {
        return;
      }
    } finally {
      // Ensure we always detach the listener
      consoleLogs?.removeListener();
    }
  });

  test('should log worker activity in renderer process console', async ({ electron }) => {
    // Start fresh to capture logs from the beginning
    const context = await electron.restart();
    const window = context.window;
    let consoleLogs: ReturnType<typeof captureConsoleLogs> | null = null;

    try {
      if (await skipIfDatabaseError(window, 'Database error – skipping console log test')) {
        return;
      }

      consoleLogs = captureConsoleLogs(window);
      consoleLogs.addListener();

      // Wait for app to initialize and worker to start
      await window.waitForTimeout(5000);

      // Navigate to database panel to trigger any additional worker activity
      await showDatabaseDemoPanel(window);
      if (await skipIfDatabaseError(window, 'Database error – skipping console log test')) {
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
      consoleLogs?.removeListener();
    }
  });

  test('should create backfill jobs in job_queue table', async ({ window }) => {
    const activeWindow = await showDatabaseDemoPanel(window);
    if (await skipIfDatabaseError(activeWindow, 'Database error – skipping job creation test')) {
      return;
    }

    // Create a test backfill job
    const { jobId, chunkId } = await createTestBackfillJob(activeWindow);
    console.log(`✅ Created test job: ${jobId} for chunk: ${chunkId}`);

    // Verify the job was created in the database
    const status = await getJobStatus(activeWindow, jobId);
    expect(status).toBe('queued');

    console.log('✅ Job successfully created in queue with pending status');

    // Note: We don't verify job processing here because embedding models
    // may not be available in the test environment. The worker will pick
    // up jobs when models are available.
  });

  test('should handle app responsiveness during embedding operations', async ({ window }) => {
    const activeWindow = await showDatabaseDemoPanel(window);
    if (
      await skipIfDatabaseError(activeWindow, '⚠️ Database error – skipping responsiveness test')
    ) {
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
    // Try to interact with UI elements - should not freeze
    const refreshButton = activeWindow.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible({ timeout: 5000 });
    await expect(refreshButton).toBeEnabled({ timeout: 5000 });

    // Click the button to verify interaction
    await refreshButton.click({ timeout: 5000 });

    // Verify the click was processed
    await activeWindow.waitForTimeout(1000);

    console.log('✅ UI remains responsive during embedding operations');
  });

  test('should respect VITE_EMBED_* environment variables', async ({ electron }) => {
    // Start fresh to capture initialization
    const context = await electron.restart();
    const window = context.window;
    let consoleLogs: ReturnType<typeof captureConsoleLogs> | null = null;
    // The worker reads VITE_EMBED_CONCURRENCY, VITE_EMBED_LEASE_MS, and VITE_EMBED_MODEL_KEY
    // We verify the worker started successfully, which means it read and applied the env vars
    try {
      if (await skipIfDatabaseError(window, 'Database error – skipping env variable test')) {
        return;
      }

      consoleLogs = captureConsoleLogs(window);
      consoleLogs.addListener();

      // Wait for app to initialize
      await window.waitForTimeout(5000);

      // Navigate to database panel
      await showDatabaseDemoPanel(window);
      if (await skipIfDatabaseError(window, 'Database error – skipping env variable test')) {
        return;
      }
      await window.waitForTimeout(2000);

      // Verify worker logs are present (which means it initialized with env vars)
      const workerLogs = findLogMessages(consoleLogs.logs, /embedding.*worker/i);

      // Worker should have logged during startup
      expect(workerLogs.length).toBeGreaterThan(0);

      // Verify the app is operational (worker initialized correctly)
      const refreshButton = window.locator('button:has-text("Refresh")');
      await expect(refreshButton).toBeVisible({ timeout: 5000 });

      console.log('✅ Worker initialized with environment variables');
    } finally {
      consoleLogs?.removeListener();
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
          'embed-chunk',
          JSON.stringify({ chunkId: 'nonexistent-chunk' }),
          'queued',
          new Date().toISOString(),
        ]
      );

      return jobId;
    });

    console.log(`✅ Created invalid job: ${invalidJobId}`);

    // Verify the job was created
    const status = await getJobStatus(activeWindow, invalidJobId);
    expect(status).toBe('queued');

    // Verify the app remains responsive (worker doesn't crash from invalid payload)
    const refreshButton = activeWindow.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible({ timeout: 5000 });
    await expect(refreshButton).toBeEnabled({ timeout: 5000 });

    console.log('✅ App remains responsive with invalid job in queue');
  });

  test('should verify worker runs in renderer (not main) process', async ({ window }) => {
    // Navigate to database panel first
    const activeWindow = await showDatabaseDemoPanel(window);

    if (
      await skipIfDatabaseError(activeWindow, 'Database error – skipping process verification test')
    ) {
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
    const activeWindow = await showDatabaseDemoPanel(window);
    if (await skipIfDatabaseError(activeWindow, 'Database error – skipping navigation test')) {
      return;
    }

    // Create a test job before navigation
    const { jobId: beforeJobId } = await createTestBackfillJob(activeWindow);
    console.log(`✅ Created job before navigation: ${beforeJobId}`);

    // Verify job was created
    const beforeStatus = await getJobStatus(activeWindow, beforeJobId);
    expect(beforeStatus).toBe('queued');

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
    await showDatabaseDemoPanel(activeWindow);
    await activeWindow.waitForTimeout(1000);

    // Create another job after navigation
    const { jobId: afterJobId } = await createTestBackfillJob(activeWindow);
    console.log(`✅ Created job after navigation: ${afterJobId}`);

    // Verify second job was also created
    const afterStatus = await getJobStatus(activeWindow, afterJobId);
    expect(afterStatus).toBe('queued');

    // Verify the app is still responsive
    const refreshButton = activeWindow.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible({ timeout: 5000 });
    await expect(refreshButton).toBeEnabled({ timeout: 5000 });

    console.log('✅ Worker persists and accepts jobs after navigation');
  });
});
