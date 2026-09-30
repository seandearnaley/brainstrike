/**
 * Desktop E2E for the Git panel (Phase-4 diff/git feature; ledger P4 test-gap).
 *
 * Drives the BUILT Electron app against a REAL on-disk git repo: the git IPC
 * handlers run the real `git` binary (no stub), so status/stage/unstage/commit/
 * push are exercised end to end through the preload bridge + the panel UI.
 *
 * Isolation: EACH test gets its OWN freshly-`git init`'d repo (via `freshRepo`),
 * so a throwing assertion can never leave shared state dirty for the next test;
 * all temp dirs are tracked and removed in `afterAll`. Root setup mirrors
 * mid-session-add-root.desktop.test.ts: seed `rootsList` (the repo's real path)
 * into `electronAPI.storage`, then reload — the main process restores the root
 * and inserts the DB `roots` row the git bridge resolves against.
 */
import { realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  freshNonGitDir as createFreshNonGitDir,
  freshRepo as createFreshRepo,
  freshRepoWithRemote as createFreshRepoWithRemote,
  createTempDirTracker,
  git,
} from './utils/git-fixtures';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedRoot as seedRootWithLedgers } from './utils/seed-root';

const tempDirs = createTempDirTracker();

function freshRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-git-', tracker: tempDirs });
}

function freshRepoWithRemote(label: string): string {
  return createFreshRepoWithRemote({
    barePrefix: 'bst-git-bare-',
    label,
    prefix: 'bst-git-',
    tracker: tempDirs,
  });
}

function freshNonGitDir(label: string): string {
  return createFreshNonGitDir({
    label,
    prefix: 'bst-non-git-',
    seedFile: { contents: '', name: '.keep' },
    tracker: tempDirs,
  });
}

const ROOT_ID = 'p4-git-panel-root-00000000-0000-4000-8000-000000000010';

async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await seedRootWithLedgers(page, rootPath, {
    reloadReason: 'p4-git-seed-root',
    rootId: ROOT_ID,
  });
}

/**
 * The states that mean `GitPanel` has RESOLVED A STATUS. Each is a separate
 * early return in git-panel.tsx, so `git-panel` is the repo-happy-path testid
 * only — waiting on it alone hangs for the full timeout whenever the panel
 * legitimately settles somewhere else (a non-git folder renders
 * `git-panel-not-a-repo` and never mounts `git-panel`). The helper waits for
 * one of these and leaves each test to assert WHICH one.
 *
 * `git-panel-no-root` is deliberately EXCLUDED even though it is a fifth early
 * return. `useGitPanel` derives `activeRootId` from
 * `useFileSystem().rootDirectoryHandle`, which is null until the renderer
 * rehydrates the seeded root after `seedRoot`'s reload — so no-root is a boot
 * TRANSIENT here, not an outcome. Accepting it would let the wait resolve
 * before any status existed (and the `Loading Git` check below would pass
 * vacuously, since the no-root branch never renders that text). Every state
 * listed here requires `panel.status` to have resolved, so the wait converges.
 * A run that genuinely ends with no root now fails this wait, which is correct:
 * it means the seed did not take.
 */
const gitPanelSettledSelector = ['git-panel', 'git-panel-not-a-repo', 'git-panel-error']
  .map((testId) => `[data-testid="${testId}"]`)
  .join(', ');

async function openGitPanel(page: Page): Promise<void> {
  await page
    .getByRole('link', { name: 'Git' })
    .or(page.getByRole('button', { name: 'Git' }))
    .first()
    .click({ timeout: 15_000 });
  await page
    .locator(gitPanelSettledSelector)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.getByText(/Loading Git/i)).toHaveCount(0, { timeout: 20_000 });
}

test.afterAll(() => {
  tempDirs.removeAll();
});

