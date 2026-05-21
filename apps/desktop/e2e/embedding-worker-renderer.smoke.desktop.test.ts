import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT,
  ERROR_LOCATOR,
  assertToolsPanelResponsive,
  clearEmbeddingQueue,
  countRecordsContainingText,
  createLargeBackfillFixture,
  createTestBackfillJob,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getEmbeddingQueueStats,
  getRendererLogRecords,
  isDatabaseError,
  recordContainsText,
  reloadRendererInTest,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  waitForActiveProcessingOrFatalError,
  waitForAppReadyInTest,
  waitForBackfillButtonEnabled,
  waitForBoundedBackfillEnqueueOrFatalError,
} = shared;

test.describe('Embedding Host Renderer - smoke', () => {
  test('@desktop-embedding-lifecycle defers hidden embedding host startup until first use', async ({
    electron,
  }) => {
    const context = await electron.restart();
    const window = context.window;
    await waitForAppReadyInTest(window);

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

  test('@desktop-embedding-lifecycle keeps the visible UI responsive while jobs are queued for the hidden host', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await setVectorDevicePreference(activeWindow, 'wasm');
    const jobs = await Promise.all([
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
    ]);

    expect(jobs).toHaveLength(3);
    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    if (status.state === 'error') {
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      return;
    }

    expect(status.state).toBe('running');
  });

  test('@desktop-embedding-backfill keeps the visible UI responsive while a large backfill is being enqueued', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    const fixture = await createLargeBackfillFixture(activeWindow, 160);
    await reloadRendererInTest(activeWindow, 'embedding-worker-large-backfill-fixture');
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

  test('@desktop-embedding-backfill keeps the visible UI responsive while the hidden host is actively processing a backfill', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    const fixture = await createLargeBackfillFixture(activeWindow, 96, { persistActiveSet: false });
    await reloadRendererInTest(activeWindow, 'embedding-worker-host-processing-fixture');
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
      expect(queueStats.running).toBeLessThanOrEqual(DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT);
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
});
