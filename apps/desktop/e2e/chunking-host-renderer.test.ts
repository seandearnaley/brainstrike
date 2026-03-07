import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppReady } from './utils/electron-helpers';

interface ChunkingHostStatus {
  active: boolean;
  lastError: string | null;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

async function assertVisibleWindowResponsive(page: Page): Promise<void> {
  const assistantTab = page.getByRole('tab', { name: /assistant/i });
  const databaseTab = page.getByRole('tab', { name: /database/i });

  await expect(assistantTab).toBeVisible({ timeout: 10_000 });
  await expect(assistantTab).toHaveAttribute('data-state', 'active');

  const domState = await page.evaluate(() => ({
    hasRoot: Boolean(document.getElementById('root')),
    readyState: document.readyState,
  }));
  expect(domState).toEqual({
    hasRoot: true,
    readyState: 'complete',
  });

  await expect(databaseTab).toBeVisible({ timeout: 10_000 });
}

async function getChunkingHostStatus(page: Page): Promise<ChunkingHostStatus> {
  return await page.evaluate<ChunkingHostStatus>(async () => {
    const api = (
      window as Window & {
        chunkingHost?: {
          getStatus?: () => Promise<ChunkingHostStatus>;
        };
      }
    ).chunkingHost;
    if (!api?.getStatus) {
      throw new Error('Chunking host bridge is not available');
    }
    return await api.getStatus();
  });
}

test.describe('Chunking Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  test('hidden chunking host can die without reloading the visible window', async ({
    electronApp,
    window,
  }) => {
    await waitForAppReady(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('running');

    await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=chunking-host')
      );
      if (!hostWindow) {
        throw new Error('Chunking host window was not found');
      }
      hostWindow.destroy();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('stopped');

    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });
});
