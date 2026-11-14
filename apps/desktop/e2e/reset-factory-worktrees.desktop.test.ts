/**
 * ADR-0015, ADR-0034: Factory Reset archives every managed worktree into its repository before it
 * deletes the state DB that holds the worktree ledger.
 *
 * Drives the built app over a disposable profile, a real repository and real git. A thread works
 * in the repository and, once its run ends, moves into a managed worktree through the
 * where-control. Only the model is scripted.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { createAndUseWorktree } from './utils/create-worktree';
import { git, initRepo, listWorktreePaths } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { startThread } from './utils/new-thread';
import { openFolderRows, whereChip } from './utils/where-control';
import { readActiveManagedWorktrees } from './utils/worktree-ledger';

const REPLY = 'Done for now.';

// Each test's managed worktrees go to a folder of its own, made before its app launches. Its real
// path, as the where-control, the ledger and `git worktree list` all name a worktree by it.
test.use({
  electronEnv: async ({}, use) => {
    const managed = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-reset-factory-worktrees-')));
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

test.describe('Factory Reset worktrees (desktop) @destructive @desktop-ipc-reset', () => {
  test.skip(
    process.platform === 'win32',
    'Windows Factory Reset is disabled for M3 by owner decision.'
  );

  test('Factory Reset archives a managed worktree into its repository', async ({
    electron,
    modelProvider,
    window: page,
  }) => {
    await configureAssistantProvider(page);
    modelProvider.setScript(({ requestBody }) => ({
      finalText: (requestBody as { stream?: unknown }).stream === true ? REPLY : 'Reset worktree',
    }));
    await ensureAssistantShellVisible(page);
    const userData = electron.getUserDataDir();

    const repo = initRepo(electron.getWorkspaceRoot());
    const worktree = await threadInManagedWorktree(page, repo);
    expect(listWorktreePaths(repo)).toContain(worktree.path);
    expect(await readActiveManagedWorktrees(userData)).toEqual([
      expect.objectContaining({ branch: worktree.branch, path: worktree.path }),
    ]);

    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Factory Reset/iu, 'factory-reset');
    await page.getByTestId('factory-reset-button').click();
    // The replacement window tells the person what the reset did with the worktree, once, as it
    // starts. Main replaces the document after the reset: join it before reading its readiness.
    const notices = page.getByRole('region', { name: /^Notifications/u }).getByRole('listitem');
    await Promise.all([
      page.waitForEvent('load', { predicate: (loaded) => loaded.url() !== 'about:blank' }),
      expect(notices.filter({ hasText: '1 worktree archived into its repository' })).toBeVisible({
        timeout: 60_000,
      }),
      page.getByTestId('factory-reset-confirm').click(),
    ]);
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);

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
    expect(modelProvider.refusals()).toEqual([]);
  });
});
