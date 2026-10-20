/**
 * Desktop E2E: a thread working in a new worktree can grep it.
 *
 * The index leaves a managed worktree out until it is opted in (BST-1988), and
 * a bound thread greps every one of its folders (BST-1990). Main refused the
 * unindexed worktree, which failed every agent grep in worktree mode
 * (2026-10-20 debug pack). The repository is indexed, the worktree is not,
 * and the agent's grep still finds a file that exists only in the worktree.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { initRepo } from './utils/git-fixtures';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { chooseTextSearch, textReadiness } from './utils/text-search-mode';

const API_KEY = 'test-key-worktree-thread-grep';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const MARKER = 'worktree-only-marker-4066';
const REPLY = 'The worktree grep ran.';
// Canonical up front: macOS tmpdir is a symlink, and worktree creation realpaths it.
const managedDirectory = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'bst-worktree-thread-grep-'))
);

test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_WORKTREE_DIR: managedDirectory,
    BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY,
  },
});

test.afterAll(() => {
  rmSync(managedDirectory, { force: true, recursive: true });
});

async function enableChatModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    if (!window.modelCatalog) {
      throw new Error('Desktop model catalog is unavailable');
    }
    const result = await window.modelCatalog.setModels([model], true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }, MODEL);
}

/** The composer's New worktree flow; returns the created worktree's folder. */
async function workInNewWorktree(page: Page): Promise<string> {
  await page.getByTestId('workspace-bar-mode-chip').click();
  await page.getByTestId('workspace-bar-mode-new-worktree').click();
  const dialog = page.getByTestId('worktree-create-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const name = (await dialog.getByTestId('worktree-create-name').inputValue()).trim();
  const worktreePath = (await dialog.getByTestId('worktree-create-location').innerText()).trim();
  await dialog.getByTestId('worktree-create-submit').click();
  await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
    timeout: 90_000,
  });
  return worktreePath;
}

test('an agent in a new worktree greps the unindexed worktree', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  const root = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(root).not.toBe('');
  initRepo(root);
  try {
    await chooseTextSearch(page);
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('hello.ts').first()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => textReadiness(page), { timeout: 120_000 })
      .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
    await enableChatModel(page);

    await ensureAssistantShellVisible(page);
    await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
    const worktreePath = await workInNewWorktree(page);
    writeFileSync(path.join(worktreePath, 'only-in-worktree.txt'), `${MARKER}\n`);
    // Mounting the worktree reopens the index, which settles with the worktree
    // left out: only the repository is indexed.
    await expect
      .poll(() => textReadiness(page), { timeout: 60_000 })
      .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });

    modelProvider.setScript((request) => {
      const grep = request.toolNames.find((tool) => tool.endsWith('grepSearch'));
      return grep
        ? {
            finalText: REPLY,
            toolCall: { arguments: { outputMode: 'files', pattern: MARKER }, name: grep },
          }
        : { finalText: `No grep tool offered: ${request.toolNames.join(', ')}` };
    });
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Find the marker.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    await expect
      .poll(async () => (await readCommittedRuns(electron.getUserDataDir(), threadId))[0]?.status, {
        timeout: 30_000,
      })
      .toBe('completed');
    const [run] = await readCommittedRuns(electron.getUserDataDir(), threadId);
    expect(run?.results[0]?.output).toMatchObject({
      files: [expect.objectContaining({ path: 'only-in-worktree.txt', source: 'live' })],
      outputMode: 'files',
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
  }
});
