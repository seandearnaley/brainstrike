import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { RootLock } from '@brainstrike/state-store';
import type { ElectronApplication, Page } from '@playwright/test';
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
  const acquired = Promise.withResolvers<ElectronApplication>();
  let settled = false;
  // Bootstrap waits for profile acquisition before creating its first window.
  // Observe the real Main launch without waiting on the Root this test holds.
  const reopening = electron
    .restart((app) => acquired.resolve(app))
    .then(
      (context) => {
        settled = true;
        return { context, kind: 'ready' as const };
      },
      (error: unknown) => {
        settled = true;
        return { error, kind: 'failed' as const };
      }
    );
  let result: Awaited<typeof reopening>;
  try {
    const started = await Promise.race([
      acquired.promise.then((app) => ({ app, kind: 'acquired' as const })),
      reopening,
    ]);
    if (started.kind === 'failed') {
      throw started.error;
    }
    if (started.kind !== 'acquired') {
      throw new Error('The relaunch completed before reporting its Main process.');
    }
    await setTimeout(3000);
    // A held Root keeps startup pending, with no conversation or error window.
    expect(settled).toBe(false);
    expect(started.app.windows()).toHaveLength(0);
    expect(started.app.process().exitCode).toBeNull();
  } finally {
    exiting.release();
    result = await reopening;
  }
  if (result.kind === 'failed') {
    throw result.error;
  }
  page = result.context.window;
  await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
  await openHostThread(page);
  await expect(page.getByText('RAN_BEFORE_QUIT', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  modelProvider.setScript({ finalText: 'RAN_AFTER_RELAUNCH' });
  await runOnce(page, 'Run after relaunching.', 'RAN_AFTER_RELAUNCH');
  expect(modelProvider.refusals()).toEqual([]);
});
