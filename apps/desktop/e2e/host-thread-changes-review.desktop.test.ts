import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
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
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
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
  electron.removeAfterClose(root);
  const notes = path.join(root, 'notes.txt');
  writeFileSync(notes, ORIGINAL);
  await seedRoot(page, root, {
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
  const approve = region.getByRole('button', { name: /^Approve /u });
  await expect(approve).toBeVisible({ timeout: 90_000 });
  // The approval diffs the file as it is against what the write would leave, without writing.
  const proposed = region.getByTestId('approval-diff-view');
  await expect(proposed.getByText(ORIGINAL.trim())).toBeVisible({ timeout: 30_000 });
  await expect(proposed.getByText(REWRITTEN.trim())).toBeVisible();
  expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL);
  writeFileSync(path.join(root, 'shell-made.txt'), 'made by a shell\n');
  await approve.click();
  await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });
  expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);

  // The run's committed turn bracket: its start before the write, and its end in the
  // append that finishes the run, which lands after the streamed reply shows.
  const snapshotRows = async (): Promise<number | undefined> =>
    (await readAgentHostLog(electron.getUserDataDir())).typeCounts['workspace.snapshot.recorded'];
  await expect.poll(snapshotRows, { timeout: 30_000 }).toBe(2);

  // The turn lists its changes: the tool edit and the shell side effect, from git.
  const turnChanges = region.getByRole('region', { name: 'Changes from this turn' });
  await expect(turnChanges).toContainText('2 files changed', { timeout: 30_000 });
  await expect(turnChanges.getByText('notes.txt')).toBeVisible();
  await expect(turnChanges.getByText('shell-made.txt')).toBeVisible();
  // A file opens in place, and Review opens the turn in Changes.
  await turnChanges.getByText('notes.txt').click();
  await expect(turnChanges.getByText(REWRITTEN.trim())).toBeVisible({ timeout: 30_000 });
  await turnChanges.getByRole('button', { exact: true, name: 'Review' }).click();
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
  const approveSecond = region.getByRole('button', { name: /^Approve /u });
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
  const reloadedTurns = reloaded.getByRole('region', { name: 'Changes from this turn' });
  await expect(reloadedTurns).toHaveCount(2, { timeout: 60_000 });
  await reloadedTurns.first().getByRole('button', { exact: true, name: 'Review' }).click();
  const reloadedTree = page.getByTestId('changes-surface').getByTestId('changed-files-tree');
  await expect(reloadedTree.getByText('notes.txt')).toBeVisible({ timeout: 30_000 });
  await expect(reloadedTree.getByText('shell-made.txt')).toBeVisible();

  await expect.poll(snapshotRows, { timeout: 30_000 }).toBe(4);
  expect(modelProvider.refusals()).toEqual([]);
});

test('a comment on a Changes diff line goes into the thread’s next message', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-changes-line-comment-')));
  electron.removeAfterClose(root);
  writeFileSync(path.join(root, 'notes.txt'), ORIGINAL);
  await seedRoot(page, root, {
    reloadReason: 'changes-line-comment-root',
    rootId: randomUUID(),
  });
  await enableModel(page);
  modelProvider.setScript(writeScript('notes.txt', REWRITTEN, FIRST_REPLY));
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill('Rewrite the notes.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await region.getByRole('button', { name: /^Approve /u }).click({ timeout: 90_000 });
  await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });
  await region
    .getByRole('region', { name: 'Changes from this turn' })
    .getByRole('button', { exact: true, name: 'Review' })
    .click({ timeout: 30_000 });

  // The + on the hovered line opens a box; Ctrl+Enter keeps the comment on the diff,
  // and the toolbar adds every kept comment to the thread's message.
  const diff = page.getByTestId('changes-surface').getByTestId('diff-review');
  await diff.getByText(REWRITTEN.trim()).hover({ timeout: 30_000 });
  await diff.locator('[data-utility-button]').click();
  const box = diff.getByRole('textbox', { name: 'Comment on line 1' });
  await box.fill('Keep the original wording here.');
  await box.press('Control+Enter');
  await expect(box).toHaveCount(0);
  await expect(diff.getByRole('button', { name: 'Keep the original wording here.' })).toBeVisible();
  await page.getByRole('button', { name: 'Add 1 comment to message' }).click();
  // The message names the file and line, and quotes the line above the comment.
  await expect(input).toHaveValue(
    /^`notes\.txt` in [^,]+, line 1:\n```\nrewritten by the host run\n```\nKeep the original wording here\.$/u
  );
  await expect(diff.getByRole('button', { name: 'Keep the original wording here.' })).toHaveCount(
    0
  );

  // Sending it is an ordinary message the model receives.
  modelProvider.setScript(() => ({ finalText: 'Comment received.' }));
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText('Comment received.')).toBeVisible({ timeout: 90_000 });
  expect(
    modelProvider
      .requests()
      .some((request) =>
        JSON.stringify(request.messages).includes('Keep the original wording here.')
      )
  ).toBe(true);
  expect(modelProvider.refusals()).toEqual([]);
});
