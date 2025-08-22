import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  getPanelElements,
  togglePanelVisibility,
  verifyDefaultLayout,
  waitForAppLoad,
} from './utils/layout-helpers';

test.describe('Application Layout', () => {
  test('should render the main layout correctly', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();

    // Verify the page title is for Context Explorer by default and visible
    await expect(home.contextExplorerHeading).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should have working sidebar navigation', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    // Ensure both buttons are present initially
    await expect(home.contextExplorerNavButton).toBeVisible();
    await expect(home.settingsNavButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is not
    await expect(home.contextExplorerHeading).toBeVisible();
    await expect(home.settingsHeading).not.toBeVisible();

    // Ensure Settings button is enabled, then click
    await expect(home.settingsNavButton).toBeEnabled({ timeout: 10000 });
    await home.settingsNavButton.click();

    // Verify the Settings page content is visible and Context Explorer is not
    await expect(home.settingsHeading).toBeVisible();
    await expect(home.contextExplorerHeading).not.toBeVisible();

    // Ensure Context Explorer button is enabled, then click to navigate back
    await expect(home.contextExplorerNavButton).toBeEnabled({ timeout: 10000 });
    await home.contextExplorerNavButton.click();

    // Verify Context Explorer is active again
    await expect(home.contextExplorerHeading).toBeVisible();
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test.describe('Panel Layout Basics', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await waitForAppLoad(page);
      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);
    });

    test('should display default panel layout correctly', async ({ page }) => {
      await verifyDefaultLayout(page);
    });

    test('should allow toggling left panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);

      // Initially visible
      await expect(elements.leftPanel).toBeVisible();

      // Hide panel
      await togglePanelVisibility(elements.hideExplorerButton, elements.leftPanel, false);
      await expect(elements.showExplorerShim).toBeVisible();

      // Show panel again
      await togglePanelVisibility(elements.showExplorerShim, elements.leftPanel, true);
    });

    test('should allow toggling console panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);

      // Initially hidden
      await expect(elements.consolePanel).not.toBeVisible();
      await expect(elements.showConsoleShim).toBeVisible();

      // Show console (now tabbed file editor)
      await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);
      await expect(page.getByText('No files open')).toBeVisible();
      await expect(
        page.getByText('Click on a file in the preview panel to open it here')
      ).toBeVisible();

      // Hide console
      await togglePanelVisibility(elements.hideConsoleButton, elements.consolePanel, false);
    });

    test('should have resizable panels', async ({ page }) => {
      const elements = getPanelElements(page);

      // Verify resize handles are present
      const resizeHandles = page.locator('[data-panel-resize-handle-enabled="true"]');
      await expect(resizeHandles.first()).toBeVisible(); // Left panel resize handle

      // Show console to get more resize handles
      await elements.showConsoleShim.click();
      await expect(elements.consolePanel).toBeVisible();

      // Should have console resize handle too
      await expect(resizeHandles.last()).toBeVisible();
    });

    test('should maintain panel structure integrity', async ({ page }) => {
      const elements = getPanelElements(page);
      await elements.showConsoleShim.click();
      await elements.showRightPanelShim.click(); // Show right panel first since it's hidden by default
      await elements.hideRightPanelButton.click(); // Now we can hide it
      await elements.showRightPanelShim.click(); // And show it again

      // Verify all main layout containers exist
      await expect(page.locator('[data-testid="left-panel"]')).toBeAttached();
      await expect(page.locator('[data-testid="middle-panel"]')).toBeAttached();
      await expect(page.locator('[data-testid="right-panel"]')).toBeAttached();
      await expect(page.locator('[data-testid="main-content-panel"]')).toBeAttached();
      await expect(page.locator('[data-testid="console-panel"]')).toBeAttached();

      // Verify panel group structure using correct data attributes
      // Expecting two panel groups: one horizontal (outer) and one vertical (inner for main/console)
      await expect(page.locator('[data-panel-group]')).toHaveCount(2);
    });
  });
});
