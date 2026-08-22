import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { waitForAppLoad, waitForDatabaseReady } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * Web E2E for the Threads panel's `Group by → Folder` view (BST-1388 W2).
 *
 * Web's capability surface is deliberately SMALLER than desktop's. Folder
 * GROUPING itself is shared — it reads `metadata.operatingRootId` and the
 * `roots` table, both of which web has — but the row's `⎇ branch` badge is
 * desktop-only: `useThreadBranchByRootPath` needs the `window.changes` git
 * inventory, and web omits what it cannot do rather than inventing a chip
 * (`docs/agents/assistant-persistence.md` § THREAD GROUPS). This pins both
 * halves: the grouping option is offered, and no branch badge ever renders.
 *
 * A thread's folder binding is written at its FIRST REQUEST, so the thread
 * this app boot bootstraps has none — which is exactly the state under test:
 * every unbound thread lands in the trailing "No folder" section, and that
 * section carries no "New thread here" action because there is no folder to
 * start a thread in.
 *
 * ONE test, tagged `@web-smoke` so it runs on every PR: the Folder option, the
 * "No folder" section and the missing branch badge share one app boot and one
 * readiness precondition, so splitting them would buy a second full boot and
 * nothing else.
 */
const ROOT_NAME = 'threads-panel-folders-root';
const TREE: FileTree = { 'alpha.ts': null };

test.describe('Threads panel folder grouping (web)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrowserApis(page, ROOT_NAME, TREE);
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    // Threads live in PGlite and the New thread control is disabled until the
    // memory repository exists, so this surface genuinely needs the database.
    await waitForDatabaseReady(page);
  });

  test('offers Folder grouping, files an unbound thread under No folder, and never shows a branch badge', {
    tag: '@web-smoke',
  }, async ({ page }) => {
    await page.getByTestId('threads-tab-trigger').click();
    await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });

    // The one thread here is the one an EMPTY resource bootstraps on its first
    // load (`loadResourceThreadsForGeneration` in `assistant-thread-store.ts`).
    // It has never made a request, so it has no folder binding — exactly the
    // state under test, and no extra gesture is needed to produce it.
    await expect(page.getByTestId('thread-row')).toHaveCount(1, { timeout: 30_000 });

    await page.getByRole('button', { name: 'View options' }).click();
    const groupBy = page.getByRole('radiogroup', { name: 'Group by' });
    await expect(groupBy).toBeVisible({ timeout: 15_000 });
    // The radio input itself is `sr-only`; the label text is the real target
    // and the click reaches the input through the wrapping <label>.
    await groupBy.getByText('Folder', { exact: true }).click();
    await page.keyboard.press('Escape');

    // ONE section, and it is the catch-all: the thread has no
    // `operatingRootId`, and a folder section is a view over BOUND threads,
    // never a mirror of the mount list — so the workspace root above
    // produces no section of its own.
    const headers = page.getByTestId('thread-folder-header');
    await expect(headers).toHaveCount(1, { timeout: 30_000 });
    await expect(headers).toContainText('No folder');
    await expect(headers.getByTestId('thread-folder-count')).toHaveText('1');
    await expect(headers.getByTestId('thread-folder-new-thread')).toHaveCount(0);

    // No branch badge — and not merely because this thread is unbound: web
    // has no `window.changes` bridge at all, so the inventory the badge reads
    // cannot exist here. Both facts are asserted, because the second is the
    // one that would still hold for a bound thread.
    await expect(page.getByTestId('thread-metadata-badges')).toHaveCount(0);
    const hasChangesBridge = await page.evaluate(
      () => Reflect.get(globalThis, 'changes') !== undefined
    );
    expect(hasChangesBridge).toBe(false);
  });
});
