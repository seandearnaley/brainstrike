/**
 * ADR-0015, ADR-0034: Clear Database archives every managed worktree into its repository before
 * it deletes the worktree ledger, and once it has cleared moves every scratch folder to the Trash.
 *
 * Drives the built app over a disposable profile, a real repository and real git. Thread A, sent
 * with no folder open, works in a scratch folder. Thread B works in the repository and, once its
 * run ends, moves into a managed worktree through the where-control. Test mode's Trash is the
 * test's own folder (`BRAINSTRIKE_E2E_TRASH_DIR`), never the machine's. Only the model is scripted.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { git, initRepo, listWorktreePaths } from './utils/git-fixtures';
import { clearDatabaseRecords, ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';
import { openFolderRows, openWhereMenu, whereChip } from './utils/where-control';
import { readActiveManagedWorktrees } from './utils/worktree-ledger';

const REPLY = 'Done for now.';

// Each test's managed worktrees go to a folder of its own, made before its app launches. Its real
// path, as the create sheet, the ledger and `git worktree list` all name a worktree by it.
test.use({
  electronEnv: async ({}, use) => {
    const managed = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-reset-clear-worktrees-')));
    try {
      await use({ BRAINSTRIKE_E2E_WORKTREE_DIR: managed });
    } finally {
      rmSync(managed, { force: true, recursive: true });
    }
  },
});

interface ManagedWorktree {
  readonly branch: string;
  readonly path: string;
}

/**
 * A new thread works in `repo`, which Add folder… opens (test mode's picker answers the harness's
 * workspace folder). Once its run ends it moves into a new managed worktree from the where-control.
 */
async function threadInManagedWorktree(page: Page, repo: string): Promise<ManagedWorktree> {
  const welcome = page.getByTestId('new-thread-welcome');
  if (!(await welcome.isVisible())) {
    await page.getByTestId('assistant-new-thread-button').click();
  }
  await openFolderRows(welcome);
  await page.getByTestId('workspace-bar-add-folder').click();
  await expect(whereChip(welcome)).toHaveAccessibleName(
    `Where this thread works: ${path.basename(repo)} · Local`,
    { timeout: 60_000 }
  );
  const thread = await startThread(page, 'Work in the repository.');
  await expect(thread.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  // The pane leaves the running state once the host has committed the run's end.
  await expect(thread.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);

  await openWhereMenu(thread);
  const newWorktree = page.getByTestId('workspace-bar-mode-new-worktree');
  await expect(newWorktree).not.toHaveAttribute('data-disabled', { timeout: 30_000 });
  await newWorktree.click();
  const dialog = page.getByTestId('worktree-create-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const branchField = dialog.getByTestId('worktree-create-branch');
  await expect(branchField).toHaveValue(/^bs\/.+/u);
  const branch = (await branchField.inputValue()).trim();
  const name = (await dialog.getByTestId('worktree-create-name').inputValue()).trim();
  const worktreePath = (await dialog.getByTestId('worktree-create-location').innerText()).trim();
  await dialog.getByTestId('worktree-create-submit').click();
  const chip = whereChip(thread);
  await expect(chip).toContainText(name, { timeout: 90_000 });
  await expect(chip).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  await expect(dialog).toBeHidden();
  return { branch, path: worktreePath };
}

test('Clear Database archives a managed worktree into its repository and moves a scratch folder to the Trash @destructive @desktop-db-storage', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  await configureAssistantProvider(page);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? REPLY : 'Reset folders',
  }));
  await ensureAssistantShellVisible(page);
  const userData = electron.getUserDataDir();
  const scratch = path.join(userData, 'scratch');
  const trash = electron.getTrashDirectory();

  // Thread A, sent with no folder open, works in a scratch folder the host makes for it.
  const scratchThread = await startThread(page, 'Work anywhere.');
  await expect(scratchThread.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const [scratchFolder, ...otherScratch] = await readdir(scratch);
  expect(otherScratch).toEqual([]);

  // Thread B works in a real repository, then in a managed worktree of it.
  const repo = initRepo(electron.getWorkspaceRoot());
  const worktree = await threadInManagedWorktree(page, repo);
  expect(listWorktreePaths(repo)).toContain(worktree.path);
  expect(await readActiveManagedWorktrees(userData)).toEqual([
    expect.objectContaining({ branch: worktree.branch, path: worktree.path }),
  ]);
  expect(await readdir(scratch)).toEqual([scratchFolder]);
  expect(await readdir(trash)).toEqual([]);

  // The replacement window tells the person what the clear did with both, once, as it starts.
  const notices = page.getByRole('region', { name: /^Notifications/u }).getByRole('listitem');
  await Promise.all([
    clearDatabaseRecords(page),
    expect(notices.filter({ hasText: '1 worktree archived into its repository' })).toBeVisible({
      timeout: 60_000,
    }),
    expect(notices.filter({ hasText: '1 scratch folder moved to the Trash' })).toBeVisible({
      timeout: 60_000,
    }),
  ]);

  // The worktree is archived: its folder and git's registration are gone, and its snapshot ref
  // and branch keep its work in the repository.
  expect(listWorktreePaths(repo)).not.toContain(worktree.path);
  expect(existsSync(worktree.path)).toBe(false);
  expect(
    git(repo, ['for-each-ref', '--format=%(refname)', 'refs/brainstrike/worktree-archive'])
      .split(/\r?\n/u)
      .filter(Boolean)
  ).toEqual([expect.stringMatching(/^refs\/brainstrike\/worktree-archive\//u)]);
  expect(
    git(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${worktree.branch}`]).trim()
  ).toBe(`refs/heads/${worktree.branch}`);
  // The scratch folder left the profile for the test's Trash.
  expect(await readdir(scratch)).toEqual([]);
  expect(await readdir(trash)).toEqual([scratchFolder]);
  expect(modelProvider.refusals()).toEqual([]);
});
