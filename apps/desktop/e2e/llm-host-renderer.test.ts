import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface LlmHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: 'llm-host';
  readonly state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface LlmHostBridge {
  ensureStarted?: () => Promise<LlmHostStatus>;
  getStatus?: () => Promise<LlmHostStatus>;
}

async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

async function getLlmHostBridge(page: Page): Promise<LlmHostStatus> {
  return await page.evaluate(async () => {
    const api = (
      window as Window & {
        llmHost?: LlmHostBridge;
      }
    ).llmHost;
    if (!api?.getStatus) {
      throw new Error('LLM host bridge is not available');
    }
    return await api.getStatus();
  });
}

async function ensureLlmHostStarted(page: Page): Promise<LlmHostStatus> {
  return await page.evaluate(async () => {
    const api = (
      window as Window & {
        llmHost?: LlmHostBridge;
      }
    ).llmHost;
    if (!api?.ensureStarted) {
      throw new Error('LLM host bridge is not available');
    }
    return await api.ensureStarted();
  });
}

async function assertVisibleWindowResponsive(page: Page): Promise<void> {
  const rootState = await page.evaluate(() => ({
    hasRoot: Boolean(document.getElementById('root')),
    readyState: document.readyState,
  }));

  expect(rootState).toEqual({
    hasRoot: true,
    readyState: 'complete',
  });
  await expect(page.getByTestId('assistant-chat-card')).toBeVisible({ timeout: 10_000 });
}

test.describe('LLM Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  test('@desktop-llm-host-recovery hidden llm host can restart without reloading the visible window', async ({
    electronApp,
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    await expect.poll(async () => (await ensureLlmHostStarted(window)).state).toBe('running');
    const firstStatus = await getLlmHostBridge(window);

    await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=llm-host')
      );
      if (!hostWindow) {
        throw new Error('LLM host window was not found');
      }
      hostWindow.destroy();
    });

    await expect.poll(async () => (await getLlmHostBridge(window)).state).toBe('stopped');
    await assertVisibleWindowResponsive(window);
    expect(await window.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigin);

    await expect.poll(async () => (await ensureLlmHostStarted(window)).state).toBe('running');
    const restartedStatus = await getLlmHostBridge(window);

    expect(restartedStatus.runtimeKind).toBe('llm-host');
    expect(restartedStatus.runtimeId).not.toBe(firstStatus.runtimeId);
    await assertVisibleWindowResponsive(window);
    expect(await window.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigin);
  });
});
