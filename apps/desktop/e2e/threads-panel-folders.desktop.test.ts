/**
 * Desktop E2E for the Threads panel's default view, `Group by → Folder`
 * (BST-1388 W2; ADR-0034, owner decisions 2026-11-10): threads listed by the repository or
 * folder they work in.
 *
 * Drives the BUILT Electron app against REAL `git init`'d folders so the whole
 * chain under test is production code: the host's root registry, renderer root
 * reconciliation into the durable `roots` table, `useThreadFolderRows`' batched
 * `roots` lookup, the host's worktree listing (git's worktree list joined with
 * the worktree ledger), `buildThreadListSections`' folder view, and the folder
 * header's "New thread here" bind. Nothing about the panel is mocked.
 *
 * Conversations are created and bound through the public host protocol, using
 * the durable root identity returned by the real registry.
 *
 * Isolation: fresh temp repos per test plus the fixture's per-test
 * `userDataDir`, so neither the host's open folders nor its database can
 * leak between tests. Temp dirs are tracked and removed in `afterAll`.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { freshRepo as createFreshRepo, createTempDirTracker } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { startThread } from './utils/new-thread';
import { seedRoots } from './utils/seed-root';
import { seedHostThreads, type WorkspaceRootRow } from './utils/seed-threads';
import { openWhereMenu, whereChip } from './utils/where-control';

const tempDirs = createTempDirTracker();

const ROOT_ID = 'w2-thread-folders-root-00000000-0000-4000-8000-000000000020';
const OTHER_ROOT_ID = 'w2-thread-folders-root-00000000-0000-4000-8000-000000000021';

const BOUND_THREAD_TITLES = ['W2 bound alpha', 'W2 bound beta'] as const;
const OTHER_REPOSITORY_THREAD_TITLE = 'W2 other repository delta';
const UNBOUND_THREAD_TITLE = 'W2 unbound gamma';

/**
 * A real repo, mounted by its REAL path.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`. The worktree ledger keeps a worktree by its real
 * path and git reports the resolved form, so the fixture resolves the path once
 * and every path this spec compares agrees from the start.
 */
function freshRepo(label: string): string {
  return realpathSync(
    createFreshRepo({ label, prefix: 'bst-threads-folders-', tracker: tempDirs })
  );
}

/**
 * Seed a wide left panel; the next reload applies it.
 *
 * The panel width is part of the fixture, not decoration: a row's text chips
 * ("Local", a worktree's name) are behind a `@[420px]/threads` container query,
 * and the default 25% left panel is narrower than that on a 1536px window.
 * Seeding the layout store makes a chip's visibility a FACT ABOUT THE CHIP
 * rather than a fact about the panel's default size.
 */
async function seedWidePanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      'brainstrike:panel-layout-store.v1',
      JSON.stringify({
        state: {
          showConsole: false,
          showLeftPanel: true,
          showRightPanel: true,
          sizes: [45, 15, 20],
        },
        version: 1,
      })
    );
  });
}

/** The seeded folder as the host lists it. */
function rootRow(rootPath: string, id: string): WorkspaceRootRow {
  return { displayName: path.basename(rootPath), id, path: rootPath };
}

/**
 * Bring the Threads panel on screen. `setupAssistantMock` runs AFTER the last
 * reload on purpose: it installs through `page.evaluate`, so a reload would
 * wipe it — and without an available assistant the workspace shell that hosts
 * the Threads panel never renders.
 */
async function openThreadsPanel(page: Page): Promise<void> {
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

/** Switch the view-options popover's `Group by` radiogroup to `label`. */
async function groupBy(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'View options' }).click();
  const groupByOptions = page.getByRole('radiogroup', { name: 'Group by' });
  await expect(groupByOptions).toBeVisible({ timeout: 15_000 });
  // The radio input itself is `sr-only`; the label text is the real target and
  // the click reaches the input through the wrapping <label>.
  await groupByOptions.getByText(label, { exact: true }).click();
  await page.keyboard.press('Escape');
}

/** Toggle one `Show only` filter checkbox by its label. */
async function toggleShowOnly(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'View options' }).click();
  const showOnly = page.getByRole('group', { name: 'Show only' });
  await expect(showOnly).toBeVisible({ timeout: 15_000 });
  await showOnly.getByText(label, { exact: true }).click();
  await page.keyboard.press('Escape');
}

/** The folder section header whose name is exactly `name`. */
function folderHeader(page: Page, name: string) {
  return page.getByTestId('thread-folder-header').filter({ hasText: name });
}

/** The one thread row whose title is `title`. */
function threadRow(page: Page, title: string) {
  return page.getByTestId('thread-row').filter({ hasText: title });
}

/** The checkout chip on the one row whose title is `title`. */
function checkoutChip(page: Page, title: string) {
  return threadRow(page, title).getByTestId('thread-checkout-chip');
}

/**
 * Seed two repositories and the four threads every test starts from (two in
 * the first repository, one in the other, one with no folder), and land on the
 * panel as a person who never opened View options sees it.
 */
