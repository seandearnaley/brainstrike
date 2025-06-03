import { test, expect } from '@playwright/test';
import { 
  getPanelElements, 
  waitForAppLoad, 
  verifyDefaultLayout,
  togglePanelVisibility 
} from './utils/layout-helpers';

test.describe('Application Layout', () => {
  test('should render the main layout correctly', async ({ page }) => {
    await page.goto('/');
    
    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();
    
    // Verify the page title is for Context Explorer by default and visible
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();
  });

  test('should have working sidebar navigation', async ({ page }) => {
    await page.goto('/');
    
    // More specific locators for each button
    const contextExplorerButton = page.locator('aside button[title="Context Explorer"]');
    const settingsButton = page.locator('aside button[title="Settings"]');

    // Ensure both buttons are present initially
    await expect(contextExplorerButton).toBeVisible();
    await expect(settingsButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is not
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();

    // Ensure Settings button is enabled, then click
    await expect(settingsButton).toBeEnabled({ timeout: 10000 }); // Added timeout for stability check
    await settingsButton.click();

    // Verify the Settings page content is visible and Context Explorer is not
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).not.toBeVisible();

    // Ensure Context Explorer button is enabled, then click to navigate back
    await expect(contextExplorerButton).toBeEnabled({ timeout: 10000 }); // Added timeout for stability check
    await contextExplorerButton.click();

    // Verify Context Explorer is active again
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();
  });

  test.describe('Panel Layout Basics', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
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
      await expect(elements.showExplorerButton).toBeVisible();
      
      // Show panel again
      await togglePanelVisibility(elements.showExplorerButton, elements.leftPanel, true);
    });

    test('should allow toggling console panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);
      
      // Initially hidden
      await expect(elements.consolePanel).not.toBeVisible();
      await expect(elements.showConsoleButton).toBeVisible();
      
      // Show console
      await togglePanelVisibility(elements.showConsoleButton, elements.consolePanel, true);
      await expect(page.getByText('Console output will appear here...')).toBeVisible();
      
      // Hide console
      await togglePanelVisibility(elements.hideConsoleButton, elements.consolePanel, false);
    });

    test('should have resizable panels', async ({ page }) => {
      const elements = getPanelElements(page);
      
      // Verify resize handles are present
      const resizeHandles = page.locator('[data-panel-resize-handle-enabled="true"]');
      await expect(resizeHandles.first()).toBeVisible(); // Left panel resize handle
      
      // Show console to get more resize handles
      await elements.showConsoleButton.click();
      await expect(elements.consolePanel).toBeVisible();
      
      // Should have console resize handle too
      await expect(resizeHandles.last()).toBeVisible();
    });

    test('should maintain panel structure integrity', async ({ page }) => {
      // Verify all main layout containers exist
      await expect(page.locator('[id="left-panel"]')).toBeAttached();
      await expect(page.locator('[id="main-panel"]')).toBeAttached();
      await expect(page.locator('[id="main-content-panel"]')).toBeAttached();
      
      // Verify panel group structure using correct data attributes
      // There can be multiple panel groups: horizontal main, vertical main content, and potentially right panel horizontal
      await expect(page.locator('[data-panel-group]')).toHaveCount(3); // Main horizontal, main vertical, and potentially right panel
    });
  });
});
