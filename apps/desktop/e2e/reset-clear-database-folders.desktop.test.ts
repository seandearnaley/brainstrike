/**
 * ADR-0015, ADR-0034: Clear Database archives every managed worktree into its repository before
 * it deletes the worktree ledger, and once it has cleared moves every scratch folder to the Trash.
 *
 * Drives the built app over a disposable profile, a real repository and real git. Threads A and
 * A2, sent with no folder open, work in scratch folders; after a relaunch only A2's, opened again,
 * is mounted (BST-2512). Thread B works in the repository and, once its run ends, moves into a
 * managed worktree through the where-control. Test mode's Trash is the test's own folder
 * (`BRAINSTRIKE_E2E_TRASH_DIR`), never the machine's. Only the model is scripted.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { createAndUseWorktree } from './utils/create-worktree';
import { git, initRepo, listWorktreePaths } from './utils/git-fixtures';
import { clearDatabaseRecords, ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';
import { openFolderRows, whereChip } from './utils/where-control';
import { readActiveManagedWorktrees } from './utils/worktree-ledger';

const REPLY = 'Done for now.';

// Each test's managed worktrees go to a folder of its own, made before its app launches. Its real
// path, as the where-control, the ledger and `git worktree list` all name a worktree by it.
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

  // One click makes the worktree with the defaults: the repository has no setup script to answer.
  const { branch, worktreePath } = await createAndUseWorktree(thread);
  return { branch, path: worktreePath };
}

test('Clear Database archives a managed worktree into its repository and moves every scratch folder, mounted or not, to the Trash @destructive @desktop-db-storage', async ({
  electron,
  modelProvider,
  window,
}) => {
  let page = window;
  await configureAssistantProvider(page);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? REPLY : 'Reset folders',
  }));
  await ensureAssistantShellVisible(page);
  const userData = electron.getUserDataDir();
  const scratch = path.join(userData, 'scratch');
  const trash = electron.getTrashDirectory();

  // Threads A and A2, each sent with no folder open, work in scratch folders the host makes.
  const scratchThread = await startThread(page, 'Work anywhere.');
  await expect(scratchThread.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const [scratchFolder] = await readdir(scratch);
  const otherThread = await startThread(page, 'Work anywhere else.');
  await expect(otherThread.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const scratchFolders = (await readdir(scratch)).sort();
  const otherFolder = scratchFolders.find((folder) => folder !== scratchFolder);
  expect(scratchFolders).toHaveLength(2);

  // After a relaunch neither is mounted until its thread opens (BST-2512). Thread A2, opened, mounts
  // its folder; A's stays unmounted, so the clear finds one of each.
  page = (await electron.restart()).window;
  await ensureAssistantShellVisible(page);
  await page.getByTestId('threads-panel').getByTitle(`Scratch folder ${otherFolder} at `).click();
  await expect(page.getByTestId('single-root-header-row')).toContainText(`${otherFolder} · Local`, {
    timeout: 30_000,
  });
  const scratchStatus = Object.fromEntries(
    (await readHostRootRecords(userData)).map((root) => [root.displayName, root.status])
  );
  expect([scratchStatus[scratchFolder ?? ''], scratchStatus[otherFolder ?? '']]).toEqual([
    'disconnected',
    'live',
  ]);

  // Thread B works in a real repository, then in a managed worktree of it.
  const repo = initRepo(electron.getWorkspaceRoot());
  const worktree = await threadInManagedWorktree(page, repo);
  expect(listWorktreePaths(repo)).toContain(worktree.path);
  expect(await readActiveManagedWorktrees(userData)).toEqual([
    expect.objectContaining({ branch: worktree.branch, path: worktree.path }),
  ]);
  expect((await readdir(scratch)).sort()).toEqual(scratchFolders);
  expect(await readdir(trash)).toEqual([]);

  // The replacement window tells the person what the clear did with both, once, as it starts.
  const notices = page.getByRole('region', { name: /^Notifications/u }).getByRole('listitem');
  await Promise.all([
    clearDatabaseRecords(page),
    expect(notices.filter({ hasText: '1 worktree archived into its repository' })).toBeVisible({
      timeout: 60_000,
    }),
    expect(notices.filter({ hasText: '2 scratch folders moved to the Trash' })).toBeVisible({
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
  // Both scratch folders left the profile for the test's Trash.
  expect(await readdir(scratch)).toEqual([]);
  expect((await readdir(trash)).sort()).toEqual(scratchFolders);
  expect(modelProvider.refusals()).toEqual([]);
});
