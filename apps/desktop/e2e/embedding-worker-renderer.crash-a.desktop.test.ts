import type {
  CombinedMemorySnapshot,
  ElectronApplication,
  EmbeddingHostStatus,
  Page,
} from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  CRASH_REPRO_BACKGROUNDING_CHUNKS_PER_FILE,
  CRASH_REPRO_BACKGROUNDING_FILE_COUNT,
  CRASH_REPRO_IDLE_CHUNKS_PER_FILE,
  CRASH_REPRO_IDLE_FILE_COUNT,
  CRASH_REPRO_IDLE_POLL_COUNT,
  CRASH_REPRO_IDLE_POLL_INTERVAL_MS,
  CRASH_REPRO_IPC_CHUNKS_PER_FILE,
  CRASH_REPRO_IPC_FILE_COUNT,
  CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
  CRASH_REPRO_LARGE_FILE_COUNT,
  CRASH_REPRO_SAMPLE_COUNT,
  CRASH_REPRO_SAMPLE_INTERVAL_MS,
  CRASH_REPRO_SUSPEND_CHUNKS_PER_FILE,
  CRASH_REPRO_SUSPEND_FILE_COUNT,
  DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT,
  ERROR_LOCATOR,
  LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB,
  LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB,
  LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB,
  LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB,
  LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB,
  assertToolsPanelResponsive,
  cancelAllEmbeddingBackfillsAndDrain,
  clearEmbeddingQueue,
  createInvalidJob,
  createLargeBackfillCorpusFixture,
  createTestBackfillJob,
  ensureEmbeddingHostWarmed,
  extractUnexpectedLifecycleLogs,
  forceRendererGarbageCollection,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getEmbeddingQueueStats,
  getJobStatus,
  getMainBufferedLogs,
  getRendererTimeOrigin,
  growth,
  isDatabaseError,
  isDisposedElectronEvaluateError,
  readCombinedMemorySnapshot,
  reloadRendererInTest,
  resetEmbeddingHost,
  sampleMemoryWhileBackfillActive,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
  startBackfillViaBridge,
  stopEmbeddingHost,
  waitForBackfillButtonEnabled,
  waitForBackfillQueueMovementOrFatalError,
  waitForBridgeBackfillCompletion,
  waitForEmbeddingHostIdleAndQueueDrain,
  waitForEmbeddingHostState,
  waitForJobTerminalState,
} = shared;

