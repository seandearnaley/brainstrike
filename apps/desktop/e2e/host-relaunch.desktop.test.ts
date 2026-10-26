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
 * ADR-0031 decision 4: one lock per data root, and a second owner is refused, not waited for.
 * A launch while another process holds the profile's Root opens at once and says which
 * process holds it. Once that process lets go, the next launch reaches a
 * working host thread with the conversation the first one committed.
 */
test('a launch while another process holds the profile is refused visibly; the next launch reaches a working host thread', async ({
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
  // Another live owner of the Root: this test's own process.
  const holder = await RootLock.acquire(root);
  try {
    page = (await electron.restart()).window;
    // The lock's refusal names the process that holds the Root.
    await expect(
      page.getByRole('alert').filter({ hasText: 'couldn’t check its conversation store' })
    ).toContainText(`This profile’s data is in use by another process (pid ${process.pid}).`);
  } finally {
    holder.release();
  }

  page = (await electron.restart()).window;
  await openHostThread(page);
  await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
  await expect(page.getByText('RAN_BEFORE_QUIT', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  modelProvider.setScript({ finalText: 'RAN_AFTER_RELAUNCH' });
  await runOnce(page, 'Run after relaunching.', 'RAN_AFTER_RELAUNCH');
  expect(modelProvider.refusals()).toEqual([]);
});
