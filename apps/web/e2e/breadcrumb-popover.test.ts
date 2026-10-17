import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * BST-1319 breadcrumb popover mini-tree: clicking a breadcrumb segment opens
 * a popover listing that segment's SIBLINGS (its parent directory's
 * contents), the clicked segment highlighted, directories drill down in
 * place, and picking a file opens it in a new tab.
 */
test.describe('Breadcrumb popover mini-tree', () => {
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
    // The default thread is a row in the Threads library, not a tab.
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

  test('a directory segment lists its siblings (root level) with itself highlighted', async ({
    page,
  }) => {
    const header = page.getByRole('navigation', { name: 'Breadcrumb' });
    await header.getByRole('button', { exact: true, name: 'src' }).click();

    // The 'src' segment's siblings are the ROOT's contents.
    const miniTree = page.getByTestId('breadcrumb-mini-tree');
    await expect(miniTree).toBeVisible();
    await expect(miniTree.getByRole('row', { name: /readme.md/ })).toBeVisible();
    const srcItem = miniTree.getByRole('row', { name: /src/ });
    await expect(srcItem).toHaveAttribute('aria-selected', 'true');

    // Drill down in place: expanding src reveals its children indented.
    await srcItem.click();
    await expect(miniTree.getByRole('row', { name: /app.ts/ })).toBeVisible();
    await expect(miniTree.getByRole('row', { name: /ui/ })).toBeVisible();

    // Escape dismisses without navigating; the tab set is unchanged.
    await page.keyboard.press('Escape');
    await expect(miniTree).toHaveCount(0);
  });

  test('the leaf segment lists sibling files; picking one opens a NEW tab', async ({ page }) => {
    const header = page.getByRole('navigation', { name: 'Breadcrumb' });
    await header.getByRole('button', { exact: true, name: 'app.ts' }).click();

    // The leaf's siblings are src's contents, the file itself highlighted.
    const miniTree = page.getByTestId('breadcrumb-mini-tree');
    await expect(miniTree).toBeVisible();
    await expect(miniTree.getByRole('row', { name: /app.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Drill into the sibling directory and pick a file.
    await miniTree.getByRole('row', { name: /ui/ }).click();
    await miniTree.getByRole('row', { name: /button.ts/ }).click();

    // The popover closes and the picked file opens in a NEW tab; the original
    // tab is still there.
    await expect(page.getByTestId('breadcrumb-mini-tree')).toHaveCount(0);
    const strip = page.getByTestId('workspace-tab-strip');
    await expect(strip.getByRole('tab', { name: /button\.ts/ })).toBeVisible();
    await expect(strip.getByRole('tab', { name: /app\.ts/ })).toBeVisible();
  });
});
