/**
 * Desktop E2E: opening a thread reconnects the folders it works in. Opening another folder
 * replaces the workspace's folders, so returning to a thread bound to the first one mounts it
 * again, and its file tab loads after a restart instead of waiting on a folder that never comes.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const API_KEY = 'test-key-thread-reconnects-folders';
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function send(page: Page, prompt: string): Promise<void> {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill(prompt);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(`${prompt} REPLY`)).toBeVisible({ timeout: 90_000 });
}

test('returning to a thread reconnects its folder and its file opens after a restart', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  writeFileSync(path.join(alphaRoot, 'alpha-file.txt'), 'ALPHA CONTENT\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-thread-reconnect-')));
  writeFileSync(path.join(bravoRoot, 'bravo-file.txt'), 'BRAVO CONTENT\n');
  try {
    modelProvider.setScript((request) => {
      const prompt = /THREAD_(ONE|TWO)/u.exec(JSON.stringify(request.messages))?.at(-1);
      return { finalText: `THREAD_${prompt ?? 'ONE'} REPLY` };
    });
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-file.txt').first()).toBeVisible({ timeout: 60_000 });
    await configureAssistantProvider(page, {
      apiKey: API_KEY,
      compositeModelKey: MODEL,
      provider: 'openrouter',
    });
    await ensureAssistantShellVisible(page);
    await enableAssistantCatalogModel(page, MODEL);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await chooseThreadFolder(region, path.basename(alphaRoot));
    await send(page, 'THREAD_ONE');
    await page.getByText('alpha-file.txt', { exact: true }).first().dblclick();
    await expect(page.getByText('ALPHA CONTENT').first()).toBeVisible({ timeout: 30_000 });

    // Opening folder B replaces A, and a second thread works in B.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Open folder');
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: /Files/u }).first().click();
    await expect(page.getByText('bravo-file.txt').first()).toBeVisible({ timeout: 30_000 });
    const folderRow = (root: string) =>
      page.getByTestId('root-section-header-row').filter({ hasText: path.basename(root) });
    await expect(folderRow(alphaRoot)).toHaveCount(0);
    await page.getByTestId('assistant-new-thread-button').click();
    await chooseThreadFolder(region, path.basename(bravoRoot));
    await send(page, 'THREAD_TWO');

    // Back on thread one, A is open again beside B.
    await page.locator('[id^="assistant-thread-tab-"]').first().click();
    await expect(folderRow(alphaRoot)).toHaveCount(1, { timeout: 30_000 });
    await expect(folderRow(bravoRoot)).toHaveCount(1);

    // After a restart the restored file tab loads its content.
    const restarted = (await electron.restart()).window;
    await restarted
      .getByRole('tab', { name: /alpha-file/u })
      .first()
      .click();
    await expect(restarted.getByText('ALPHA CONTENT').first()).toBeVisible({ timeout: 60_000 });
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
