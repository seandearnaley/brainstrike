/**
 * Desktop E2E for the Threads panel's `Group by → Folder` view (BST-1388 W2).
 *
 * Drives the BUILT Electron app against a REAL `git init`'d folder so the
 * whole chain under test is production code: main's root registry, renderer
 * root reconciliation into the durable `roots` table, `useThreadFolderRows`'
 * batched `roots` lookup, `useThreadBranchByRootPath`'s `window.changes` git
 * inventory, `buildThreadListSections`' folder view, and the folder header's
 * "New thread here" bind. Nothing about the panel is mocked.
 *
 * SEEDING (see `utils/seed-threads.ts` for the full rationale): a thread's
 * folder binding is written at its FIRST REQUEST, so the only product gesture
 * that mints a bound thread is "New thread here" — which needs a folder
 * section, which needs a bound thread. The rows the first request would have
 * written are seeded through the renderer's `electronAPI.db` bridge instead,
 * against the DURABLE `roots.id` read back from the database rather than the
 * adapter root id seeded into main's ledger (W1 proved those diverge).
 *
 * Isolation: a fresh temp repo per test plus the fixture's per-test
 * `userDataDir`, so neither main's `rootsList` nor the PGlite database can
 * leak between tests. Temp dirs are tracked and removed in `afterAll`.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { freshRepo as createFreshRepo, createTempDirTracker } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';
import {
  seedThreadRows,
  waitForMastraMemorySchema,
  waitForSingleWorkspaceRootRow,
} from './utils/seed-threads';

const tempDirs = createTempDirTracker();

const ROOT_ID = 'w2-thread-folders-root-00000000-0000-4000-8000-000000000020';

const BOUND_THREAD_TITLES = ['W2 bound alpha', 'W2 bound beta'] as const;
const UNBOUND_THREAD_TITLE = 'W2 unbound gamma';

/**
 * A real repo, mounted by its REAL path.
 *
 * `realpathSync` is load-bearing, not tidiness. On macOS `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`; git reports the
 * resolved form, so this fixture resolves the path before seeding `roots.path`.
 * The branch lookup is durable-ID-first. Its unambiguous containment map handles
 * symlink skew directly; when a root checkout and one of its nested worktrees
 * both claim the same root id, an exact durable-id + normalized-path claim
 * selects the root checkout without borrowing a same-path replacement root.
 * Resolving the fixture path therefore keeps the live branch assertion focused
 * on the ordinary real-path checkout rather than platform path spelling.
 */
function freshRepo(label: string): string {
  return realpathSync(
    createFreshRepo({ label, prefix: 'bst-threads-folders-', tracker: tempDirs })
  );
}

/**
 * Seed the workspace ledgers AND a wide left panel, then reload.
 *
 * The panel width is part of the fixture, not decoration: the row's metadata
 * badges — the branch chip among them — are behind a `@[420px]/threads`
 * container query, and the default 25% left panel is narrower than that on a
 * 1536px window. Seeding the layout store makes the badge's visibility a
 * FACT ABOUT THE BADGE rather than a fact about the panel's default size.
 * Background indexing is seeded OFF: nothing here reads the index, and driving
 * the embedding pipeline would add minutes and flake surface for no coverage.
 */
async function seedWorkspace(page: Page, rootPath: string): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      'panel-layout-store.v1',
      JSON.stringify({
        state: {
          showConsole: false,
          showLeftPanel: true,
          showRightPanel: true,
          sizes: [45, 15, 20],
        },
        version: 4,
      })
    );
  });
  await seedWorkspaceRoot(page, rootPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w2-thread-folders-seed-root',
    rootId: ROOT_ID,
  });
}

/**
 * Bring the Threads panel on screen. `setupAssistantMock` runs AFTER the last
 * reload on purpose: it installs through `page.evaluate`, so a reload would
 * wipe it — and without an available assistant the workspace shell that hosts
 * the library sidebar never renders.
 */
async function openThreadsPanel(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

/** Switch the view-options popover's `Group by` radiogroup to Folder. */
async function groupByFolder(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'View options' }).click();
  const groupBy = page.getByRole('radiogroup', { name: 'Group by' });
  await expect(groupBy).toBeVisible({ timeout: 15_000 });
  // The radio input itself is `sr-only`; the label text is the real target and
  // the click reaches the input through the wrapping <label>.
  await groupBy.getByText('Folder', { exact: true }).click();
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

/**
 * Seed one git root plus the three threads every test starts from (two bound
 * to that root, one unbound), and land in folder grouping with the panel open.
 */
