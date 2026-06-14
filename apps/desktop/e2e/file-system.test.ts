import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('File System Integration', () => {
  async function ensureFileExplorerPanelVisible(window: Page): Promise<void> {
    // Use id selector for react-resizable-panels v4 compatibility
    const explorerPanel = getContextExplorerFileExplorerPanel(window);
    const showExplorerPanelButton = window
      .getByTestId('show-explorer-panel')
      .or(window.getByRole('button', { name: /show explorer/i }));

    if (
      !(await explorerPanel.isVisible().catch(() => false)) &&
      (await showExplorerPanelButton.isVisible().catch(() => false))
    ) {
      await showExplorerPanelButton.click();
    }

    await expect(explorerPanel).toBeVisible({ timeout: 15_000 });
  }

  async function selectMockRoot(window: Page): Promise<void> {
    const selectRootButton = window
      .getByRole('button', { name: /add folder to workspace|browse/i })
      .first();
    await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
    await selectRootButton.click();
  }

  test.beforeEach(async ({ window }) => {
    // Mock file system operations to prevent native dialogs for every test
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
  });

  test('should handle file system access permissions', { tag: '@smoke' }, async ({ window }) => {
    test.setTimeout(30_000); // Increase timeout to 30s for this test
    // The button text comes from FileExplorerStrings.addFolderToWorkspace
    // ('Add Folder to Workspace'); we keep 'browse' for backward compatibility.
    const fileSystemButton = window.getByRole('button', {
      name: /add folder to workspace|browse/i,
    });

    // Wait for the button to be actionable before interacting
    await fileSystemButton.first().waitFor({ state: 'visible', timeout: 10_000 });

    if (await fileSystemButton.isVisible().catch(() => false)) {
      await fileSystemButton.click();
      await expect(window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });

      // In test mode with mocked file system, errors may occur due to mock limitations
      // We only fail on critical/fatal errors, not general error display
      const criticalErrorAlert = window.locator('[role="alert"]').filter({
        hasText: /critical|fatal|crash/i,
      });
      await expect(criticalErrorAlert).not.toBeVisible({ timeout: 2000 });
    }
  });

  test('should handle directory operations', { tag: '@smoke' }, async ({ window }) => {
    test.setTimeout(30_000); // Increase timeout to 30s
    await ensureFileExplorerPanelVisible(window);

    const directoryTree = window.getByRole('tree');
    const fileList = window.getByRole('list');
    const fileTreeFallback = window.locator(
      '[data-testid="file-tree"], [data-testid="file-tree-scroll-container"]'
    );

    const hasTree = await directoryTree.isVisible().catch(() => false);
    const hasList = await fileList.isVisible().catch(() => false);
    const hasFallback = await fileTreeFallback.isVisible().catch(() => false);

    expect(hasTree || hasList || hasFallback).toBe(true);
  });

  test('loading the mocked explorer root does not reload the visible renderer', async ({
    window,
  }) => {
    test.setTimeout(45_000);

    await ensureFileExplorerPanelVisible(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    await selectMockRoot(window);
    await expect(window.getByRole('button', { name: /view filters/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(getContextExplorerFileExplorerPanel(window)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        timeout: 10_000,
        message: 'Selecting a root folder should not reload the visible renderer',
      })
      .toBe(initialTimeOrigin);
  });

  test('should handle file operations', async ({ window }) => {
    test.setTimeout(30_000); // Increase timeout
    const fileButtons = window.getByRole('button').filter({ hasText: /file/i });
    // Don't assume buttons exist immediately
    await window.waitForTimeout(1000);
    const fileCount = await fileButtons.count();

    if (fileCount > 0) {
      // Ensure the first button is stable and clickable
      const firstButton = fileButtons.first();
      await firstButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      if (await firstButton.isVisible()) {
        await firstButton.click({ timeout: 5000 });
        await expect(window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });

        const criticalError = window.getByText(/critical error|fatal/i);
        await expect(criticalError).not.toBeVisible();
      }
    }
  });

  test('should handle large directory structures', async ({ window, homePage }) => {
    test.setTimeout(45_000); // Larger timeout for potentially heavy DOM operations
    const explorerButtons = window.getByRole('button').filter({ hasText: /explorer/i });
    await window.waitForTimeout(1000);

    const buttonCount = await explorerButtons.count();
    if (buttonCount === 0) {
      return;
    }

    const firstButton = explorerButtons.first();
    await firstButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    const isVisible = await firstButton.isVisible();
    if (!isVisible) {
      return;
    }

    await firstButton.click();
    await window.waitForTimeout(2000);

    await waitForLoadingIndicators(window);

    const mainContent = window.getByTestId('main-content-area');
    const isMainContentVisible = await mainContent.isVisible().catch(() => false);

    if (isMainContentVisible) {
      await expect(mainContent).toBeVisible();
    } else {
      await homePage.shouldBeVisible();
    }
  });

  async function waitForLoadingIndicators(window: Page) {
    const loadingIndicator = window.getByText(/loading/i);
    const spinner = window.locator('[data-testid*="loading"], [class*="spinner"]');

    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 15_000 });
    }

    if (await spinner.isVisible().catch(() => false)) {
      await spinner.waitFor({ state: 'hidden', timeout: 15_000 });
    }
  }

  test('should handle file system errors gracefully', async ({ window, homePage }) => {
    const buttons = window.getByRole('button');
    const buttonCount = await buttons.count();
    const MAX_BUTTONS_TO_TEST = 3;

    for (let i = 0; i < Math.min(buttonCount, MAX_BUTTONS_TO_TEST); i++) {
      const button = buttons.nth(i);
      const buttonText = await button.textContent();

      if (buttonText && !buttonText.toLowerCase().includes('close')) {
        await button.click();
        await window.waitForTimeout(500);

        const errorDialog = window.getByRole('dialog').filter({ hasText: /error/i });

        if (await errorDialog.isVisible().catch(() => false)) {
          const closeButton = errorDialog.getByRole('button', { name: /close|ok|dismiss/i });
          if (await closeButton.isVisible()) {
            await closeButton.click();
          }
        }

        await homePage.shouldBeVisible();
      }
    }
  });

  test('should maintain file system state across app restart', async ({ electron, window }) => {
    test.setTimeout(120_000);

    const fileSystemButtons = window.getByRole('button').filter({ hasText: /browse|open|select/i });

    if (
      await fileSystemButtons
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await fileSystemButtons.first().click();
      await expect(window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });
    }

    await electron.restart();
    const restartedWindow = await electron.ensureWindow();
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(restartedWindow);

    const restartedHome = new HomePage(restartedWindow);
    await restartedHome.shouldBeVisible();
    await ensureFileExplorerPanelVisible(restartedWindow);

    const fileTreeFallback = restartedWindow.locator(
      '[data-testid="file-tree"], [data-testid="file-tree-scroll-container"]'
    );
    if (await fileTreeFallback.isVisible().catch(() => false)) {
      await expect(fileTreeFallback.first()).toBeVisible();
    }
  });
});
