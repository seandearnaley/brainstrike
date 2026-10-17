import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * BST-1269/BST-1318 per-file explorer panes: every open file tab hosts a
 * navigation-only tree pane by default, docked on the RIGHT and revealed to
 * the file's location. A manual close is sticky per file (persisted through
 * the per-thread workspace snapshot).
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

    // Activate the default thread, a row in the Threads library, so the thread
    // store registers it as the ACTIVE thread — per-thread workspace saves key
    // off that identity.
    await page
      .getByRole('treegrid', { name: 'Workspace threads' })
      .getByRole('button', { exact: true, name: 'New Thread' })
      .click();

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

  test('pane auto-opens with the file, docked right, revealed to its location', async ({
    page,
  }) => {
    // No toggle needed: opening the file opened the pane (BST-1318).
    const pane = page.getByTestId('file-tab-explorer-pane');
    await expect(pane).toBeVisible();

    // Revealed to the file: its ancestor directory is expanded so the file's
    // row is present in the PANE tree.
    const paneTree = pane.getByRole('treegrid', { name: 'File explorer pane' });
    await expect(paneTree).toBeVisible();
    await expect(paneTree.getByText('app.ts', { exact: true })).toBeVisible();

    // Navigation-only: no selection checkboxes inside the pane.
    await expect(pane.getByRole('checkbox')).toHaveCount(0);

    // Docked RIGHT: the pane sits to the right of the file content surface.
    const contentBox = await page.getByTestId('file-code-surface').boundingBox();
    const paneBox = await pane.boundingBox();
    if (!(contentBox && paneBox)) {
      throw new Error('expected both content and pane to have geometry');
    }
    expect(paneBox.x).toBeGreaterThan(contentBox.x + contentBox.width - 1);

    // Toggle closes it.
    await page.getByRole('button', { name: 'Toggle explorer pane' }).click();
    await expect(page.getByTestId('file-tab-explorer-pane')).toHaveCount(0);
  });

  test('manual close sticks per file across reload; the toggle reopens', async ({ page }) => {
    // Close the auto-opened pane — this records an EXPLICIT open: false that
    // must survive through the per-thread workspace snapshot.
    await page.getByRole('button', { name: 'Toggle explorer pane' }).click();
    await expect(page.getByTestId('file-tab-explorer-pane')).toHaveCount(0);

    // Wait out the thread-workspace save debounce, then reload.
    await page.waitForTimeout(900);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    // The tab restores (hydration is DB-backed, allow the PGlite boot)…
    await expect(
      page.getByTestId('workspace-tab-strip').getByRole('tab', { name: /app\.ts/ })
    ).toBeVisible({ timeout: 20_000 });
    // …and the pane stays CLOSED: absent state means open, so a restored
    // closed pane proves the sticky close round-tripped as explicit state.
    await expect(page.getByTestId('file-tab-explorer-pane')).toHaveCount(0);

    // The header toggle reopens it. The mock harness cannot restore directory
    // handles across reload, so the reopened pane shows its explicit
    // not-connected state instead of a tree — visible degradation, not a
    // silent fallback. Tree re-population is covered by the scoping unit
    // tests and desktop live verification.
    await page.getByRole('button', { name: 'Toggle explorer pane' }).click();
    const pane = page.getByTestId('file-tab-explorer-pane');
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId('file-tab-pane-unavailable')).toBeVisible();
  });
});
