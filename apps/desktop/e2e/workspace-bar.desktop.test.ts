/**
 * Desktop E2E for the composer WORKSPACE BAR (BST-1388 W1).
 *
 * Drives the BUILT Electron app against REAL on-disk folders so the whole
 * chain under test is production code: the main-process root registry +
 * recent-roots ledger, the preload `fs:`/`git:` bridges, app-shell's
 * `useWorkspaceBar`/`useThreadCheckoutStatus`, and the pure `WorkspaceBar`
 * chips. Nothing about the bar is mocked here.
 *
 * Isolation: each test gets its OWN freshly-created temp folder(s) (a real
 * `git init`'d repo where the checkout matters), and the Electron fixture
 * derives a per-test `userDataDir`, so main's `rootsList`/`recentRootsList`
 * ledgers can never leak between tests. Every temp dir is tracked and removed
 * in `afterAll`.
 *
 * Root setup uses the shared `seedRoot` helper (`e2e/utils/seed-root.ts`,
 * lifted from `git-panel.desktop.test.ts`): seed the ledgers (the real paths)
 * into `electronAPI.storage`, then reload — main restores the root and the
 * renderer reconciles the durable `roots` row the bar resolves against.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import {
  freshNonGitDir as createFreshNonGitDir,
  freshRepo as createFreshRepo,
  createTempDirTracker,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { type SeedRootOptions, seedRoot as seedWorkspaceRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();

function freshRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-bar-', tracker: tempDirs });
}

function freshNonGitDir(label: string): string {
  return createFreshNonGitDir({
    label,
    prefix: 'bst-bar-plain-',
    seedFile: { contents: 'export const note = 1;\n', name: 'note.ts' },
    tracker: tempDirs,
  });
}

const ROOT_ID = 'w1-workspace-bar-root-00000000-0000-4000-8000-000000000010';

/**
 * Seed ONE connected root (optionally alongside recent-roots grants) and
 * reload. Background indexing is seeded OFF: the bar reads the `roots` table
 * and `window.git`, never the index, so driving the embedding pipeline here
 * would only add minutes and flake surface.
 */
async function seedRoot(
  page: Page,
  rootPath: string,
  options: Pick<SeedRootOptions, 'recentPaths'> = {}
): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w1-workspace-bar-seed-root',
    rootId: ROOT_ID,
    ...options,
  });
}

/**
 * Bring the composer (and with it the bar) on screen and wait for the bar to
 * mount. `setupAssistantMock` runs AFTER the seed reload on purpose: it
 * installs through `page.evaluate`, so a reload would wipe it — and without an
 * available assistant the composer shell (the bar's host) never renders.
 */