test.describe('Git panel (desktop)', () => {
  test('@smoke shows a clean working tree + branch for an unchanged repo', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    await seedRoot(page, freshRepo('clean'));
    await openGitPanel(page);
    await expect(page.getByTestId('git-panel-clean')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('git-panel')).toContainText('main', { timeout: 10_000 });
  });

  test('switches a restored non-Git parent to its Git child without changing Main', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const parent = realpathSync(freshNonGitDir('focused-parent'));
    const child = path.join(parent, 'child-repository');
    renameSync(freshRepo('focused-child'), child);
    await seedRootWithLedgers(page, parent, {
      disableBackgroundIndexing: true,
      reloadReason: 'git-focused-parent-seed',
      rootId: ROOT_ID,
    });
    await page.evaluate(
      async ({ parentPath, childPath, parentId }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (key: string, value: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('Workspace seed storage is unavailable');
        }
        await storage.setItem(
          'rootsList',
          JSON.stringify([
            { addedAt: 1_800_000_000_000, path: parentPath, rootId: parentId },
            { addedAt: 1_800_000_000_001, path: childPath, rootId: 'git-focused-child-root' },
          ])
        );
      },
      { childPath: child, parentId: ROOT_ID, parentPath: parent }
    );
    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'git-focused-parent-child-restore');
    await openGitPanel(page);
    await expect(page.getByTestId('git-panel-not-a-repo')).toBeVisible();
    await expect(page.getByTestId('git-focused-folder')).toContainText(parent);

    const trigger = page.getByRole('button', { name: 'Switch repository or focused folder' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const childChoice = page.getByRole('menuitemradio', {
      name: `Focus folder child-repository: ${child}`,
    });
    await expect(childChoice).toBeVisible();
    await expect(childChoice).toContainText('Git repository');
    const screenshot = await page.screenshot();
    await test.info().attach('restored-parent-repository-switcher', {
      body: screenshot,
      contentType: 'image/png',
    });
    await page.keyboard.press('ArrowDown');
    await expect(childChoice).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('git-panel-clean')).toBeVisible();
    await expect(page.getByTestId('git-focused-folder')).toContainText(child);
    await expect(page.getByTestId('workspace-root-status-trigger')).toHaveAttribute(
      'title',
      parent
    );
    await expect(trigger).toBeFocused();

    await trigger.press('Enter');
    await expect(childChoice).toHaveAttribute('aria-checked', 'true');
    await childChoice.click();
    await expect(page.getByTestId('git-panel-clean')).toBeVisible();
    await trigger.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('workspace-root-status-trigger')).toHaveAttribute(
      'title',
      parent
    );
  });

  test('surfaces an unstaged change made on disk', async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('unstaged');
    writeFileSync(path.join(repo, 'hello.ts'), 'export const value = 2;\n');
    await seedRoot(page, repo);
    await openGitPanel(page);
    await expect(page.getByText(/Unstaged \(1\)/)).toBeVisible({ timeout: 20_000 });
  });

  test('stage then unstage an untracked file round-trips through the bridge', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('stage');
    writeFileSync(path.join(repo, 'staged-me.ts'), 'export const x = 1;\n');
    await seedRoot(page, repo);
    await openGitPanel(page);
    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Stage staged-me.ts' }).click();
    await expect(page.getByText(/Staged \(1\)/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Unstage staged-me.ts' }).click();
    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 15_000 });
  });

  test('opens a textual diff when a changed file row is clicked', async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('diff');
    writeFileSync(path.join(repo, 'hello.ts'), 'export const value = 99;\n');
    await seedRoot(page, repo);
    await openGitPanel(page);
    await expect(page.getByText(/Unstaged \(1\)/)).toBeVisible({ timeout: 20_000 });

    // The file row is a <button> whose accessible name is the file path itself
    // (the stage/unstage controls are "Stage …"/"Unstage …"), so match exactly.
    await page.getByRole('button', { exact: true, name: 'hello.ts' }).first().click();
    // #2279 converged this pane onto the shared changeset engine: `GitDiffSurface`
    // (which owned `git-panel-diff`) was deleted in favour of `ChangesetFileDiffCard`.
    // Asserted by ROLE + NAME rather than the card's testid: the card renders
    // `DiffView` with `aria-label={`Diff for ${entry.path}`}`, so this pins the
    // diff to THIS file — a testid alone would also pass on a diff opened for
    // the wrong row. The region exists only on the loaded-success branch, so it
    // still cannot pass on a loading/binary/error card.
    await expect(page.getByRole('region', { name: 'Diff for hello.ts' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('commits staged changes and returns to a clean tree', async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('commit');
    writeFileSync(path.join(repo, 'commit-me.ts'), 'export const c = 1;\n');
    await seedRoot(page, repo);
    await openGitPanel(page);

    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Stage commit-me.ts' }).click();
    await expect(page.getByText(/Staged \(1\)/)).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole('textbox', { name: 'Commit summary (required)' })
      .fill('e2e commit from the git panel');
    await page
      .getByRole('button', { name: /^Commit/ })
      .first()
      .click();

    await expect(page.getByTestId('git-panel-clean')).toBeVisible({ timeout: 20_000 });
    expect(git(repo, ['log', '--oneline', '-1'])).toContain('e2e commit from the git panel');
  });

  test('pushes an ahead commit to the bare remote and clears the ahead badge', async ({
    window: page,
  }) => {
    test.setTimeout(120_000);
    const repo = freshRepoWithRemote('push');
    writeFileSync(path.join(repo, 'push-me.ts'), 'export const p = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'push test commit']);
    await seedRoot(page, repo);
    await openGitPanel(page);

    await expect(page.getByTestId('ahead-badge')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Push to upstream' }).click();
    await expect(page.getByTestId('ahead-badge')).toHaveCount(0, { timeout: 45_000 });
  });

  test('shows the not-a-repo state for a non-git directory', async ({ window: page }) => {
    test.setTimeout(90_000);
    await seedRoot(page, freshNonGitDir('not-a-repo'));
    await openGitPanel(page);
    await expect(page.getByTestId('git-panel-not-a-repo')).toBeVisible({ timeout: 20_000 });
  });

  // NOTE: `pull` from the bare remote requires committing into the bare repo from
  // a second worktree before pulling — deferred (low E2E value, complex plumbing).
  // The cross-root diff-state race (#1290, "switch during diff load") is covered
  // deterministically by the git-panel unit race test added in #1290; an E2E
  // root-switch is timing-nondeterministic, so it is not re-proven here.
});
