import type { ElectronApplication, Page } from './embedding-worker-renderer.shared';
import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';
import { HomePage } from './page-objects/home-page';

const {
  ensureEmbeddingHostStarted,
  extractUnexpectedLifecycleLogs,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getMainBufferedLogs,
  getRendererTimeOrigin,
  requestLocalQueryEmbedding,
  setVectorDevicePreference,
  showDatabaseDemoPanel,
} = shared;

async function expectHostEmbedsQuery(window: Page): Promise<void> {
  const result = await requestLocalQueryEmbedding(window);
  if (!result.ok) {
    throw new Error(`Local query embedding failed: ${JSON.stringify(result.error)}`);
  }
  expect(result.value).toHaveLength(384);
  expect(result.value.every(Number.isFinite)).toBe(true);
}

/** Starts the hidden host on WASM and proves it embeds; returns the runtime that did. */
async function startHostWithWorkingRuntime(window: Page): Promise<string> {
  // CI disables the GPU, so an unconfigured host refuses automatic WebGPU.
  await setVectorDevicePreference(window, 'wasm');
  expect(await ensureEmbeddingHostStarted(window)).toMatchObject({
    lastError: null,
    state: 'running',
  });
  await expectHostEmbedsQuery(window);
  const status = await getEmbeddingHostStatus(window);
  expect(status.runtimeId).not.toBe('');
  return status.runtimeId;
}

async function broadcastPowerState(
  app: ElectronApplication,
  state: 'resume' | 'suspend'
): Promise<void> {
  // The same broadcast Main sends on powerMonitor suspend/resume; the hidden host
  // forwards it to its worker.
  await app.evaluate(({ BrowserWindow }, powerState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:power-state', powerState);
      }
    }
  }, state);
}

test.describe('Embedding Host Renderer - lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-embedding-lifecycle keeps the started hidden host and its runtime across visible-window navigation', async ({
    window,
  }) => {
    test.setTimeout(180_000);
    let activeWindow = await showDatabaseDemoPanel(window);
    const runtimeId = await startHostWithWorkingRuntime(activeWindow);
    const hostPage = await getEmbeddingHostPage(activeWindow);
    const hostTimeOrigin = await getRendererTimeOrigin(hostPage);
    const visibleTimeOrigin = await getRendererTimeOrigin(activeWindow);

    await activeWindow.getByTestId('prompts-tab-trigger').click();
    await expect(activeWindow.getByRole('region', { name: 'Prompt workbench' })).toBeVisible({
      timeout: 15_000,
    });
    const home = new HomePage(activeWindow);
    await home.openSettings();
    await home.leaveSettings();
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Same document, same host document, same runtime: navigation reached neither.
    expect(await getRendererTimeOrigin(activeWindow)).toBe(visibleTimeOrigin);
    expect(await getEmbeddingHostPage(activeWindow)).toBe(hostPage);
    expect(await getRendererTimeOrigin(hostPage)).toBe(hostTimeOrigin);
    await expectHostEmbedsQuery(activeWindow);
    expect(await getEmbeddingHostStatus(activeWindow)).toMatchObject({
      lastError: null,
      runtimeId,
      state: 'running',
    });
  });

  test('@desktop-embedding-lifecycle keeps the hidden host embedding across power suspend and resume', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(180_000);
    const runtimeId = await startHostWithWorkingRuntime(window);
    const hostPage = await getEmbeddingHostPage(window);
    const hostTimeOrigin = await getRendererTimeOrigin(hostPage);
    const visibleTimeOrigin = await getRendererTimeOrigin(window);

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await broadcastPowerState(electronApp.app, 'suspend');
      await window.waitForTimeout(1000);
      await broadcastPowerState(electronApp.app, 'resume');
      await window.waitForTimeout(1000);

      expect(await getRendererTimeOrigin(window)).toBe(visibleTimeOrigin);
      expect(await getRendererTimeOrigin(hostPage)).toBe(hostTimeOrigin);
      expect(await getEmbeddingHostStatus(window)).toMatchObject({
        lastError: null,
        runtimeId,
        state: 'running',
      });
      expect(extractUnexpectedLifecycleLogs(await getMainBufferedLogs(window))).toEqual([]);
    }

    await expectHostEmbedsQuery(window);
    expect((await getEmbeddingHostStatus(window)).runtimeId).toBe(runtimeId);
  });
});
