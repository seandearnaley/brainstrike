import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-ledger-edits';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const REPLY = 'The notes are rewritten.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test("a host run's edit and its revert count in the Task Ledger, and its cost under its root", async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-ledger-edits-')));
  writeFileSync(path.join(root, 'notes.txt'), 'original notes\n');
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-ledger-edits-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript((request) => {
      const name = request.toolNames.find((tool) => tool.endsWith('writeWorkspaceFile'));
      return name
        ? {
            finalText: REPLY,
            toolCall: { arguments: { content: 'rewritten\n', path: 'notes.txt' }, name },
          }
        : { finalText: `No write tool offered: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Rewrite the notes.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    // The default `edit: ask` policy pauses the write.
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    await approve.click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    await region.getByTestId('checkpoint-revert').click();
    await region.getByTestId('checkpoint-revert-confirm').click();
    await expect(region.getByTestId('checkpoint-reverted')).toBeVisible({ timeout: 30_000 });

    await new HomePage(page).openSettings();
    const cost = await new SettingsPage(page).openCategory(/Cost Tracking/i, 'cost-tracking');
    const run = cost
      .getByTestId('task-ledger-panel')
      .getByTestId('task-ledger-run-row')
      .filter({ hasText: MODEL });
    await expect(run).toHaveCount(1, { timeout: 30_000 });
    await expect(run.getByTestId('task-ledger-reverted-edits')).toHaveText('1 reverted');
    // The run's provider calls count under the root it was bound to at Send.
    const rootRow = cost.getByTestId('cost-aggregation-row');
    await expect(rootRow).toHaveCount(1, { timeout: 30_000 });
    await expect(rootRow).toContainText(path.basename(root));
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