async function openComposer(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

/**
 * The folder "Add folder…" resolves to. The OS picker cannot open headlessly,
 * so `fs:addRoot` returns this REAL directory (the real adapter still stats
 * it) instead of a dialog — the add path under test stays unmocked. It must be
 * set BEFORE any Electron app in this file launches, because the fixture
 * starts the app while resolving the `window` fixture, i.e. before a test body
 * runs; main reads the env var in-process.
 */
let ADDED_ROOT_DIR: string;

test.beforeAll(() => {
  ADDED_ROOT_DIR = freshNonGitDir('added');
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ADDED_ROOT_DIR;
});

test.afterAll(() => {
  // Assigning undefined coerces to the string "undefined"; delete truly unsets.
  delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  tempDirs.removeAll();
});

test.describe('Workspace bar (desktop)', () => {
  test('@smoke shows the folder chip for a SINGLE root and the branch chip for a git repo', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('repo');
    await seedRoot(page, repo);
    await openComposer(page);

    // Always visible at ONE root: the bar is orientation, not disambiguation
    // (BST-1396 removed the >=2-roots gate).
    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toBeVisible({ timeout: 30_000 });
    await expect(folderChip).toContainText(path.basename(repo), { timeout: 30_000 });

    const branchChip = page.getByTestId('workspace-bar-branch-chip');
    await expect(branchChip).toBeVisible({ timeout: 30_000 });
    await expect(branchChip).toContainText('main');
    await expect(branchChip).toHaveAttribute('data-dirty', 'false');
  });

  test('hides the branch chip for a non-git folder', async ({ window: page }) => {
    const plain = freshNonGitDir('plain');
    await seedRoot(page, plain);
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(plain), { timeout: 30_000 });

    // Deterministic wait (BST-1400): `data-checkout-state` flips to
    // "resolved" once `useThreadCheckoutStatus`'s `window.git.status`
    // round-trip for THIS root has settled — pending vs. "confirmed no
    // branch chip" are otherwise indistinguishable from a chip that simply
    // had not mounted yet.
    await expect(page.getByTestId('workspace-bar')).toHaveAttribute(
      'data-checkout-state',
      'resolved',
      { timeout: 30_000 }
    );
    await expect(page.getByTestId('workspace-bar-branch-chip')).toHaveCount(0);
    await expect(page.getByTestId('workspace-bar-mode-chip')).toHaveAttribute(
      'title',
      'Not a git repository'
    );
  });

  test('names a failed git status on the mode chip instead of calling the repo a non-repository', async ({
    window: page,
  }) => {
    // BST-2133: a corrupt index makes `git status` fail outright. The chip used
    // to report that as "Not a git repository".
    const repo = freshRepo('corrupt-index');
    writeFileSync(path.join(repo, '.git', 'index'), 'not an index\n');
    await seedRoot(page, repo);
    await openComposer(page);

    await expect(page.getByTestId('workspace-bar')).toHaveAttribute(
      'data-checkout-state',
      'resolved',
      { timeout: 30_000 }
    );
    await expect(page.getByTestId('workspace-bar-mode-chip')).toHaveAttribute(
      'title',
      /^Git status could not be read: .*index/u,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId('workspace-bar-branch-chip')).toHaveCount(0);
  });

  test('re-mounts a recent folder from the chip without the OS picker and records it as +1', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const primary = freshRepo('primary');
    const recent = freshNonGitDir('recent');
    // The recents grant is seeded in the SAME write as `rootsList`, before the
    // only reload: the boot that reload triggers runs `restoreRoots` →
    // `recordRecentRootIfNew`, a read-modify-write on `recentRootsList`, and a
    // seed landing after it would race that write. Being present in the ledger
    // is the ONLY thing that authorizes the picker-less `fs:addRootByPath`.
    await seedRoot(page, primary, { recentPaths: [recent] });
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(primary), { timeout: 30_000 });
    // No secondaries yet — so the "+1" below is this click's effect, not a
    // badge that was already on screen.
    await expect(folderChip).not.toContainText('+', { timeout: 5000 });

    await folderChip.click();
    const recentItem = page.getByTestId(`workspace-bar-recent-${recent}`);
    await expect(recentItem).toBeVisible({ timeout: 15_000 });
    await recentItem.click();

    // "+N" is the thread's SECONDARY count: the folder mounted globally AND the
    // thread metadata write landed after reconciliation resolved its roots row.
    await expect(folderChip).toContainText('+1', { timeout: 60_000 });

    // …and the re-mounted folder is a real workspace root, not just a label:
    // it has its own ROOT ROW in the chip menu. Reopened explicitly rather than
    // assumed-closed after the item select, and scoped to the open menu so a
    // stray occurrence of the folder name elsewhere on the page cannot satisfy
    // it.
    await folderChip.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 15_000 });
    // Two ROOT rows now (primary + the re-mounted secondary), each keyed by a
    // durable `roots.id`; the name check is scoped to the same open menu.
    await expect(menu.getByTestId(/^workspace-bar-root-/)).toHaveCount(2, { timeout: 15_000 });
    await expect(menu.getByText(path.basename(recent), { exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('attaches a folder added through Add folder… as a thread secondary', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const primary = freshRepo('add-primary');
    await seedRoot(page, primary);
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(primary), { timeout: 30_000 });
    // No secondaries yet — the "+1" below must be produced by the add.
    await expect(folderChip).not.toContainText('+', { timeout: 5000 });

    await folderChip.click();
    await page.getByTestId('workspace-bar-add-folder').click();

    await expect(folderChip).toContainText('+1', { timeout: 60_000 });
  });

  test('@smoke the composer drop zone arms only for a drag that carries files', {
    tag: '@smoke',
  }, async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('drop-gate');
    await seedRoot(page, repo);
    await openComposer(page);

    const zone = page.getByTestId('workspace-bar-drop-zone');
    await expect(zone).toBeVisible({ timeout: 30_000 });

    // The gate itself is observable SYNCHRONOUSLY: handleDragOver calls
    // preventDefault() only when 'Files' is advertised (the component's own
    // stated contract — checked BEFORE preventDefault, so an internal
    // pragmatic-drag-and-drop drag passes through untouched). Asserting on
    // defaultPrevented tests the gate with no render race — a negative
    // not.toHaveClass would pass on its first poll before React flushed a
    // would-be setIsDragOver, making "ring absent" and "ring not rendered
    // yet" indistinguishable (PR #2686 review). Real page-constructed
    // DataTransfers, never serialized objects.
    const textPrevented = await zone.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'not-a-file');
      const event = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(textPrevented).toBe(false);

    // Positive control: a File makes the DataTransfer advertise 'Files' —
    // the gate consumes the drag (defaultPrevented) and the ring, its
    // rendered consequence, arms (toHaveClass retries through the React
    // flush). NOTE (stated, per the plan): this proves the GATE and the
    // ring only. A JS-constructed File is not OS-backed, so `getPathForFile`
    // would return '' and no path could ever resolve from a synthetic
    // drop — the real-Finder-folder drop is the manual CDT step in Task 14.
    const filesPrevented = await zone.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'dropped.txt', { type: 'text/plain' }));
      const event = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(filesPrevented).toBe(true);
    await expect(zone).toHaveClass(/ring-2/);
  });
});
