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
 * derives a per-test `userDataDir`, so the host's open and recent folders can
 * never leak between tests. Every temp dir is tracked and removed
 * in `afterAll`.
 *
 * Root setup uses the shared `seedRoot` helper (`e2e/utils/seed-root.ts`):
 * seed the host's open folders (the real paths) through its E2E-only
 * `workspace/roots/seed-for-e2e`, then reload — the host restores the root and
 * the bar resolves against its durable `roots` row.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import {
  freshNonGitDir as createFreshNonGitDir,
  freshRepo as createFreshRepo,
  createTempDirTracker,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { type SeedRootOptions, seedRoot as seedWorkspaceRoot } from './utils/seed-root';
import { branchRow, openFolderRows, openWhereMenu, whereChip } from './utils/where-control';

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
 * reload.
 */
async function seedRoot(
  page: Page,
  rootPath: string,
  options: Pick<SeedRootOptions, 'recentPaths'> = {}
): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
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
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

/**
 * The folder "Add folder…" resolves to. The OS picker cannot open headlessly,
 * so the picker answers this REAL directory (the real adapter still stats
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
  test('@smoke shows the where-control for a SINGLE root and its Branch row for a git repo', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('repo');
    await seedRoot(page, repo);
    await openComposer(page);

    // Always visible at ONE root: the bar is orientation, not disambiguation
    // (BST-1396 removed the >=2-roots gate).
    const folderChip = whereChip(page);
    await expect(folderChip).toBeVisible({ timeout: 30_000 });
    // A new thread has no folder until the person chooses one.
    await expect(folderChip).toHaveAccessibleName('Choose a folder', { timeout: 30_000 });
    await chooseThreadFolder(page, path.basename(repo));
    await expect(folderChip).toContainText(path.basename(repo), { timeout: 30_000 });

    await expect(page.getByTestId('workspace-bar')).toHaveAttribute(
      'data-checkout-state',
      'resolved',
      { timeout: 30_000 }
    );
    await openWhereMenu(page);
    const branch = branchRow(page);
    await expect(branch).toBeVisible({ timeout: 30_000 });
    await expect(branch).toContainText('main');
    await expect(branch).toHaveAttribute('data-dirty', 'false');
    await page.keyboard.press('Escape');
  });

  test('offers no Branch row for a non-git folder', async ({ window: page }) => {
    const plain = freshNonGitDir('plain');
    await seedRoot(page, plain);
    await openComposer(page);

    const folderChip = whereChip(page);
    await chooseThreadFolder(page, path.basename(plain));
    await expect(folderChip).toContainText(path.basename(plain), { timeout: 30_000 });

    // Deterministic wait (BST-1400): `data-checkout-state` flips to
    // "resolved" once `useThreadCheckoutStatus`'s Git bridge `status`
    // round-trip for THIS root has settled — pending vs. "confirmed no
    // Branch row" are otherwise indistinguishable from a row that simply
    // had not mounted yet.
    await expect(page.getByTestId('workspace-bar')).toHaveAttribute(
      'data-checkout-state',
      'resolved',
      { timeout: 30_000 }
    );
    await expect(folderChip).toHaveAttribute('title', 'Not a git repository');
    // A folder outside git is a project with one checkout, Local (ADR-0034).
    await expect(folderChip).toHaveAccessibleName(
      `Where this thread works: ${path.basename(plain)} · Local`
    );
    await openWhereMenu(page);
    // Positive control: the open menu lists the folders, so the Branch row is absent, not unrendered.
    await expect(page.getByTestId('workspace-bar-folders')).toBeVisible();
    await expect(branchRow(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('names a failed git status on the where-control instead of calling the repo a non-repository', async ({
    window: page,
  }) => {
    // BST-2133: a corrupt index makes `git status` fail outright. The chip used
    // to report that as "Not a git repository".
    const repo = freshRepo('corrupt-index');
    writeFileSync(path.join(repo, '.git', 'index'), 'not an index\n');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    await expect(page.getByTestId('workspace-bar')).toHaveAttribute(
      'data-checkout-state',
      'resolved',
      { timeout: 30_000 }
    );
    await expect(whereChip(page)).toHaveAttribute(
      'title',
      /^Git status could not be read: .*index/u,
      { timeout: 30_000 }
    );
    await openWhereMenu(page);
    await expect(page.getByTestId('workspace-bar-folders')).toBeVisible();
    await expect(branchRow(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('re-mounts a recent folder from the where-control without the OS picker and records it as +1', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const primary = freshRepo('primary');
    const recent = freshNonGitDir('recent');
    // The recents grant is seeded in the same request as the open folder, before
    // the only reload. Being present in the recent-folders ledger is the ONLY
    // thing that authorizes the picker-less `workspace/roots/add`.
    await seedRoot(page, primary, { recentPaths: [recent] });
    await openComposer(page);

    const folderChip = whereChip(page);
    await chooseThreadFolder(page, path.basename(primary));
    await expect(folderChip).toContainText(path.basename(primary), { timeout: 30_000 });
    // No secondaries yet — so the "+1" below is this click's effect, not a
    // badge that was already on screen.
    await expect(folderChip).not.toContainText('+', { timeout: 5000 });

    await openFolderRows(page);
    const recentItem = page.getByTestId(`workspace-bar-recent-${recent}`);
    await expect(recentItem).toBeVisible({ timeout: 15_000 });
    await recentItem.click();

    // "+N" is the thread's SECONDARY count: the folder mounted globally AND the
    // thread metadata write landed after reconciliation resolved its roots row.
    await expect(folderChip).toContainText('+1', { timeout: 60_000 });

    // …and the re-mounted folder is a real workspace root, not just a label:
    // it has its own ROOT ROW in the Folders menu. Reopened explicitly rather than
    // assumed-closed after the item select, and scoped to the open menu so a
    // stray occurrence of the folder name elsewhere on the page cannot satisfy
    // it.
    await openFolderRows(page);
    const menu = page.getByRole('menu', { name: /^Folders: /u });
    await expect(menu).toBeVisible({ timeout: 15_000 });
    // Two ROOT rows now (primary + the re-mounted secondary), each keyed by a
    // durable `roots.id`; the name check is scoped to the same open menu.
    await expect(menu.getByTestId(/^workspace-bar-root-/u)).toHaveCount(2, { timeout: 15_000 });
    await expect(menu.getByText(path.basename(recent), { exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('makes a folder added through Add folder… the folder of a thread that has none', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const open = freshRepo('add-open');
    await seedRoot(page, open);
    await openComposer(page);

    const folderChip = whereChip(page);
    await expect(folderChip).toHaveAccessibleName('Choose a folder', { timeout: 30_000 });

    await openFolderRows(page);
    await page.getByTestId('workspace-bar-add-folder').click();

    // The thread had no folder, so the added one is its folder, not a secondary.
    await expect(folderChip).toHaveAccessibleName(
      `Where this thread works: ${path.basename(ADDED_ROOT_DIR)} · Local`,
      { timeout: 60_000 }
    );
    await expect(folderChip).not.toContainText('+');
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
    await expect(zone).toHaveClass(/ring-2/u);
  });
});