async function seedFoldersFixture(
  page: Page,
  userDataDir: string
): Promise<{ other: string; repo: string }> {
  const repo = freshRepo('repo');
  const other = freshRepo('other');
  await seedWidePanel(page);
  await seedRoots(
    page,
    [
      { path: repo, rootId: ROOT_ID },
      { path: other, rootId: OTHER_ROOT_ID },
    ],
    { reloadReason: 'w2-thread-folders-seed-roots' }
  );

  // An empty host catalog creates nothing: the new-thread screen waits for a first send.
  await openThreadsPanel(page);
  await expect(page.getByTestId('new-thread-welcome')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('thread-row')).toHaveCount(0);
  // With no thread the default view has no section to draw, so the panel says
  // there are none rather than showing an empty list.
  await expect(page.getByTestId('threads-placeholder-card')).toBeVisible();
  await seedHostThreads(userDataDir, [
    { folder: null, title: UNBOUND_THREAD_TITLE },
    { folder: rootRow(repo, ROOT_ID), title: BOUND_THREAD_TITLES[0] },
    { folder: rootRow(repo, ROOT_ID), title: BOUND_THREAD_TITLES[1] },
    { folder: rootRow(other, OTHER_ROOT_ID), title: OTHER_REPOSITORY_THREAD_TITLE },
  ]);
  // The thread store loads once per resource on mount, so rows inserted behind
  // it only reach the panel after a reload.
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'w2-thread-folders-seed-threads');

  await openThreadsPanel(page);
  // Wait for the seeded rows BY NAME rather than by a total count: the count
  // would also have to predict anything else the shell created, and each named
  // row is what the assertions below actually address.
  for (const title of [
    ...BOUND_THREAD_TITLES,
    OTHER_REPOSITORY_THREAD_TITLE,
    UNBOUND_THREAD_TITLE,
  ]) {
    await expect(threadRow(page, title)).toHaveCount(1, { timeout: 30_000 });
  }
  return { other, repo };
}

test.beforeAll(() => {
  // The ledger keeps a worktree by its real path, so the managed directory is given by one.
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = realpathSync(
    tempDirs.track(mkdtempSync(path.join(tmpdir(), 'bst-threads-folders-worktrees-')))
  );
});

test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
});

