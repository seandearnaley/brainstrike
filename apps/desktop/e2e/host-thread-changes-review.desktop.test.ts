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
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-changes-review';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ORIGINAL = 'original notes\n';
const REWRITTEN = 'rewritten by the host run\n';
const FIRST_REPLY = 'The notes are rewritten.';
const SECOND_REPLY = 'The extra file is written.';

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

/** One scripted write through the native write tool, then a final answer. */
function writeScript(file: string, content: string, reply: string) {
  return (request: ModelProviderRequest) => {
    const name = request.toolNames.find((tool) => tool.endsWith('writeWorkspaceFile'));
    return name
      ? { finalText: reply, toolCall: { arguments: { content, path: file }, name } }
      : { finalText: `No write tool offered: ${request.toolNames.join(', ')}` };
  };
}

test('a host run is reviewed in Changes from its turn snapshots, and "Last Turn" follows the next run live', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-changes-review-')));
  const notes = path.join(root, 'notes.txt');
  writeFileSync(notes, ORIGINAL);
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-changes-review-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript(writeScript('notes.txt', REWRITTEN, FIRST_REPLY));
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Rewrite the notes.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    // While the write waits on approval, a change no tool made lands in the workspace.
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    writeFileSync(path.join(root, 'shell-made.txt'), 'made by a shell\n');
    await approve.click();
    await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);

    // The run's committed turn bracket: its start before the write, and its end in the
    // append that finishes the run, which lands after the streamed reply shows.
    const snapshotRows = async (): Promise<number | undefined> =>
      (await readAgentHostLog(electron.getUserDataDir())).typeCounts['workspace.snapshot.recorded'];
    await expect.poll(snapshotRows, { timeout: 30_000 }).toBe(2);

    // "→ Review" opens the run's changeset: the tool edit and the shell side effect.
    const review = region.getByTestId('changes-review-link');
    await expect(review).toHaveText(/1 file edit from this turn/, { timeout: 30_000 });
    await review.click();
    const surface = page.getByTestId('changes-surface');
    const tree = surface.getByTestId('changed-files-tree');
    await expect(tree.getByText('notes.txt')).toBeVisible({ timeout: 30_000 });
    await expect(tree.getByText('shell-made.txt')).toBeVisible();

    // "Last Turn" is the host thread's newest run, so picking it keeps this view.
    await surface.getByTestId('changeset-source-picker-trigger').click();
    await page.getByTestId('changeset-source-last-turn').click();
    await expect(tree.getByText('notes.txt')).toBeVisible({ timeout: 30_000 });

    // The next run retargets "Last Turn" as it starts, and its committed write refreshes it.
    modelProvider.setScript(writeScript('extra.txt', 'extra content\n', SECOND_REPLY));
    await region.getByRole('textbox', { name: 'Message input' }).fill('Add the extra file.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    const approveSecond = region.getByRole('button', { name: /^Approve / });
    await expect(approveSecond).toBeVisible({ timeout: 90_000 });
    await expect(surface.getByTestId('changed-files-tree-empty')).toBeVisible({ timeout: 30_000 });
    await approveSecond.click();
    await expect(region.getByText(SECOND_REPLY)).toBeVisible({ timeout: 90_000 });
    await expect(tree.getByText('extra.txt')).toBeVisible({ timeout: 30_000 });
    await expect(tree.getByText('notes.txt')).toHaveCount(0);

    // Reload: the committed log alone brings back the first run's review.
    await reloadRenderer(page, 'm3-changes-review-reload');
    await ensureAssistantShellVisible(page);
    const reloaded = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(reloaded.getByTestId('changes-review-link')).toHaveCount(2, { timeout: 60_000 });
    await reloaded.getByTestId('changes-review-link').first().click();
    const reloadedTree = page.getByTestId('changes-surface').getByTestId('changed-files-tree');
    await expect(reloadedTree.getByText('notes.txt')).toBeVisible({ timeout: 30_000 });
    await expect(reloadedTree.getByText('shell-made.txt')).toBeVisible();

    await expect.poll(snapshotRows, { timeout: 30_000 }).toBe(4);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
