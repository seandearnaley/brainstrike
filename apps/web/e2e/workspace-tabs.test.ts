import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * BST-1258 unified workspace tab panel: ONE strip in the workspace panel's
 * header row hosting closable singleton app tabs (Files on web) plus file
 * tabs, an empty-state launcher, and persistence of the open set across
 * reloads.
 */
test.describe('Unified workspace tab panel', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'alpha.ts': null,
      'beta.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('renders exactly one strip, inside the workspace panel header row', async ({ page }) => {
    const strip = page.getByTestId('workspace-tab-strip');
    await expect(strip).toHaveCount(1);
    await expect(strip).toBeVisible();

    // The strip lives INSIDE the right panel header (same row as the collapse
    // button) — not in a second chrome row of its own.
    const header = page.getByTestId('right-panel-header').filter({ has: strip });
    await expect(header).toHaveCount(1);
    await expect(header.getByTestId('hide-workspace-panel')).toBeVisible();

    // Files is the default open app tab.
    const filesTab = page.getByTestId('workspace-app-tab-context-explorer');
    await expect(filesTab).toBeVisible();
    await expect(filesTab).toHaveText(/Files/);
  });

  test('opening a file lands its tab in the header strip', async ({ page }) => {
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    const fileLabel = fileTree.getByText('alpha.ts', { exact: true });
    await fileLabel.scrollIntoViewIfNeeded();
    await fileLabel.click();

    const fileTab = page.getByRole('tab', { name: /alpha\.ts/ }).first();
    await expect(fileTab).toBeVisible();
    // The file tab is inside the SAME header strip as the app tab.
    await expect(
      page.getByTestId('workspace-tab-strip').getByRole('tab', { name: /alpha\.ts/ })
    ).toBeVisible();
    await expect(page.getByText('alpha.ts content')).toBeVisible();
  });

  test('closing every tab reveals the launcher; a launcher card reopens Files', async ({
    page,
  }) => {
    // Close the Files app tab (the only open tab on a fresh web session).
    await page.getByTestId('workspace-app-tab-close-context-explorer').click();

    const launcher = page.getByTestId('workspace-launcher');
    await expect(launcher).toBeVisible();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toHaveCount(0);
    // Web registers only the Files app — exactly one launcher card, no stubs.
    await expect(page.getByTestId('workspace-launcher-open-context-explorer')).toBeVisible();
    await expect(page.getByTestId('workspace-launcher-open-changes')).toHaveCount(0);
    await expect(page.getByTestId('workspace-launcher-open-canvas')).toHaveCount(0);
    // The strip idles with the panel label.
    await expect(page.getByTestId('workspace-tab-strip')).toContainText('Workspace');

    await page.getByTestId('workspace-launcher-open-context-explorer').click();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
    await expect(launcher).toHaveCount(0);
  });

  test('open tabs and the active selection persist across a reload', async ({ page }) => {
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();

    await fileTree.getByText('alpha.ts', { exact: true }).click();
    await expect(page.getByRole('tab', { name: /alpha\.ts/ }).first()).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    // The file tab is restored in the strip and still the active selection.
    const restoredTab = page.getByTestId('workspace-tab-strip').getByRole('tab', {
      name: /alpha\.ts/,
    });
    await expect(restoredTab).toBeVisible();
    await expect(restoredTab).toHaveAttribute('aria-selected', 'true');
    // Files app tab is restored too (open set persists, not just files).
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
  });

  test('the empty-state launcher persists across a reload (no default resurrection)', async ({
    page,
  }) => {
    await page.getByTestId('workspace-app-tab-close-context-explorer').click();
    await expect(page.getByTestId('workspace-launcher')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    await expect(page.getByTestId('workspace-launcher')).toBeVisible();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toHaveCount(0);
  });

  test('collapse and re-expand keep working with the strip in the header', async ({ page }) => {
    await expect(page.getByTestId('workspace-tab-strip')).toBeVisible();

    await page.getByTestId('hide-workspace-panel').click();
    await expect(page.getByTestId('show-workspace-panel')).toBeVisible();
    // The collapsed panel clips the strip: its padded box sits past the
    // viewport edge, so the user sees none of it.
    await expect(page.getByTestId('workspace-tab-strip')).not.toBeInViewport();

    await page.getByTestId('show-workspace-panel').click();
    await expect(page.getByTestId('workspace-tab-strip')).toBeVisible();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
  });

  test('file tabs reorder by drag and the order survives a reload', async ({ page }) => {
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();
    await fileTree.getByText('alpha.ts', { exact: true }).click();
    // Opening a file shows its tab; go back to Files for the second one.
    await page.getByTestId('workspace-app-tab-context-explorer').click();
    await fileTree.getByText('beta.ts', { exact: true }).click();

    const scroller = page.getByTestId('workspace-tab-scroll');
    const alphaTab = scroller.getByRole('tab', { name: /alpha\.ts/ });
    const betaTab = scroller.getByRole('tab', { name: /beta\.ts/ });
    await expect(scroller.getByRole('tab')).toHaveText([/alpha\.ts/, /beta\.ts/]);

    // Native drag onto alpha's left edge (the ui browser lane covers drop resolution).
    await betaTab.dragTo(alphaTab, { targetPosition: { x: 4, y: 10 } });
    await expect(scroller.getByRole('tab')).toHaveText([/beta\.ts/, /alpha\.ts/]);

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await expect(page.getByTestId('workspace-tab-scroll').getByRole('tab')).toHaveText([
      /beta\.ts/,
      /alpha\.ts/,
    ]);
  });

  test('the tab scroller never shows a scrollbar', async ({ page }) => {
    const scroller = page.getByTestId('workspace-tab-scroll');
    await expect(scroller).toBeVisible();
    const scrollbarWidth = await scroller.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('scrollbar-width')
    );
    expect(scrollbarWidth.trim()).toBe('none');
  });

  test("the '+' menu lists only registered apps and re-activates the singleton (BST-1270)", async ({
    page,
  }) => {
    const addButton = page.getByTestId('workspace-add-tab');
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Web registers Files only — capability gating by omission, so no
    // Changes/Canvas/Terminal items and no disabled stubs.
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Files/ })).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(1);

    await menu.getByRole('menuitem', { name: /Files/ }).click();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Singleton: picking Files again re-activates the SAME tab, never a second.
    await addButton.click();
    await page.getByRole('menu').getByRole('menuitem', { name: /Files/ }).click();
    await expect(page.getByTestId('workspace-app-tab-context-explorer')).toHaveCount(1);
  });
});
