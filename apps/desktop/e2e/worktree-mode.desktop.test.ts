/**
 * Desktop E2E for the composer MODE chip (BST-1390 W3).
 *
 * Drives the built Electron app against real on-disk Git repositories and the
 * real PGlite-backed worktree ledger. Worktree create/archive/list operations
 * cross the production preload, IPC, service, Git, mount, and thread-metadata
 * chain; only assistant model traffic is replaced at its external boundary.
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import {
  freshRepo as createFreshRepo,
  createTempDirTracker,
  freshRepoWithExternalWorktree,
  git,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'w3-worktree-mode-root-00000000-0000-4000-8000-000000000030';
let managedDirectory: string;

interface CreatedWorktree {
  readonly branch: string;
  readonly name: string;
  readonly worktreePath: string;
}

function freshRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-w3-', tracker: tempDirs });
}

async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w3-worktree-mode-seed-root',
    rootId: ROOT_ID,
  });
}

async function openComposer(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

async function createAndUseWorktree(page: Page): Promise<CreatedWorktree> {
  await page.getByTestId('workspace-bar-mode-chip').click();
  await page.getByTestId('workspace-bar-mode-new-worktree').click();
  const dialog = page.getByTestId('worktree-create-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const branchField = dialog.getByTestId('worktree-create-branch');
  await expect(branchField).toHaveValue(/^bs\/.+/u);
  const branch = (await branchField.inputValue()).trim();
  const name = (await dialog.getByTestId('worktree-create-name').inputValue()).trim();
  const worktreePath = (await dialog.getByTestId('worktree-create-location').innerText()).trim();
  await dialog.getByTestId('worktree-create-submit').click();
  await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
    timeout: 90_000,
  });
  return { branch, name, worktreePath };
}

test.beforeAll(() => {
  // Resolved through realpath before anything downstream sees it: on macOS
  // os.tmpdir() lives under /var, a symlink to /private/var, and
  // WorktreeService.create() realpaths settings.managedDirectory before it
  // computes the actual `git worktree add` target. Handing it an
  // already-canonical path keeps every path string this spec compares
  // against (the create-sheet's location preview, `git worktree list`
  // output, and the mounted root) in agreement from the start.
  managedDirectory = realpathSync(
    tempDirs.track(mkdtempSync(path.join(tmpdir(), 'bst-w3-managed-worktrees-')))
  );
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = managedDirectory;
});

test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
});

test.describe('Worktree mode (desktop)', () => {
  test('@smoke shows the Local mode chip for a git repo', async ({ window: page }) => {
    test.setTimeout(90_000);
    await seedRoot(page, freshRepo('local'));
    await openComposer(page);

    const chip = page.getByTestId('workspace-bar-mode-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Local');
    await expect(chip).toBeEnabled();
  });

  test('creates a real worktree and moves the thread into it', async ({ window: page }) => {
    test.setTimeout(180_000);
    const repo = freshRepo('create');
    await seedRoot(page, repo);
    await openComposer(page);

    const created = await createAndUseWorktree(page);
    await expect(page.getByTestId('workspace-bar-folder-chip')).toContainText(created.name, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('workspace-bar-branch-chip')).toContainText(created.branch, {
      timeout: 30_000,
    });
    expect(existsSync(created.worktreePath)).toBe(true);
    const inventory = git(repo, ['worktree', 'list', '--porcelain']);
    expect(inventory).toContain(`worktree ${created.worktreePath}`);
    expect(inventory).toContain(`branch refs/heads/${created.branch}`);
  });

  test('lists an external-tool worktree as disabled with a reason and grant action', async ({
    window: page,
  }) => {
    test.setTimeout(180_000);
    const { repo, worktree } = freshRepoWithExternalWorktree({
      label: 'external',
      prefix: 'bst-w3-ext-',
      toolDirectory: '.codex/worktrees',
      tracker: tempDirs,
    });
    await seedRoot(page, repo);
    await openComposer(page);

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-pick-worktree').click();
    const dialog = page.getByTestId('worktree-picker-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const row = dialog.getByTestId(`worktree-picker-row-${worktree}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId(`worktree-picker-tool-${worktree}`)).toHaveText('Codex');
    await expect(row.getByTestId(`worktree-picker-select-${worktree}`)).toBeDisabled();
    await expect(row.getByTestId(`worktree-picker-reason-${worktree}`)).toContainText(
      'grant access to use it here'
    );
    await expect(row.getByTestId(`worktree-picker-grant-${worktree}`)).toBeVisible();
  });

  test('archives a clean worktree and returns the thread to Local', async ({ window: page }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('archive');
    await seedRoot(page, repo);
    await openComposer(page);

    const created = await createAndUseWorktree(page);
    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-archive').click();
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText('Local', {
      timeout: 90_000,
    });
    // The chip flips to "Local" as soon as the hand-off resolves — hand-off
    // now runs BEFORE archive (BST-1390: a failed write after a successful
    // archive used to strand the thread on an archived worktree with no
    // recovery path). Archive is a separate, sequential step that keeps
    // running after the chip already reads "Local", so the on-disk removal
    // and the archive ref land on their own timeline; poll for them instead
    // of asserting the instant the chip text changes.
    await expect.poll(() => existsSync(created.worktreePath), { timeout: 90_000 }).toBe(false);
    await expect
      .poll(() => git(repo, ['worktree', 'list', '--porcelain']), { timeout: 90_000 })
      .not.toContain(created.worktreePath);
    await expect
      .poll(() => git(repo, ['for-each-ref', '--format=%(refname)', 'refs/brainstrike']), {
        timeout: 90_000,
      })
      .toContain('refs/brainstrike/worktree-archive/');

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-pick-worktree').click();
    const dialog = page.getByTestId('worktree-picker-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // The row's testid is keyed by `worktreeId ?? path` (worktree-picker-dialog.tsx); a
    // MANAGED worktree always carries a real id, so the row testid is that id, not the
    // path — asserting on a path-keyed testid here would be vacuous (it would never have
    // matched even before archiving). Assert on the row's visible name text instead,
    // scoped to the open dialog, mirroring the scoped-menu text checks in
    // workspace-bar.desktop.test.ts.
    //
    // The picker's option list is fetched once per open (`useWorktreeMode`'s
    // `onPickerOpenChange` refetches on `open`, not on a live subscription), so a
    // single open can race the git-inventory watcher's own settle latency after
    // `git worktree remove` runs. Close and reopen — forcing a fresh fetch — until
    // the archived worktree's row is gone, bounded so a real regression still fails.
    let archivedRowGone = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      archivedRowGone = (await dialog.getByText(created.name, { exact: true }).count()) === 0;
      if (archivedRowGone) {
        break;
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(1000);
      await page.getByTestId('workspace-bar-mode-chip').click();
      await page.getByTestId('workspace-bar-mode-pick-worktree').click();
      await expect(dialog).toBeVisible({ timeout: 30_000 });
    }
    expect(archivedRowGone).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('hands off to Local and the chip stays Local across a reload', async ({ window: page }) => {
    test.setTimeout(240_000);
    await seedRoot(page, freshRepo('handoff'));
    await openComposer(page);
    await createAndUseWorktree(page);

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-handoff').click();
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText('Local', {
      timeout: 90_000,
    });

    await page.reload();
    await openComposer(page);
    await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText('Local', {
      timeout: 90_000,
    });
  });

  test('persists the worktree checkout across a reload', async ({ window: page }) => {
    test.setTimeout(240_000);
    await seedRoot(page, freshRepo('persist'));
    await openComposer(page);
    const created = await createAndUseWorktree(page);

    await page.reload();
    await openComposer(page);
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(created.name, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('workspace-bar-folder-chip')).toContainText(created.name, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('workspace-bar-branch-chip')).toContainText(created.branch, {
      timeout: 30_000,
    });
  });

  test('switches branches from the composer branch chip', async ({ window: page }) => {
    test.setTimeout(120_000);
    const repo = freshRepo('switch');
    git(repo, ['branch', 'feature/alpha']);
    await seedRoot(page, repo);
    await openComposer(page);

    const chip = page.getByTestId('workspace-bar-branch-chip');
    await expect(chip).toContainText('main', { timeout: 30_000 });
    await chip.click();
    await page.getByTestId('workspace-bar-branch-row-feature/alpha').click();
    await expect(chip).toContainText('feature/alpha', { timeout: 60_000 });
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/alpha');
  });
});
