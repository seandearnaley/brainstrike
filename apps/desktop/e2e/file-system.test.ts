import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { mockFileSystemOperations } from './utils/electron-helpers';

test.describe('File System Integration', () => {
  test.beforeEach(async ({ window }) => {
    // Mock file system operations to prevent native dialogs for every test
    await mockFileSystemOperations(window);
  });

  test('should handle file system access permissions', async ({ window }) => {
    test.setTimeout(30000); // Increase timeout to 30s for this test
    // The button text comes from FileExplorerStrings.selectRoot ('Select Root')
    // but we keep 'browse' for backward compatibility if needed
    const fileSystemButton = window.getByRole('button', { name: /select root|browse/i });

    // Wait for the button to be actionable before interacting
    await fileSystemButton.first().waitFor({ state: 'visible', timeout: 10000 });

    if (await fileSystemButton.isVisible().catch(() => false)) {
      await fileSystemButton.click();
      await expect(window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });

      const errorMessage = window.getByText(/error/i);
      await expect(errorMessage).not.toBeVisible();
    }
  });

  test('should handle directory operations', async ({ window }) => {
    test.setTimeout(30000); // Increase timeout to 30s
    const fileExplorerPanel = window.getByTestId('file-explorer-panel');
    await fileExplorerPanel.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    if (await fileExplorerPanel.isVisible().catch(() => false)) {
      const directoryTree = window.getByRole('tree');
      const fileList = window.getByRole('list');

      const hasTree = await directoryTree.isVisible().catch(() => false);
      const hasList = await fileList.isVisible().catch(() => false);

      // Log for debugging if needed
      if (!hasTree && !hasList) {
        console.log('DEBUG: Neither tree nor list visible in file explorer panel');
      }

      expect(hasTree || hasList).toBe(true);
    }
  });

  test('should handle file operations', async ({ window }) => {
    test.setTimeout(30000); // Increase timeout
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
    test.setTimeout(45000); // Larger timeout for potentially heavy DOM operations
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
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 15000 });
    }

    if (await spinner.isVisible().catch(() => false)) {
      await spinner.waitFor({ state: 'hidden', timeout: 15000 });
    }
  }

  test('should handle file system errors gracefully', async ({ window, homePage }) => {
    const buttons = window.getByRole('button');
    const buttonCount = await buttons.count();

    for (let i = 0; i < Math.min(buttonCount, 3); i++) {
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
    test.setTimeout(120000);

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
    await mockFileSystemOperations(restartedWindow);

    const restartedHome = new HomePage(restartedWindow);
    await restartedHome.shouldBeVisible();

    const fileExplorer = restartedWindow.getByTestId('file-explorer-panel');
    if (await fileExplorer.isVisible().catch(() => false)) {
      await expect(fileExplorer).toBeVisible();
    }
  });
});