test.describe('Threads panel folder grouping (desktop)', () => {
  test('@smoke lists threads by project by default, chips where each works, and trails a No project section', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(90_000);
    const { other, repo } = await seedFoldersFixture(page, electron.getUserDataDir());

    // THREE sections with no view chosen: one per repository, and the trailing
    // catch-all. The trailing section is NOT decoration — it is where a thread
    // with no binding has to land, and its absence would mean the unbound
    // thread vanished.
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByTestId('thread-date-section')).toHaveCount(0);
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection).toHaveCount(1);
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2');
    // The header names the branch the repository's own checkout is on, read
    // from the host's worktree listing (one read for the whole panel).
    await expect(repoSection.getByTestId('thread-folder-branch')).toHaveText('main');
    const otherSection = folderHeader(page, path.basename(other));
    await expect(otherSection.getByTestId('thread-folder-count')).toHaveText('1');

    const unassignedSection = folderHeader(page, 'No project');
    await expect(unassignedSection).toHaveCount(1);
    // ONE unbound thread, the seeded one: an empty catalog creates no thread of its own.
    await expect(unassignedSection.getByTestId('thread-folder-count')).toHaveText('1');
    // "New thread here" belongs to a FOLDER, so the catch-all must not offer it.
    await expect(unassignedSection.getByTestId('thread-folder-new-thread')).toHaveCount(0);
    await expect(unassignedSection.getByTestId('thread-folder-branch')).toHaveCount(0);

    // Each row says where its thread works. A thread in its folder itself is
    // Local; the unbound row works nowhere yet.
    for (const title of [...BOUND_THREAD_TITLES, OTHER_REPOSITORY_THREAD_TITLE]) {
      await expect(checkoutChip(page, title)).toBeVisible();
      await expect(checkoutChip(page, title)).toHaveText('Local');
    }
    await expect(checkoutChip(page, UNBOUND_THREAD_TITLE)).toHaveCount(0);

    // Date stays a view to switch to, and the chips go with the rows into it.
    await groupBy(page, 'Date');
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(0);
    await expect(page.getByTestId('thread-date-section').first()).toBeVisible();
    await expect(checkoutChip(page, BOUND_THREAD_TITLES[0])).toHaveText('Local');
    // …and Project is the option that brings the default back.
    await groupBy(page, 'Project');
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(3);
  });

  // ADR-0034 build decisions: the person names a project, and moves another folder into it.
  test("renames a project from its section's menu, and a folder the person moves into it lists there", async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const { other, repo } = await seedFoldersFixture(page, electron.getUserDataDir());
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2', {
      timeout: 30_000,
    });

    await repoSection.getByTestId('thread-project-actions').click();
    await page.getByRole('button', { name: 'Rename project…' }).click();
    const name = page.getByRole('textbox', { name: 'Project name' });
    await name.fill('  Renamed project ');
    await name.press('Enter');

    // The section reads the name the host stored, trimmed, and keeps its threads.
    const renamed = folderHeader(page, 'Renamed project');
    await expect(renamed.getByTestId('thread-folder-count')).toHaveText('2', { timeout: 30_000 });
    await expect(folderHeader(page, path.basename(repo))).toHaveCount(0);

    // Joining is the person's: the other repository's folder moves in from its own section.
    await folderHeader(page, path.basename(other)).getByTestId('thread-project-actions').click();
    await page.getByRole('button', { name: 'Move to project…' }).click();
    await page
      .getByTestId('thread-project-move-list')
      .getByRole('button', { name: 'Renamed project' })
      .click();
    await expect(renamed.getByTestId('thread-folder-count')).toHaveText('3', { timeout: 30_000 });
    await expect(folderHeader(page, path.basename(other))).toHaveCount(0);
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(2);
  });

  test('lists a thread working in a managed worktree under its repository, chipped with the worktree', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(180_000);
    const { repo } = await seedFoldersFixture(page, electron.getUserDataDir());
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2', {
      timeout: 30_000,
    });

    // A new thread in the repository moves into a new worktree before its first send.
    await repoSection.getByTestId('thread-folder-new-thread').click();
    const welcome = page.getByTestId('new-thread-welcome');
    await openWhereMenu(welcome);
    await page.getByTestId('workspace-bar-mode-new-worktree').click();
    const create = page.getByTestId('worktree-create-dialog');
    const worktreeName = (await create.getByTestId('worktree-create-name').inputValue()).trim();
    await create.getByTestId('worktree-create-submit').click();
    await expect(whereChip(welcome)).toContainText(worktreeName, {
      timeout: 90_000,
    });
    await startThread(page, 'Start in the worktree.');

    // The thread sits under its repository, beside the two in the repository's
    // own checkout: the worktree is a checkout, never a section of its own.
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('3', {
      timeout: 30_000,
    });
    await expect(folderHeader(page, worktreeName)).toHaveCount(0);
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(3);
    // The section is the project's: the repository's folder reaches the panel with the project
    // its record names (ADR-0034, owner decisions 2026-11-10).
    const repositoryProjectId = await page.evaluate(async (rootId) => {
      const catalog = (
        window as unknown as {
          threadGroups: {
            readRoots(): Promise<{
              readonly value?: readonly { readonly id: string; readonly projectId: unknown }[];
            }>;
          };
        }
      ).threadGroups;
      const reply = await catalog.readRoots();
      return reply.value?.find((root) => root.id === rootId)?.projectId;
    }, ROOT_ID);
    expect(repositoryProjectId).toEqual(expect.stringMatching(/\S/u));
    const worktreeChips = page
      .getByTestId('thread-checkout-chip')
      .filter({ hasText: worktreeName });
    await expect(worktreeChips).toHaveCount(1);
    await expect(worktreeChips).toBeVisible();
    for (const title of BOUND_THREAD_TITLES) {
      await expect(checkoutChip(page, title)).toHaveText('Local');
    }
  });

  test('starts a thread inside a folder and empties the list behind a Show only filter', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const { repo } = await seedFoldersFixture(page, electron.getUserDataDir());
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2', {
      timeout: 30_000,
    });
    const rowsBefore = await page.getByTestId('thread-row').count();
    const sectionsBefore = await page.getByTestId('thread-folder-header').count();

    // "New thread here" opens the new-thread screen for this folder and creates
    // nothing; the first send is createThread + ONE metadata write carrying the
    // whole binding, so the new row lands INSIDE this folder rather than under
    // "No project" — which is exactly what the two section counts report.
    await repoSection.getByTestId('thread-folder-new-thread').click();
    const welcome = page.getByTestId('new-thread-welcome');
    // The new thread's composer names the folder it will start in.
    await expect(whereChip(welcome)).toContainText(path.basename(repo));
    await expect(page.getByTestId('thread-row')).toHaveCount(rowsBefore);
    await startThread(page, 'Start here.');
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('3', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('thread-row')).toHaveCount(rowsBefore + 1, { timeout: 30_000 });
    // Unchanged: the new thread was born BOUND, so it did not land with the seeded unbound one.
    await expect(folderHeader(page, 'No project').getByTestId('thread-folder-count')).toHaveText(
      '1'
    );

    // No run has ever started here, so "Running" matches nothing. The panel must
    // name the FILTERS rather than claim there are no threads — the remedy for
    // "No threads found" (create one) would not bring any of these back.
    await toggleShowOnly(page, 'Running');
    await expect(page.getByTestId('threads-filtered-empty-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('thread-row')).toHaveCount(0);
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(0);

    // …and clearing it restores every row, so the filter hid them rather than
    // the panel losing them.
    await toggleShowOnly(page, 'Running');
    await expect(page.getByTestId('threads-filtered-empty-card')).toHaveCount(0);
    await expect(page.getByTestId('thread-row')).toHaveCount(rowsBefore + 1, { timeout: 15_000 });
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(sectionsBefore);
  });
});
