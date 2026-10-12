import { existsSync } from 'node:fs';
import path from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/** Sends one message in the Assistant region and waits for the host's committed reply. */
async function runOnce(page: Page, prompt: string, reply: string): Promise<void> {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(prompt);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(reply, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function openHostThread(page: Page): Promise<void> {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(page);
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
}

/**
 * Quit, then reopen while the previous host is still exiting: it has removed
 * its record but still holds the profile's Root while its store closes. The new
 * Main waits for that Root, then starts its own host, instead of failing.
 */
test('relaunching while the previous host still holds the profile reaches a working host thread', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  let page = await electron.ensureWindow();
  await openHostThread(page);
  modelProvider.setScript({ finalText: 'RAN_BEFORE_QUIT' });
  await runOnce(page, 'Run before quitting.', 'RAN_BEFORE_QUIT');

  await electron.closeForStateSeeding();
  const root = path.join(electron.getUserDataDir(), 'profiles', 'test');
  expect(existsSync(path.join(root, 'lock'))).toBe(true);
  // Stands in for the exiting host: a live owner of the Root with no host record.
  const exiting = await RootLock.acquire(root);
  try {
    page = await electron.ensureWindow();
    await ensureAssistantShellVisible(page);
    // The window's host connect is pending on the held Root: no failure, no conversation yet.
    await page.waitForTimeout(3000);
    await page.screenshot({ path: test.info().outputPath('connect-pending.png') });
    await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
    await expect(page.getByRole('region', { exact: true, name: 'Assistant' })).toHaveCount(0);
  } finally {
    exiting.release();
  }
  await openHostThread(page);
  await expect(page.getByText('RAN_BEFORE_QUIT', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  modelProvider.setScript({ finalText: 'RAN_AFTER_RELAUNCH' });
  await runOnce(page, 'Run after relaunching.', 'RAN_AFTER_RELAUNCH');
  expect(modelProvider.refusals()).toEqual([]);
});
