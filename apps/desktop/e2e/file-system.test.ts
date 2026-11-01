import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';

test.describe('File System Integration', () => {
  async function ensureFileExplorerPanelVisible(window: Page): Promise<void> {
    // Use id selector for react-resizable-panels v4 compatibility
    const explorerPanel = getContextExplorerFileExplorerPanel(window);
    const showExplorerPanelButton = window
      .getByTestId('show-explorer-panel')
      .or(window.getByRole('button', { name: /show explorer/iu }));

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
      .getByRole('button', { name: /add folder to workspace|^browse$/iu })
      .first();
    await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
    await selectRootButton.click();
  }

  test('should handle file system access permissions', { tag: '@smoke' }, async ({ window }) => {
    test.setTimeout(30_000); // Increase timeout to 30s for this test
    // The button text comes from FileExplorerStrings.addFolderToWorkspace
    // ('Add Folder to Workspace'); we keep 'browse' for backward compatibility.
    const fileSystemButton = window.getByRole('button', {
      name: /add folder to workspace|^browse$/iu,
    });

    // Wait for the button to be actionable before interacting
    await fileSystemButton.first().waitFor({ state: 'visible', timeout: 10_000 });

    if (await fileSystemButton.isVisible().catch(() => false)) {
      await fileSystemButton.click();
      await expect(window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });

      // In test mode with mocked file system, errors may occur due to mock limitations
      // We only fail on critical/fatal errors, not general error display
      const criticalErrorAlert = window.locator('[role="alert"]').filter({
        hasText: /critical|fatal|crash/iu,
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
    await expect(window.getByRole('button', { name: /view filters/iu })).toBeVisible({
      timeout: 15_000,
    });
    await expect(getContextExplorerFileExplorerPanel(window)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        message: 'Selecting a root folder should not reload the visible renderer',
        timeout: 10_000,
      })
      .toBe(initialTimeOrigin);
  });
});
