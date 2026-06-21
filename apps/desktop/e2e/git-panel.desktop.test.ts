/**
 * Desktop E2E for the Git panel (Phase-4 diff/git feature; ledger P4 test-gap).
 *
 * Drives the BUILT Electron app against a REAL on-disk git repo: the git IPC
 * handlers run the real `git` binary (no stub), so status/stage/unstage/commit/
 * push are exercised end to end through the preload bridge + the panel UI.
 *
 * Root setup mirrors mid-session-add-root.desktop.test.ts: seed `rootsList`
 * (with the temp repo's real path) into `electronAPI.storage`, then reload — the
 * main process restores the root and inserts the DB `roots` row the git bridge
 * resolves against. No OS picker / env var needed for the storage-seed path.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

// execFile (no shell) — args pass straight to git, so temp paths with spaces or
// metacharacters can never be re-interpreted (no command injection, no quoting).
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createTempGitRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `bst-git-${label}-`));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'e2e@brainstrike.invalid']);
  git(dir, ['config', 'user.name', 'Brainstrike E2E']);
  writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// A bare repo as `origin` so push is a real, deterministic, network-free op.
function addBareRemote(repo: string, label: string): string {
  const bare = mkdtempSync(path.join(tmpdir(), `bst-git-bare-${label}-`));
  execFileSync('git', ['clone', '--bare', repo, bare]);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['fetch', 'origin']);
  git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);
  return bare;
}

// Module scope: created before the Electron harness launches.
const GIT_REPO = createTempGitRepo('panel');
addBareRemote(GIT_REPO, 'panel');
const NON_GIT_DIR = mkdtempSync(path.join(tmpdir(), 'bst-non-git-'));
writeFileSync(path.join(NON_GIT_DIR, '.keep'), '');

const ROOT_ID = 'p4-git-panel-root-00000000-0000-4000-8000-000000000010';

async function seedRoot(page: Page, rootPath: string, rootId: string): Promise<void> {
  await page.evaluate(
    async ({ rootPath: p, rootId: id }) => {
      const storage = (
        globalThis as typeof globalThis & {
          electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem unavailable');
      }
      await storage.setItem('lastFolderPath', p);
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: p, rootId: id }])
      );
    },
    { rootPath, rootId }
  );
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'p4-git-seed-root');
}

async function openGitPanel(page: Page): Promise<void> {
  await page
    .getByRole('link', { name: 'Git' })
    .or(page.getByRole('button', { name: 'Git' }))
    .first()
    .click({ timeout: 15_000 });
  await page.getByTestId('git-panel').waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.getByText(/Loading Git/i)).toHaveCount(0, { timeout: 20_000 });
}

test.describe('Git panel (desktop)', () => {
  test('@smoke shows a clean working tree + branch for an unchanged repo', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);
    await expect(page.getByTestId('git-panel-clean')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('git-panel')).toContainText('main', { timeout: 10_000 });
  });

  test('surfaces an unstaged change made on disk', async ({ window: page }) => {
    test.setTimeout(90_000);
    writeFileSync(path.join(GIT_REPO, 'hello.ts'), 'export const value = 2;\n');
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);
    await expect(page.getByText(/Unstaged \(1\)/)).toBeVisible({ timeout: 20_000 });
    git(GIT_REPO, ['checkout', '--', '.']);
  });

  test('stage then unstage an untracked file round-trips through the bridge', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    writeFileSync(path.join(GIT_REPO, 'staged-me.ts'), 'export const x = 1;\n');
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);
    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Stage staged-me.ts' }).click();
    await expect(page.getByText(/Staged \(1\)/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Unstage staged-me.ts' }).click();
    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 15_000 });

    git(GIT_REPO, ['clean', '-fd']);
  });

  test('opens a textual diff when a changed file row is clicked', async ({ window: page }) => {
    test.setTimeout(90_000);
    writeFileSync(path.join(GIT_REPO, 'hello.ts'), 'export const value = 99;\n');
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);
    await expect(page.getByText(/Unstaged \(1\)/)).toBeVisible({ timeout: 20_000 });

    // The file row is a <button> whose accessible name is the file path itself
    // (the stage/unstage controls are "Stage …"/"Unstage …"), so match exactly.
    await page.getByRole('button', { name: 'hello.ts', exact: true }).first().click();
    await expect(page.getByTestId('git-panel-diff')).toBeVisible({ timeout: 20_000 });

    git(GIT_REPO, ['checkout', '--', '.']);
  });

  test('commits staged changes and returns to a clean tree', async ({ window: page }) => {
    test.setTimeout(90_000);
    writeFileSync(path.join(GIT_REPO, 'commit-me.ts'), 'export const c = 1;\n');
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);

    await expect(page.getByText(/Untracked \(1\)/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Stage commit-me.ts' }).click();
    await expect(page.getByText(/Staged \(1\)/)).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('Commit message').fill('e2e commit from the git panel');
    await page
      .getByRole('button', { name: /^Commit/ })
      .first()
      .click();

    await expect(page.getByTestId('git-panel-clean')).toBeVisible({ timeout: 20_000 });
    expect(git(GIT_REPO, ['log', '--oneline', '-1'])).toContain('e2e commit from the git panel');

    git(GIT_REPO, ['reset', '--hard', 'HEAD~1']);
  });

  test('pushes an ahead commit to the bare remote and clears the ahead badge', async ({
    window: page,
  }) => {
    test.setTimeout(120_000);
    writeFileSync(path.join(GIT_REPO, 'push-me.ts'), 'export const p = 1;\n');
    git(GIT_REPO, ['add', '.']);
    git(GIT_REPO, ['commit', '-m', 'push test commit']);
    await seedRoot(page, GIT_REPO, ROOT_ID);
    await openGitPanel(page);

    await expect(page.getByTestId('ahead-badge')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Push to upstream' }).click();
    await expect(page.getByTestId('ahead-badge')).toHaveCount(0, { timeout: 45_000 });

    git(GIT_REPO, ['reset', '--hard', 'origin/main']);
  });

  test('shows the not-a-repo state for a non-git directory', async ({ window: page }) => {
    test.setTimeout(90_000);
    await seedRoot(page, NON_GIT_DIR, ROOT_ID);
    await openGitPanel(page);
    await expect(page.getByTestId('git-panel-not-a-repo')).toBeVisible({ timeout: 20_000 });
  });

  // NOTE: `pull` from the bare remote requires committing into the bare repo from
  // a second worktree before pulling — deferred (low E2E value, complex plumbing).
  // The cross-root diff-state race (#1290, "switch during diff load") is covered
  // deterministically by the git-panel unit race test added in #1290; an E2E
  // root-switch is timing-nondeterministic, so it is not re-proven here.
});
