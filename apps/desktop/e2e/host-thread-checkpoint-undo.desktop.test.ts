import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-checkpoint-undo';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ORIGINAL = 'original notes\n';
const REWRITTEN = 'rewritten by the host run\n';
const USER_EDIT = 'the user changed the notes after the run\n';
const REPLY = 'The notes are rewritten.';
// BST-2000: a full undo marks the run's work failed; the label says the undo happened.
const REVERTED_LABEL = 'Edits reverted · run marked failed';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = (
      window as unknown as {
        electronAPI: { db: { query: (sql: string, params: unknown[]) => Promise<unknown> } };
      }
    ).electronAPI.db;
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test('a host run’s approved file write is undone from its tool card, says so, and stays undone after reload', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-checkpoint-undo-')));
  const notes = path.join(root, 'notes.txt');
  writeFileSync(notes, ORIGINAL);
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-checkpoint-undo-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript((request) => {
      const name = request.toolNames.find((tool) => tool.endsWith('writeWorkspaceFile'));
      return name
        ? {
            finalText: REPLY,
            toolCall: { arguments: { content: REWRITTEN, path: 'notes.txt' }, name },
          }
        : { finalText: `No write tool offered: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Rewrite the notes.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    // The default `edit: ask` policy pauses the write; the file is untouched until approved.
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    await approve.click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);
    // The reply streams before its run commits run.finished, and Core refuses a
    // revert while the thread has an active run.
    await expect
      .poll(
        async () => (await readAgentHostLog(electron.getUserDataDir())).typeCounts['run.finished'],
        {
          timeout: 30_000,
        }
      )
      .toBe(1);

    // The tool card's existing Revert control is fed by the committed edit.
    const revert = region.getByTestId('checkpoint-revert');
    await expect(revert).toBeVisible({ timeout: 30_000 });
    await revert.click();
    await region.getByTestId('checkpoint-revert-confirm').click();
    await expect(region.getByTestId('checkpoint-reverted')).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    // The undo worked, and the run's label says so, never "Edit revert verdict: failed".
    await expect(region.getByTestId('run-verdict-derived')).toHaveText(REVERTED_LABEL, {
      timeout: 30_000,
    });

    // Reload: the committed log alone restores the conversation and its reverted state.
    await reloadRenderer(page, 'm3-checkpoint-undo-reload');
    await ensureAssistantShellVisible(page);
    const reloaded = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(reloaded.getByText(REPLY)).toBeVisible({ timeout: 60_000 });
    await expect(reloaded.getByTestId('checkpoint-reverted')).toBeVisible({ timeout: 30_000 });
    await expect(reloaded.getByTestId('checkpoint-revert')).toHaveCount(0);
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    await expect(reloaded.getByTestId('run-verdict-derived')).toHaveText(REVERTED_LABEL, {
      timeout: 30_000,
    });
    // The user's own 👎 outranks the derived label.
    const didNotWork = reloaded.getByRole('button', { name: "This didn't work" });
    await didNotWork.click();
    await expect(didNotWork).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(reloaded.getByTestId('run-verdict-derived')).toHaveCount(0);

    // A forced failure: a second run rewrites the file, the user changes it on disk, and Core
    // refuses the undo as a conflict. Nothing is restored, so nothing claims it was.
    await reloaded.getByRole('textbox', { name: 'Message input' }).fill('Rewrite the notes again.');
    await reloaded.getByRole('button', { exact: true, name: 'Send' }).click();
    const approveAgain = reloaded.getByRole('button', { name: /^Approve / });
    await expect(approveAgain).toBeVisible({ timeout: 90_000 });
    await approveAgain.click();
    await expect(reloaded.getByText(REPLY)).toHaveCount(2, { timeout: 90_000 });
    expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);
    await expect
      .poll(
        async () => (await readAgentHostLog(electron.getUserDataDir())).typeCounts['run.finished'],
        { timeout: 30_000 }
      )
      .toBe(2);
    writeFileSync(notes, USER_EDIT);
    await reloaded.getByTestId('checkpoint-revert').click();
    await reloaded.getByTestId('checkpoint-revert-confirm').click();
    const revertAnyway = reloaded.getByTestId('checkpoint-revert-anyway');
    await expect(revertAnyway).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(notes, 'utf8')).toBe(USER_EDIT);
    await expect(reloaded.getByTestId('run-verdict-derived')).toHaveCount(0);
    // Forcing it restores the run's baseline, and the run is marked failed like the first.
    await revertAnyway.click();
    await expect(reloaded.getByTestId('checkpoint-reverted')).toHaveCount(2, { timeout: 30_000 });
    expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
    await expect(reloaded.getByTestId('run-verdict-derived')).toHaveText(REVERTED_LABEL, {
      timeout: 30_000,
    });

    const log = await readAgentHostLog(electron.getUserDataDir());
    expect(log.typeCounts['workspace.edit.recorded']).toBe(2);
    // Three reverts committed their outcomes: the undo, the refused conflict and the forced one.
    expect(log.typeCounts['workspace.edit.reverted']).toBe(3);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
