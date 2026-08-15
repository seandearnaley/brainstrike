import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * BST-1269 per-file explorer panes: each open file tab can host a
 * navigation-only tree pane (Cursor idiom) that reveals the file's location,
 * with clickable header breadcrumbs revealing folders.
 */
test.describe('Per-file explorer pane', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'readme.md': null,
      src: {
        'app.ts': null,
        ui: {
          'button.ts': null,
        },
      },
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    // Activate the default thread tab so the thread store registers it as the
    // ACTIVE thread — per-thread workspace saves key off that identity.
    await page.getByRole('tab', { name: 'New Thread' }).click();

    // Connect the root and open src/app.ts as a file tab.
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();
    await fileTree
      .getByRole('row')
      .filter({ hasText: 'src' })
      .first()
      .getByRole('button', { name: 'Expand' })
      .click();
    const fileLabel = fileTree.getByText('app.ts', { exact: true });
    await fileLabel.scrollIntoViewIfNeeded();
    await fileLabel.click();
    await expect(
      page.getByTestId('workspace-tab-strip').getByRole('tab', { name: /app\.ts/ })
    ).toBeVisible();
  });

  test('toggle opens a navigation-only pane revealed at the file location', async ({ page }) => {
    await expect(page.getByTestId('file-tab-explorer-pane')).toHaveCount(0);

    await page.getByRole('button', { name: 'Toggle explorer pane' }).click();
    const pane = page.getByTestId('file-tab-explorer-pane');
    await expect(pane).toBeVisible();

    // The pane auto-reveals the file's location: its ancestor directory is
    // expanded so the file's row is present in the PANE tree.
    const paneTree = pane.getByRole('treegrid', { name: 'File explorer pane' });
    await expect(paneTree).toBeVisible();
    await expect(paneTree.getByText('app.ts', { exact: true })).toBeVisible();

    // Navigation-only: no selection checkboxes inside the pane.
    await expect(pane.getByRole('checkbox')).toHaveCount(0);

    // Toggle again closes it.
    await page.getByRole('button', { name: 'Toggle explorer pane' }).click();
    await expect(page.getByTestId('file-tab-explorer-pane')).toHaveCount(0);
  });

  test('breadcrumb click opens the pane and reveals the folder; state survives reload', async ({
    page,
  }) => {
    // Header breadcrumbs: src › app.ts (leaf is current page, not a button).
    const header = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(header).toBeVisible();
    await header.getByRole('button', { exact: true, name: 'src' }).click();

    const pane = page.getByTestId('file-tab-explorer-pane');
    await expect(pane).toBeVisible();
    const paneTree = pane.getByRole('treegrid', { name: 'File explorer pane' });
    await expect(paneTree.getByText('ui', { exact: true })).toBeVisible();

    // Expand a pane-local folder; the WORKSPACE Files tree must not follow.
    await paneTree.getByText('ui', { exact: true }).click();

    // Wait out the thread-workspace save debounce, then reload: the pane
    // (open state + expansions) restores with the tab.
    await page.waitForTimeout(900);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    // The pane's OPEN state restores from the thread workspace snapshot (the
    // hydration is DB-backed, so allow the PGlite boot).
    const restoredPane = page.getByTestId('file-tab-explorer-pane');
    await expect(restoredPane).toBeVisible({ timeout: 20_000 });

    // The mock harness cannot restore directory handles across reload, so the
    // pane shows its explicit not-connected state instead of a tree — proving
    // the OPEN/width state round-tripped through the per-thread snapshot
    // while degrading visibly (no silent fallback). Tree re-population with
    // the persisted pane expansions is covered by the scoping unit tests and
    // desktop live verification, where real handles survive restarts.
    await expect(restoredPane.getByTestId('file-tab-pane-unavailable')).toBeVisible();
  });
});