async function seedFoldersFixture(page: Page): Promise<{ repo: string }> {
  const repo = freshRepo('repo');
  await seedWorkspace(page, repo);
  const root = await waitForSingleWorkspaceRootRow(page);
  expect(root.displayName).toBe(path.basename(repo));

  // Opening the panel first is what CREATES the Mastra memory schema (the
  // renderer's assistant memory initialization); the probe turns that into a
  // fact instead of a sleep, because a missing relation would abort the
  // INSERT's transaction rather than merely fail it.
  await openThreadsPanel(page);
  await waitForMastraMemorySchema(page);
  // The bootstrap thread is a PRECONDITION of the counts below, not a
  // bystander. An EMPTY resource mints one — `loadResourceThreadsForGeneration`
  // in `assistant-thread-store.ts` calls `createThread` when `listThreads`
  // comes back empty — and both tests read `No folder` as TWO threads: that one
  // plus the seeded unbound row. The schema probe proves only that the RELATION
  // exists, and nothing orders these INSERTs against that `listThreads`, so
  // seeding first could make it non-empty; the bootstrap thread would then
  // never be created and `No folder` would render 1. Waiting for the row makes
  // the ordering a fact rather than a race against `DatabaseWorkScheduler`.
  // (`assistant-compaction.desktop.test.ts` gets the same ordering for free:
  // `seedCompactionSummaryThread` reads `resourceId` off an existing
  // `mastra_threads` row and throws when there is none.)
  await expect(page.getByTestId('thread-row')).toHaveCount(1, { timeout: 30_000 });
  await seedThreadRows(page, [
    { folder: null, title: UNBOUND_THREAD_TITLE },
    { folder: root, title: BOUND_THREAD_TITLES[0] },
    { folder: root, title: BOUND_THREAD_TITLES[1] },
  ]);
  // The thread store loads once per resource on mount, so rows inserted behind
  // it only reach the panel after a reload.
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'w2-thread-folders-seed-threads');

  await openThreadsPanel(page);
  // Wait for the seeded rows BY NAME rather than by a total count: the count
  // would also have to predict anything else the shell created, and each named
  // row is what the assertions below actually address.
  for (const title of [...BOUND_THREAD_TITLES, UNBOUND_THREAD_TITLE]) {
    await expect(threadRow(page, title)).toHaveCount(1, { timeout: 30_000 });
  }
  await groupByFolder(page);
  return { repo };
}

test.afterAll(() => {
  tempDirs.removeAll();
});

test.describe('Threads panel folder grouping (desktop)', () => {
  test('@smoke groups threads by their folder, trails a No folder section, and badges the branch', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    const { repo } = await seedFoldersFixture(page);

    // TWO sections: the root's own, and the trailing catch-all. The trailing
    // section is NOT decoration — it is where a thread with no binding has to
    // land, and its absence would mean the unbound thread vanished.
    await expect(page.getByTestId('thread-folder-header')).toHaveCount(2, { timeout: 30_000 });
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection).toHaveCount(1);
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2');

    const unassignedSection = folderHeader(page, 'No folder');
    await expect(unassignedSection).toHaveCount(1);
    // TWO unbound threads, not one: the seeded one plus the thread an EMPTY
    // resource bootstraps on its first load (`loadResourceThreadsForGeneration`
    // in `assistant-thread-store.ts` creates one when `listThreads` comes back
    // empty). That thread is real, has never made a request, and therefore has
    // no binding — so the catch-all is exactly where it belongs.
    await expect(unassignedSection.getByTestId('thread-folder-count')).toHaveText('2');
    // "New thread here" belongs to a FOLDER, so the catch-all must not offer it.
    await expect(unassignedSection.getByTestId('thread-folder-new-thread')).toHaveCount(0);

    // The branch badge is the row's most local fact in folder grouping, and it
    // comes from the real `window.changes` git inventory keyed by the root's
    // path — a bound row gets `main`, the unbound row has no root to key on and
    // therefore no badge at all (with no runs seeded there is no provider or
    // model badge either, so the whole badge strip is absent).
    for (const title of BOUND_THREAD_TITLES) {
      await expect(threadRow(page, title).getByTestId('thread-metadata-badges')).toHaveText(
        'main',
        {
          timeout: 30_000,
        }
      );
    }
    await expect(
      threadRow(page, UNBOUND_THREAD_TITLE).getByTestId('thread-metadata-badges')
    ).toHaveCount(0);
  });

  test('starts a thread inside a folder and empties the list behind a Show only filter', async ({
    window: page,
  }) => {
    test.setTimeout(120_000);
    const { repo } = await seedFoldersFixture(page);
    const repoSection = folderHeader(page, path.basename(repo));
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('2', {
      timeout: 30_000,
    });
    const rowsBefore = await page.getByTestId('thread-row').count();

    // "New thread here" is createThread + ONE metadata write carrying the whole
    // binding, so the new row lands INSIDE this folder rather than under
    // "No folder" — which is exactly what the two section counts report.
    await repoSection.getByTestId('thread-folder-new-thread').click();
    await expect(repoSection.getByTestId('thread-folder-count')).toHaveText('3', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('thread-row')).toHaveCount(rowsBefore + 1, { timeout: 30_000 });
    // Unchanged: the new thread was born BOUND, so it did not land here (the
    // two unbound threads are the seeded one and the empty-resource bootstrap).
    await expect(folderHeader(page, 'No folder').getByTestId('thread-folder-count')).toHaveText(
      '2'
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
  });
});