test.describe('Embedding Host Renderer - crash a', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-mixed fails invalid job payloads without taking down the embedding host or visible UI', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Explicitly stop first to avoid a race between the prior test's 'stop' command and
    // our 'reset' command. Without this, startWorker can silently skip starting when
    // startingRef.current is still true from a concurrent stop/start sequence.
    await cancelAllEmbeddingBackfillsAndDrain(activeWindow);
    await stopEmbeddingHost(activeWindow);
    await activeWindow.waitForTimeout(200);
    await clearEmbeddingQueue(activeWindow);
    await resetEmbeddingHost(activeWindow);
    await waitForEmbeddingHostState(activeWindow, (status) => status.state === 'running');

    // Wait longer than the worker's initial 400ms idle poll to ensure at least
    // one poll cycle has completed, confirming the worker loop is actively running.
    await activeWindow.waitForTimeout(600);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);

    const invalidJobId = await createInvalidJob(activeWindow);

    await expect
      .poll(async () => await getJobStatus(activeWindow, invalidJobId), {
        timeout: 30_000,
      })
      .toBe('failed');

    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('running');
  });

  test('@desktop-embedding-mixed keeps the hidden host alive across visible-window navigation once started', async ({
    window,
  }) => {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await activeWindow.evaluate(async () => {
      const host = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            ensureStarted?: () => Promise<EmbeddingHostStatus>;
          };
        }
      ).embeddingHost;
      if (!host?.ensureStarted) {
        throw new Error('Embedding host bridge is not available');
      }
      await host.ensureStarted();
    });

    const hostPageBefore = await getEmbeddingHostPage(activeWindow);
    const before = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, before.jobId)).not.toBeNull();

    const promptsNav = activeWindow
      .getByRole('button', { name: /prompts/i })
      .or(activeWindow.getByRole('link', { name: /prompts/i }))
      .first();
    await expect(promptsNav).toBeVisible({ timeout: 10_000 });
    await promptsNav.click();
    await expect(activeWindow.getByRole('heading', { name: /prompt library/i })).toBeVisible({
      timeout: 15_000,
    });

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Crash-reproduction regression tests
  //
  // These tests target the recurring renderer crash during/after large embedding
  // backfills. Root causes identified:
  //   1. PGlite live query firehose → visible-ui OOM (Crash 1)
  //   2. Unprotected WebGPU session in visible-ui → GPU device invalidation (Crash 2)
  //   3. lock-screen/unlock-screen events not acted upon
  //   4. No state reconciliation after renderer reload
  //   5. embeddingBackfillsInFlight blocks re-trigger for up to 5 min
  //
  // Tests 2 and 3 require BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1 to reproduce
  // the production crash path where Chromium throttles backgrounded renderers.
  // ─────────────────────────────────────────────────────────────────────────────

  // Use 20K chunks (matching the existing passing 20K backfill test capacity).
  // 30K exceeds Chromium's per-renderer resource limits in headless test mode
  // (--disable-gpu + --no-sandbox). The production 30K crash is addressed by
  // fixes to IPC throttling, live query pausing, backgroundThrottling, and
  // lock-screen event handling — which cannot be validated at 30K scale in CI.

  async function runVisibleWindowActionWithRetry(
    app: ElectronApplication,
    action: 'blur' | 'focus' | 'minimize',
    timeoutMs = 15_000
  ): Promise<void> {
    const startedAt = Date.now();
    let lastDisposedError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        await app.evaluate(({ BrowserWindow }, nextAction) => {
          const visibleWindow = BrowserWindow.getAllWindows().find((win) => {
            const url = win.webContents.getURL();
            return !(url.includes('mode=embedding-host') || url.includes('mode=chunking-host'));
          });

          if (!visibleWindow) {
            return;
          }

          switch (nextAction) {
            case 'blur':
              visibleWindow.blur();
              return;
            case 'focus':
              visibleWindow.restore();
              visibleWindow.focus();
              return;
            case 'minimize':
              visibleWindow.minimize();
              return;
          }
        }, action);

        return;
      } catch (error) {
        if (!isDisposedElectronEvaluateError(error)) {
          throw error;
        }
        lastDisposedError = error;
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    }

    throw new Error(
      `Timed out waiting to ${action} the visible Electron window after execution-context churn: ${
        lastDisposedError?.message ?? 'unknown disposed execution context error'
      }`
    );
  }

  async function blurVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'blur');
  }

  async function minimizeVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'minimize');
  }

  async function focusVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'focus');
  }

  async function getVisibleWindowPage(app: ElectronApplication): Promise<Page> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 15_000) {
      const visiblePage = app.windows().find((page) => {
        if (page.isClosed()) {
          return false;
        }

        const url = page.url();
        return !(url.includes('mode=embedding-host') || url.includes('mode=chunking-host'));
      });

      if (visiblePage) {
        await visiblePage.waitForLoadState('domcontentloaded');
        return visiblePage;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }

    throw new Error('Timed out waiting for the visible Electron page');
  }

  async function broadcastPowerState(
    app: ElectronApplication,
    state: 'resume' | 'suspend'
  ): Promise<void> {
    await app.evaluate(({ BrowserWindow }, powerState) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('app:power-state', powerState);
        } catch {
          // Window may be destroyed
        }
      }
    }, state);
  }

  test('@desktop-embedding-crash-a renderer survives a large chunk backfill without crashing (crash repro test 1)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(600_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-large-backfill-survival');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const warmedHostPage = await ensureEmbeddingHostWarmed(activeWindow);
    const warmedBaseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      warmedHostPage,
      'crash-repro-large-post-warmup'
    );

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_LARGE_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-large-backfill-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Capture timeOrigin AFTER the intentional reload so we only detect
    // unintended crashes, not the fixture-loading reload.
    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-large-before-backfill'
    );

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);

    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample memory and assert stability throughout the backfill
    const samples = await sampleMemoryWhileBackfillActive(
      electronApp.app,
      activeWindow,
      CRASH_REPRO_SAMPLE_COUNT,
      CRASH_REPRO_SAMPLE_INTERVAL_MS
    );

    // Assert renderer did not crash/reload during sampling
    const currentTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(currentTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert embedding host is still alive
    const postStatus = await getEmbeddingHostStatus(activeWindow);
    expect(postStatus.state).not.toBe('error');

    // Assert UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Assert memory growth is bounded
    const peaks = samples.reduce(
      (current, sample) => ({
        hostHeapMB: Math.max(current.hostHeapMB, sample.snapshot.hostHeap.usedMB),
        mainRssMB: Math.max(current.mainRssMB, sample.snapshot.process.mainProcess.rssMB),
        visibleHeapMB: Math.max(current.visibleHeapMB, sample.snapshot.visibleHeap.usedMB),
      }),
      {
        hostHeapMB: baseline.hostHeap.usedMB,
        mainRssMB: baseline.process.mainProcess.rssMB,
        visibleHeapMB: baseline.visibleHeap.usedMB,
      }
    );

    console.log(
      JSON.stringify({
        baseline,
        fixture,
        peaks,
        sampleCount: samples.length,
        type: 'crash-repro-large-backfill-survival',
        warmedBaseline,
      })
    );

    expect(growth(peaks.hostHeapMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.visibleHeapMB, baseline.visibleHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainRssMB, baseline.process.mainProcess.rssMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB
    );

    // Verify some work was actually processed
    const finalQueueStats = await getEmbeddingQueueStats(activeWindow);
    expect(finalQueueStats.succeeded + finalQueueStats.running).toBeGreaterThan(0);

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a renderer survives window blur and minimize during active backfill (crash repro test 2)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-backgrounding-survival');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: CRASH_REPRO_BACKGROUNDING_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_BACKGROUNDING_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-backgrounding-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Phase 1: Blur the visible window while backfill is active
    await blurVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(15_000);

    // Phase 2: Minimize the visible window
    await minimizeVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(30_000);

    // Phase 3: Restore and focus the visible window
    await focusVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(5000);
    activeWindow = await getVisibleWindowPage(electronApp.app);

    // Assert renderer did not crash
    const postFocusTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postFocusTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert embedding host is still alive
    const hostStatus = await getEmbeddingHostStatus(activeWindow);
    expect(hostStatus.state).not.toBe('error');

    // Assert the embedding host page is still evaluatable
    const hostPage = await getEmbeddingHostPage(activeWindow);
    expect(hostPage).toBeTruthy();

    // Assert UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Assert backfill is still making progress
    const queueStats = await getEmbeddingQueueStats(activeWindow);
    expect(queueStats.succeeded + queueStats.running + queueStats.queued).toBeGreaterThan(0);

    console.log(
      JSON.stringify({
        baselineTimeOrigin,
        fixture,
        hostState: hostStatus.state,
        postFocusTimeOrigin,
        queueStats,
        type: 'crash-repro-backgrounding-survival',
      })
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a renderer stays alive for 5 minutes of idle after completing a backfill (crash repro test 3)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    // This test intentionally includes up to 4 minutes for backfill completion,
    // 2 minutes for queue drain, and a 5 minute idle observation window.
    // Keep the timeout above that combined budget so slower Linux CI does not
    // fail before the actual renderer-idle assertions run.
    test.setTimeout(780_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-idle-stability');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: CRASH_REPRO_IDLE_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_IDLE_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-idle-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Complete the backfill
    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    await waitForBridgeBackfillCompletion(activeWindow, 240_000);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);
    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baselineMemory = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-idle-baseline'
    );

    // Monitor renderer health every 30s for 5 minutes of idle
    const idleChecks: Array<{
      index: number;
      memorySnapshot: CombinedMemorySnapshot;
      rendererAlive: boolean;
    }> = [];

    for (let index = 0; index < CRASH_REPRO_IDLE_POLL_COUNT; index += 1) {
      await activeWindow.waitForTimeout(CRASH_REPRO_IDLE_POLL_INTERVAL_MS);

      const currentTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const rendererAlive = currentTimeOrigin === baselineTimeOrigin;

      const currentHostPage = await getEmbeddingHostPage(activeWindow);
      const memorySnapshot = await readCombinedMemorySnapshot(
        electronApp.app,
        activeWindow,
        currentHostPage,
        `crash-repro-idle-check-${index + 1}`
      );

      idleChecks.push({ index: index + 1, memorySnapshot, rendererAlive });

      // Assert renderer did not crash on each poll
      expect(rendererAlive).toBe(true);

      // Assert embedding host is still alive
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).not.toBe('error');

      // Assert no crash recovery logs
      const mainLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
      expect(unexpectedLogs).toHaveLength(0);
    }

    // After idle period, verify UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Verify the embedding host is still functional by processing a single job
    const verificationJob = await createTestBackfillJob(activeWindow);
    const terminalState = await waitForJobTerminalState(
      activeWindow,
      verificationJob.jobId,
      60_000
    );
    expect(terminalState).toBe('succeeded');

    // Check memory drift during idle
    const lastCheck = idleChecks.at(-1);
    if (lastCheck) {
      const hostHeapDrift = growth(
        lastCheck.memorySnapshot.hostHeap.usedMB,
        baselineMemory.hostHeap.usedMB
      );
      const mainRssDrift = growth(
        lastCheck.memorySnapshot.process.mainProcess.rssMB,
        baselineMemory.process.mainProcess.rssMB
      );

      expect(hostHeapDrift).toBeLessThan(LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB);
      expect(mainRssDrift).toBeLessThan(LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB);
    }

    console.log(
      JSON.stringify({
        allRendererAlive: idleChecks.every((check) => check.rendererAlive),
        baselineMemory,
        fixture,
        idleCheckCount: idleChecks.length,
        type: 'crash-repro-idle-stability',
      })
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a visible renderer heap stays bounded during rapid IPC progress updates (crash repro test 4)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-ipc-flood-resilience');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use minimal chunk content to maximize embedding throughput and IPC rate
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunkContentBytes: 0,
      chunksPerFile: CRASH_REPRO_IPC_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_IPC_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-ipc-flood-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-ipc-flood-baseline'
    );

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Start backfill via UI button to exercise the full progress UI path
    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample memory while the IPC flood is active
    const samples = await sampleMemoryWhileBackfillActive(
      electronApp.app,
      activeWindow,
      CRASH_REPRO_SAMPLE_COUNT,
      CRASH_REPRO_SAMPLE_INTERVAL_MS
    );

    // Assert renderer did not crash
    const postTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert UI is still responsive during/after IPC flood
    await assertToolsPanelResponsive(activeWindow);

    // Assert memory bounded
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const postGcHostPage = await getEmbeddingHostPage(activeWindow);
    const postGcSnapshot = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      postGcHostPage,
      'crash-repro-ipc-flood-post-gc'
    );

    const visibleHeapGrowth = growth(
      postGcSnapshot.visibleHeap.usedMB,
      baseline.visibleHeap.usedMB
    );
    const hostHeapGrowth = growth(postGcSnapshot.hostHeap.usedMB, baseline.hostHeap.usedMB);

    console.log(
      JSON.stringify({
        baseline,
        fixture,
        hostHeapGrowth,
        postGcSnapshot,
        sampleCount: samples.length,
        type: 'crash-repro-ipc-flood-resilience',
        visibleHeapGrowth,
      })
    );

    expect(visibleHeapGrowth).toBeLessThan(LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(hostHeapGrowth).toBeLessThan(LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB);

    // Verify queue had meaningful throughput
    for (const sample of samples) {
      expect(sample.queueStats.running).toBeLessThanOrEqual(DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT);
    }

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a embedding host stays functional across simulated power suspend/resume cycles (crash repro test 5)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-suspend-resume');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      chunksPerFile: CRASH_REPRO_SUSPEND_CHUNKS_PER_FILE,
      fileCount: CRASH_REPRO_SUSPEND_FILE_COUNT,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-suspend-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Complete a backfill first
    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    await waitForBridgeBackfillCompletion(activeWindow, 240_000);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Run 3 suspend/resume cycles
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      // Simulate suspend
      await broadcastPowerState(electronApp.app, 'suspend');
      await activeWindow.waitForTimeout(5000);

      // Simulate resume (production uses a 2s delay)
      await broadcastPowerState(electronApp.app, 'resume');
      await activeWindow.waitForTimeout(3000);

      // Assert renderer did not crash
      const cycleTimeOrigin = await getRendererTimeOrigin(activeWindow);
      expect(cycleTimeOrigin).toBe(baselineTimeOrigin);

      // Assert embedding host is still alive
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).not.toBe('error');

      // Assert no crash recovery logs
      const mainLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
      expect(unexpectedLogs).toHaveLength(0);
    }

    // After all cycles, verify the embedding pipeline is still functional
    await assertToolsPanelResponsive(activeWindow);

    const verificationJob = await createTestBackfillJob(activeWindow);
    const terminalState = await waitForJobTerminalState(
      activeWindow,
      verificationJob.jobId,
      60_000
    );
    expect(terminalState).toBe('succeeded');

    console.log(
      JSON.stringify({
        cyclesCompleted: 3,
        fixture,
        type: 'crash-repro-suspend-resume',
        verificationJobState: terminalState,
      })
    );

    await electronHarness.restart();
  });
});
